import { getSessionInfo, getSessionMessages, query, type CanUseTool, type PermissionMode, type PermissionResult, type Query, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
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
  /** Sent as the first turn once the session starts. */
  initialPrompt?: string
  /** Resumes this conversation as a chat pane, without the session id (hooks append it). */
  resumeCommand?: string
  hostBuild?: string
}

/** Reads saved transcripts and titles; swapped out in tests. */
export interface SessionStore {
  messages: (sessionId: string, cwd: string) => Promise<readonly { type: string; message: unknown; parent_tool_use_id: string | null }[]>
  title: (sessionId: string, cwd: string) => Promise<string | undefined>
}

const sdkSessionStore: SessionStore = {
  messages: (sessionId, cwd) => getSessionMessages(sessionId, { dir: cwd, limit: 400 }),
  title: async (sessionId, cwd) => {
    const info = await getSessionInfo(sessionId, { dir: cwd })
    return info?.customTitle || info?.summary || info?.firstPrompt
  },
}

function shortTitle(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > 60 ? `${line.slice(0, 59)}…` : line
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
  private readonly listeners: { [K in keyof AgentSessionEvents]: AgentSessionEvents[K][] } = { items: [], session: [], closed: [] }
  private queryHandle: Query | null = null
  private info: ChatSessionInfo
  private turnsInFlight = 0
  /** Set by interrupt(); the turn's error result then reads as interrupted. */
  private interruptRequested = false

  constructor(
    private readonly spec: AgentSessionSpec,
    private readonly runQuery: typeof query = query,
    now: () => number = Date.now,
    private readonly store: SessionStore = sdkSessionStore,
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
      ...(spec.hostBuild ? { hostBuild: spec.hostBuild } : {}),
      ...(spec.resumeCommand ? { resumeCommand: spec.resumeCommand } : {}),
    }
  }

  on<K extends keyof AgentSessionEvents>(event: K, listener: AgentSessionEvents[K]): void {
    this.listeners[event].push(listener)
  }

  get paneId(): string {
    return this.spec.paneId
  }

  snapshot(): { session: ChatSessionInfo; items: ChatItem[] } {
    return { session: { ...this.info }, items: this.mapper.list() }
  }

  /** True while a turn runs or waits for an answer. */
  get busy(): boolean {
    return this.info.status === 'running' || this.info.status === 'waiting' || this.turnsInFlight > 0
  }

  async start(): Promise<void> {
    if (this.spec.resume) {
      // Show the conversation so far before Claude continues it.
      try {
        const history = await this.store.messages(this.spec.resume, this.spec.cwd)
        const items = this.mapper.replay(history)
        if (items.length) this.emitItems(items)
      } catch (error) {
        this.emitItems(this.mapper.notice('error', `Couldn't load earlier turns: ${error instanceof Error ? error.message : String(error)}`))
      }
      void this.refreshTitle()
    }
    const canUseTool: CanUseTool = (toolName, input, options) => this.requestPermission(toolName, input, options)
    this.queryHandle = this.runQuery({
      prompt: this.input,
      options: {
        cwd: this.spec.cwd,
        env: {
          ...this.spec.env,
          ...(this.spec.configDir ? { CLAUDE_CONFIG_DIR: this.spec.configDir } : {}),
          // Commando's SessionStart hook pins this as the pane's resume command.
          ...(this.spec.resumeCommand ? { COMMANDO_CHAT_RESUME: this.spec.resumeCommand } : {}),
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
    if (this.spec.initialPrompt) this.send(this.spec.initialPrompt)
  }

  send(text: string): void {
    const trimmed = text.trim()
    if (!trimmed) return
    if (this.info.status === 'closed' || this.info.status === 'error') {
      this.emitItems(this.mapper.notice('error', 'This session has ended. Start commando-agent again in this pane to continue it.'))
      return
    }
    this.emitItems(this.mapper.startTurn(trimmed))
    if (!this.info.title) this.info = { ...this.info, title: shortTitle(trimmed) }
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
    if (this.info.status === 'running' || this.info.status === 'waiting') this.interruptRequested = true
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
    if (options.signal.aborted) return Promise.resolve({ behavior: 'deny', message: 'Cancelled.' })
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
      for (const listener of this.listeners.closed) listener()
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
    if (message.type === 'result') {
      const interrupted = this.interruptRequested
      this.interruptRequested = false
      this.turnsInFlight = Math.max(0, this.turnsInFlight - 1)
      this.emitItems(this.mapper.settleRunning(message.subtype === 'success' ? 'completed' : interrupted ? 'interrupted' : 'failed'))
      if (interrupted) {
        this.emitItems(this.mapper.notice('info', 'Interrupted'))
      } else if (message.subtype !== 'success' && 'errors' in message && Array.isArray(message.errors) && message.errors.length) {
        this.emitItems(this.mapper.notice('error', message.errors.join('\n')))
      }
      this.setStatus(this.turnsInFlight > 0 ? 'running' : 'idle')
      void this.refreshTitle()
      return
    }
    this.emitItems(this.mapper.handle(message))
  }

  /** Claude names conversations after a turn or two; pick that up for the pane title. */
  private async refreshTitle(): Promise<void> {
    const sessionId = this.info.sessionId
    if (!sessionId) return
    try {
      const title = await this.store.title(sessionId, this.spec.cwd)
      if (title && shortTitle(title) !== this.info.title) {
        this.info = { ...this.info, title: shortTitle(title) }
        this.emitSession()
      }
    } catch {
      // Titles are cosmetic; keep the current one.
    }
  }

  private setStatus(status: ChatSessionStatus): void {
    if (this.info.status === status) return
    this.info = { ...this.info, status }
    this.emitSession()
  }

  private emitSession(): void {
    for (const listener of this.listeners.session) listener({ ...this.info })
  }

  private emitItems(items: ChatItem[]): void {
    if (!items.length) return
    for (const listener of this.listeners.items) listener(items)
  }
}
