import { getSessionInfo, getSessionMessages, query, type CanUseTool, type ModelInfo, type PermissionMode, type PermissionResult, type Query, type SDKControlGetContextUsageResponse, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import {
  AGENT_HOST_PROTOCOL_VERSION,
  isChatEffort,
  isModelValue,
  type ChatAnswer,
  type ChatContextUsage,
  type ChatEffort,
  type ChatItem,
  type ChatModelOption,
  type ChatSessionInfo,
  type ChatSessionStatus,
  type ChatSettingsChange,
} from '../../shared/agent-chat.js'
import { ClaudeItemMapper, questionsFromInput, toolTitle } from './claude-items.js'

export interface AgentSessionSpec {
  paneId: string
  cwd: string
  /** Claude config dir; picks the login (`~/.claudep`, `~/.claudew`). */
  configDir?: string
  resume?: string
  model?: string
  effort?: ChatEffort
  permissionMode: PermissionMode
  /** Lets the session switch to bypassPermissions later (the SDK needs this at launch). */
  bypassAllowed?: boolean
  claudePath?: string
  env: Record<string, string | undefined>
  /** Sent as the first turn once the session starts. */
  initialPrompt?: string
  /** Resumes this conversation as a chat pane, without the session id (hooks append it). */
  resumeCommand?: string
  hostBuild?: string
  /** Problems worth a line in the pane's terminal but not a chat notice. */
  log?: (message: string) => void
}

/** Reads saved transcripts and titles; swapped out in tests. */
export interface SessionStore {
  messages: (sessionId: string, cwd: string) => Promise<readonly { type: string; message: unknown; parent_tool_use_id: string | null }[]>
  title: (sessionId: string, cwd: string) => Promise<string | undefined>
}

/** Enough recent messages to fill the item window; older turns stay in the transcript. */
const HISTORY_MESSAGES = 1500

const sdkSessionStore: SessionStore = {
  // `limit` counts from the start, so read everything and keep the newest part.
  messages: async (sessionId, cwd) => (await getSessionMessages(sessionId, { dir: cwd })).slice(-HISTORY_MESSAGES),
  title: async (sessionId, cwd) => {
    const info = await getSessionInfo(sessionId, { dir: cwd })
    return info?.customTitle || info?.summary || info?.firstPrompt
  },
}

/** The picker's value for "no explicit model": Claude Code's own default. */
const DEFAULT_MODEL = 'default'

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function toModelOption(model: ModelInfo): ChatModelOption[] {
  if (!isModelValue(model.value)) return []
  const efforts = model.supportedEffortLevels?.filter(isChatEffort)
  return [{
    value: model.value,
    displayName: model.displayName,
    ...(model.description ? { description: model.description } : {}),
    ...(isModelValue(model.resolvedModel) ? { resolvedModel: model.resolvedModel } : {}),
    ...(model.supportsEffort && efforts?.length ? { efforts } : {}),
    ...(model.supportsAutoMode ? { supportsAutoMode: true } : {}),
  }]
}

export function toContextUsage(usage: SDKControlGetContextUsageResponse): ChatContextUsage | undefined {
  if (!(usage.maxTokens > 0)) return undefined
  return {
    usedTokens: usage.totalTokens,
    maxTokens: usage.maxTokens,
    ...(usage.autoCompactThreshold ? { autoCompactThreshold: usage.autoCompactThreshold } : {}),
    autoCompact: usage.isAutoCompactEnabled,
    // Free space, the compaction reserve and deferred tool schemas are not in the window.
    categories: usage.categories
      .filter((category) => category.kind === 'used' && category.tokens > 0)
      .sort((a, b) => b.tokens - a.tokens)
      .map(({ name, tokens }) => ({ name, tokens })),
  }
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
  /** Set once Claude reports session_state_changed; it then decides idle and running. */
  private stateEvents = false
  private contextReads = 0
  /** Set by interrupt(); the turn's error result then reads as interrupted. */
  private interruptRequested = false
  /**
   * Sends that arrive while a resumed transcript is still replaying wait here,
   * so they land after the earlier turns instead of inside them.
   */
  private heldSends: string[] | null

  constructor(
    private readonly spec: AgentSessionSpec,
    private readonly runQuery: typeof query = query,
    now: () => number = Date.now,
    private readonly store: SessionStore = sdkSessionStore,
  ) {
    this.mapper = new ClaudeItemMapper(now)
    this.heldSends = spec.resume ? [] : null
    this.info = {
      paneId: spec.paneId,
      provider: 'claude',
      cwd: spec.cwd,
      status: 'starting',
      hostPid: process.pid,
      hostVersion: AGENT_HOST_PROTOCOL_VERSION,
      permissionMode: spec.permissionMode,
      ...(spec.resume ? { sessionId: spec.resume } : {}),
      ...(spec.model ? { model: spec.model, selectedModel: spec.model } : {}),
      ...(spec.effort ? { effort: spec.effort } : {}),
      ...(spec.bypassAllowed || spec.permissionMode === 'bypassPermissions' ? { bypassAllowed: true } : {}),
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
    return this.info.status === 'running' || this.info.status === 'waiting'
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
          // Idle and running come from Claude itself, so queued or folded-in sends never leave the chat stuck.
          CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: '1',
        },
        ...(this.spec.claudePath ? { pathToClaudeCodeExecutable: this.spec.claudePath } : {}),
        ...(this.spec.resume ? { resume: this.spec.resume } : {}),
        ...(this.spec.model ? { model: this.spec.model } : {}),
        ...(this.spec.effort ? { effort: this.spec.effort } : {}),
        // Summaries make the reasoning rows readable; Claude omits thinking text otherwise.
        thinking: { type: 'adaptive', display: 'summarized' },
        permissionMode: this.spec.permissionMode,
        ...(this.info.bypassAllowed ? { allowDangerouslySkipPermissions: true } : {}),
        // Load the same settings, skills, CLAUDE.md and hooks the TUI would.
        settingSources: ['user', 'project', 'local'],
        systemPrompt: { type: 'preset', preset: 'claude_code' },
        includePartialMessages: true,
        canUseTool,
      },
    })
    this.setStatus('idle')
    void this.consume(this.queryHandle)
    void this.loadModels(this.queryHandle)
    void this.refreshContext()
    const held = this.heldSends ?? []
    this.heldSends = null
    if (this.spec.initialPrompt) this.send(this.spec.initialPrompt)
    for (const text of held) this.send(text)
  }

  send(text: string): void {
    const trimmed = text.trim()
    if (!trimmed) return
    if (this.heldSends) {
      this.heldSends.push(trimmed)
      return
    }
    if (this.info.status === 'closed' || this.info.status === 'error') {
      this.emitItems(this.mapper.notice('error', 'This session has ended. Start commando-agent again in this pane to continue it.'))
      return
    }
    this.emitItems(this.mapper.startTurn(trimmed))
    if (!this.info.title) this.info = { ...this.info, title: shortTitle(trimmed) }
    // Shown at once; Claude's own session state confirms it (or folds this into the running turn).
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

  /** Switches model, effort or permission mode for the rest of the session. */
  async configure(change: ChatSettingsChange): Promise<void> {
    const handle = this.queryHandle
    if (!handle || this.info.status === 'closed' || this.info.status === 'error') {
      this.emitItems(this.mapper.notice('error', "This session isn't running, so its settings can't change."))
      return
    }
    if (change.model !== undefined) {
      const option = this.info.models?.find((model) => model.value === change.model)
      if (this.info.models && !option) {
        this.emitItems(this.mapper.notice('error', `Claude doesn't offer the model ${change.model} here.`))
      } else {
        try {
          // "default" means no explicit model, so a resume follows Claude Code's default too.
          const explicit = change.model === DEFAULT_MODEL ? undefined : change.model
          await handle.setModel(explicit)
          const { selectedModel: _previous, effort, ...rest } = this.info
          // An effort the new model lacks runs as something else, so stop claiming it.
          const keepEffort = effort && (!option?.efforts || option.efforts.includes(effort))
          this.info = {
            ...rest,
            model: option?.resolvedModel ?? change.model,
            ...(explicit ? { selectedModel: explicit } : {}),
            ...(keepEffort ? { effort } : {}),
          }
        } catch (error) {
          this.emitItems(this.mapper.notice('error', `Couldn't switch the model: ${errorText(error)}`))
        }
      }
    }
    if (change.effort !== undefined) {
      try {
        await handle.applyFlagSettings({ effortLevel: change.effort })
        this.info = { ...this.info, effort: change.effort }
      } catch (error) {
        this.emitItems(this.mapper.notice('error', `Couldn't change the effort: ${errorText(error)}`))
      }
    }
    if (change.permissionMode !== undefined) {
      if (change.permissionMode === 'bypassPermissions' && !this.info.bypassAllowed) {
        this.emitItems(this.mapper.notice('error', 'Bypass permissions is only available in a chat started with it.'))
      } else {
        try {
          await handle.setPermissionMode(change.permissionMode)
          this.info = { ...this.info, permissionMode: change.permissionMode }
        } catch (error) {
          this.emitItems(this.mapper.notice('error', `Couldn't change the permission mode: ${errorText(error)}`))
        }
      }
    }
    this.emitSession()
  }

  /** Points the session's resume command at its current settings. */
  setResumeCommand(command: string): void {
    if (command === this.info.resumeCommand) return
    this.info = { ...this.info, resumeCommand: command }
    this.emitSession()
  }

  close(): void {
    this.input.end()
    this.queryHandle?.close()
  }

  private async loadModels(handle: Query): Promise<void> {
    try {
      const models = (await handle.supportedModels()).flatMap(toModelOption)
      this.info = { ...this.info, models }
      this.emitSession()
    } catch (error) {
      // The pickers stay read-only without a list.
      this.spec.log?.(`Couldn't list Claude's models: ${errorText(error)}`)
    }
  }

  /** Reads how full the context window is, for the composer's meter. */
  private async refreshContext(): Promise<void> {
    const handle = this.queryHandle
    if (!handle) return
    const read = ++this.contextReads
    try {
      const usage = toContextUsage(await handle.getContextUsage({ detail: 'summary' }))
      // A slower, older read must not overwrite a newer one.
      if (read !== this.contextReads || !usage) return
      this.info = { ...this.info, contextUsage: usage }
      this.emitSession()
    } catch (error) {
      if (this.info.status !== 'closed' && this.info.status !== 'error') this.spec.log?.(`Couldn't read context usage: ${errorText(error)}`)
    }
  }

  /** After a turn: the meter changed, and a model list that failed to load gets another try. */
  private refreshBetweenTurns(): void {
    void this.refreshContext()
    if (!this.info.models && this.queryHandle) void this.loadModels(this.queryHandle)
  }

  private applySessionState(state: 'idle' | 'running' | 'requires_action'): void {
    if (this.info.status === 'closed' || this.info.status === 'error') return
    if (state === 'idle') {
      this.setStatus('idle')
      this.refreshBetweenTurns()
    } else {
      this.setStatus(state === 'requires_action' || this.pending.size ? 'waiting' : 'running')
    }
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
    if (message.type === 'system' && message.subtype === 'session_state_changed') {
      this.stateEvents = true
      this.applySessionState(message.state)
      return
    }
    if (message.type === 'system' && (message.subtype === 'init' || message.subtype === 'status')) {
      // Claude re-sends init each turn, and status when the mode changes (e.g. entering plan mode itself).
      const model = message.subtype === 'init' ? message.model : this.info.model
      const permissionMode = message.permissionMode ?? this.info.permissionMode
      if (model !== this.info.model || permissionMode !== this.info.permissionMode) {
        this.info = { ...this.info, ...(model ? { model } : {}), ...(permissionMode ? { permissionMode } : {}) }
        this.emitSession()
      }
    }
    if (message.type === 'result') {
      const interrupted = this.interruptRequested
      this.interruptRequested = false
      this.emitItems(this.mapper.settleRunning(message.subtype === 'success' ? 'completed' : interrupted ? 'interrupted' : 'failed'))
      if (interrupted) {
        this.emitItems(this.mapper.notice('info', 'Interrupted'))
      } else if (message.subtype !== 'success' && 'errors' in message && Array.isArray(message.errors) && message.errors.length) {
        this.emitItems(this.mapper.notice('error', message.errors.join('\n')))
      }
      // Claude reports idle itself once queued work is done; older CLIs only send results.
      if (!this.stateEvents) {
        this.setStatus('idle')
        this.refreshBetweenTurns()
      }
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
