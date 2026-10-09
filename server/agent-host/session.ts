import { query, type CanUseTool, type PermissionMode, type PermissionResult, type Query, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { AGENT_HOST_PROTOCOL_VERSION, type ChatAnswer, type ChatItem, type ChatSessionInfo, type ChatSessionStatus } from '../../shared/agent-chat.js'
import { ClaudeItemMapper, questionsFromInput, toolTitle } from './claude-items.js'

export interface AgentSessionSpec {
  paneId: string
  cwd: string
  /** Claude config dir; picks the login (`~/.claudep`, `~/.claudew`). */
  configDir?: string
  resume?: string
  model?: string
  permissionMode: PermissionMode
  claudePath?: string
  env: Record<string, string | undefined>
}

export interface AgentSessionEvents {
  items: (items: ChatItem[]) => void
  session: (info: ChatSessionInfo) => void
  closed: () => void
}

type PendingRequest = {
  requestKind: 'approval' | 'question'
  input: Record<string, unknown>
  suggestions: unknown[] | undefined
  resolve: (result: PermissionResult) => void
}

/** Push-driven async iterable feeding the SDK's streaming input mode. */
class InputQueue<T> implements AsyncIterable<T> {
  private readonly buffered: T[] = []
  private waiting: ((result: IteratorResult<T>) => void) | null = null
  private ended = false

  push(value: T): void {
    if (this.ended) return
    if (this.waiting) {
      const resolve = this.waiting
      this.waiting = null
      resolve({ value, done: false })
    } else {
      this.buffered.push(value)
    }
  }

  end(): void {
    this.ended = true
    this.waiting?.({ value: undefined as never, done: true })
    this.waiting = null
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const value = this.buffered.shift()
        if (value !== undefined) return Promise.resolve({ value, done: false })
        if (this.ended) return Promise.resolve({ value: undefined as never, done: true })
        return new Promise((resolve) => { this.waiting = resolve })
      },
    }
  }
}

function approvalDetail(toolName: string, input: Record<string, unknown>): string | undefined {
  if (typeof input.command === 'string') return input.command
  if (typeof input.file_path === 'string') return input.file_path
  if (typeof input.url === 'string') return input.url
  try {
    const text = JSON.stringify(input, null, 2)
    return text === '{}' ? undefined : text.slice(0, 4000)
  } catch {
    return toolName
  }
}

/**
 * One agent conversation driven through the Claude Agent SDK. It knows nothing
 * about processes or sockets: a host owns it and forwards its events.
 */
export class AgentSession {
  private readonly mapper: ClaudeItemMapper
  private readonly input = new InputQueue<SDKUserMessage>()
  private readonly pending = new Map<string, PendingRequest>()
  private readonly listeners: Partial<AgentSessionEvents> = {}
  private queryHandle: Query | null = null
  private info: ChatSessionInfo
  private turnsInFlight = 0

  constructor(
    private readonly spec: AgentSessionSpec,
    private readonly runQuery: typeof query = query,
    now: () => number = Date.now,
  ) {
    this.mapper = new ClaudeItemMapper(now)
    this.info = {
      paneId: spec.paneId,
      provider: 'claude',
      cwd: spec.cwd,
      status: 'starting',
      hostPid: process.pid,
      hostVersion: AGENT_HOST_PROTOCOL_VERSION,
      permissionMode: spec.permissionMode,
      ...(spec.resume ? { sessionId: spec.resume } : {}),
      ...(spec.model ? { model: spec.model } : {}),
      ...(spec.configDir ? { configDir: spec.configDir } : {}),
    }
  }

  on<K extends keyof AgentSessionEvents>(event: K, listener: AgentSessionEvents[K]): void {
    this.listeners[event] = listener
  }

  get paneId(): string {
    return this.spec.paneId
  }

  snapshot(): { session: ChatSessionInfo; items: ChatItem[] } {
    return { session: { ...this.info }, items: this.mapper.list() }
  }

  start(): void {
    const canUseTool: CanUseTool = (toolName, input, options) => this.requestPermission(toolName, input, options)
    this.queryHandle = this.runQuery({
      prompt: this.input,
      options: {
        cwd: this.spec.cwd,
        env: {
          ...this.spec.env,
          ...(this.spec.configDir ? { CLAUDE_CONFIG_DIR: this.spec.configDir } : {}),
        },
        ...(this.spec.claudePath ? { pathToClaudeCodeExecutable: this.spec.claudePath } : {}),
        ...(this.spec.resume ? { resume: this.spec.resume } : {}),
        ...(this.spec.model ? { model: this.spec.model } : {}),
        permissionMode: this.spec.permissionMode,
        ...(this.spec.permissionMode === 'bypassPermissions' ? { allowDangerouslySkipPermissions: true } : {}),
        // Load the same settings, skills, CLAUDE.md and hooks the TUI would.
        settingSources: ['user', 'project', 'local'],
        systemPrompt: { type: 'preset', preset: 'claude_code' },
        includePartialMessages: true,
        canUseTool,
      },
    })
    this.setStatus('idle')
    void this.consume(this.queryHandle)
  }

  send(text: string): void {
    const trimmed = text.trim()
    if (!trimmed) return
    this.emitItems(this.mapper.startTurn(trimmed))
    this.turnsInFlight += 1
    this.setStatus('running')
    this.input.push({
      type: 'user',
      message: { role: 'user', content: trimmed },
      parent_tool_use_id: null,
      origin: { kind: 'human' },
    } as SDKUserMessage)
  }

  async interrupt(): Promise<void> {
    for (const [requestId, request] of this.pending) {
      request.resolve({ behavior: 'deny', message: 'The user interrupted.', interrupt: true })
      this.emitItems(this.mapper.resolveRequest(requestId, { kind: 'cancelled', reason: 'Interrupted' }))
    }
    this.pending.clear()
    try {
      await this.queryHandle?.interrupt()
    } catch (error) {
      this.emitItems(this.mapper.notice('error', `Interrupt failed: ${error instanceof Error ? error.message : String(error)}`))
    }
  }

  answer(requestId: string, answer: ChatAnswer): boolean {
    const request = this.pending.get(requestId)
    if (!request || request.requestKind !== (answer.kind === 'approval' ? 'approval' : 'question')) return false
    this.pending.delete(requestId)
    if (answer.kind === 'question') {
      request.resolve({ behavior: 'allow', updatedInput: { questions: request.input.questions, answers: answer.answers } })
    } else if (answer.decision === 'deny') {
      request.resolve({ behavior: 'deny', message: answer.message || 'The user denied this action.' })
    } else {
      request.resolve({
        behavior: 'allow',
        updatedInput: request.input,
        ...(answer.decision === 'allow_always' && request.suggestions ? { updatedPermissions: request.suggestions as never } : {}),
      })
    }
    this.emitItems(this.mapper.resolveRequest(requestId, answer))
    if (this.pending.size === 0 && this.info.status === 'waiting') this.setStatus('running')
    return true
  }

  close(): void {
    this.input.end()
    this.queryHandle?.close()
  }

  private requestPermission(
    toolName: string,
    input: Record<string, unknown>,
    options: Parameters<CanUseTool>[2],
  ): Promise<PermissionResult> {
    const requestId = options.requestId || options.toolUseID
    const requestKind = toolName === 'AskUserQuestion' ? 'question' : 'approval'
    const title = requestKind === 'question'
      ? 'Claude is asking'
      : options.title ?? `Allow ${options.displayName ?? toolTitle(toolName, input)}?`
    const detail = requestKind === 'approval' ? approvalDetail(toolName, input) : undefined
    return new Promise<PermissionResult>((resolve) => {
      this.pending.set(requestId, { requestKind, input, suggestions: options.suggestions, resolve })
      this.emitItems(this.mapper.request(requestId, {
        requestKind,
        toolName,
        title,
        ...(detail ? { detail } : {}),
        ...(requestKind === 'question' ? { questions: questionsFromInput(input) } : {}),
      }))
      this.setStatus('waiting')
      options.signal.addEventListener('abort', () => {
        if (!this.pending.delete(requestId)) return
        resolve({ behavior: 'deny', message: 'Cancelled.' })
        this.emitItems(this.mapper.resolveRequest(requestId, { kind: 'cancelled', reason: 'Cancelled by Claude' }))
      }, { once: true })
    })
  }

  private async consume(handle: Query): Promise<void> {
    try {
      for await (const message of handle) this.handleMessage(message)
      this.emitItems(this.mapper.settleRunning('interrupted'))
      this.setStatus('closed')
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error)
      this.emitItems([...this.mapper.settleRunning('failed'), ...this.mapper.notice('error', text)])
      this.info = { ...this.info, error: text }
      this.setStatus('error')
    } finally {
      this.listeners.closed?.()
    }
  }

  private handleMessage(message: SDKMessage): void {
    if ('session_id' in message && typeof message.session_id === 'string' && message.session_id && message.session_id !== this.info.sessionId) {
      this.info = { ...this.info, sessionId: message.session_id }
      this.emitSession()
    }
    if (message.type === 'system' && message.subtype === 'init') {
      this.info = { ...this.info, model: message.model, permissionMode: message.permissionMode }
      this.emitSession()
    }
    this.emitItems(this.mapper.handle(message))
    if (message.type === 'result') {
      this.turnsInFlight = Math.max(0, this.turnsInFlight - 1)
      if (message.subtype !== 'success' && 'errors' in message && Array.isArray(message.errors) && message.errors.length) {
        this.emitItems(this.mapper.notice('error', message.errors.join('\n')))
      }
      this.setStatus(this.turnsInFlight > 0 ? 'running' : 'idle')
    }
  }

  private setStatus(status: ChatSessionStatus): void {
    if (this.info.status === status) return
    this.info = { ...this.info, status }
    this.emitSession()
  }

  private emitSession(): void {
    this.listeners.session?.({ ...this.info })
  }

  private emitItems(items: ChatItem[]): void {
    if (items.length) this.listeners.items?.(items)
  }
}
