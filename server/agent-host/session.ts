import { randomUUID } from 'node:crypto'
import { getSessionInfo, getSessionMessages, query, type CanUseTool, type ModelInfo, type PermissionMode, type PermissionResult, type Query, type SDKControlGetContextUsageResponse, type SDKMessage, type SDKUserMessage, type SlashCommand } from '@anthropic-ai/claude-agent-sdk'
import {
  AGENT_HOST_PROTOCOL_VERSION,
  chatImageType,
  isChatEffort,
  isModelValue,
  selectedModelOption,
  type ChatAnswer,
  type ChatCommand,
  type ChatContextUsage,
  type ChatEffort,
  type ChatFileSearchResult,
  type ChatImageRef,
  type ChatItem,
  type ChatModelOption,
  type ChatSessionInfo,
  type ChatSessionStatus,
  type ChatSettingsChange,
} from '../../shared/agent-chat.js'
import { ClaudeItemMapper, attachmentNote, notedAttachmentPaths, questionsFromInput, toolTitle, type ChatImageSink } from './claude-items.js'
import { WorkspaceFileIndex } from './file-index.js'

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
  /** Where uploaded images are read from and tool-result images are kept. */
  images?: SessionImageStore
  /** Problems worth a line in the pane's terminal but not a chat notice. */
  log?: (message: string) => void
}

/** The chat image store as a session uses it (see server/chat-images.ts). */
export interface SessionImageStore extends ChatImageSink {
  read(id: string): Promise<Buffer>
  /** Creates the session's own image folder, the only one Claude's tools are given. */
  sessionDir(sessionId: string): string
  /** Copies a stored image into the session's folder; returns the copy's path. */
  stage(id: string, sessionId: string): Promise<string>
  /** The image and session a staged copy's path names, or null for any other path. */
  stagedImage(path: string): { id: string; sessionId: string } | null
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

/**
 * Built-in commands left out of the `/` menu: TUI-only ones that only print
 * "use the terminal" or "not available" through the SDK, internal ones, and
 * /model and /effort, which Commando's own pickers replace so they stay in sync.
 */
export const HIDDEN_BUILTIN_COMMANDS = new Set([
  'mcp', 'config', 'focus', 'fast', 'color', 'agents', 'heapdump', 'extra-usage',
  '__remote-workflow', 'workflow-launch-exec', 'model', 'effort',
])

/**
 * The `/` menu's list. Skills are the commands Claude also sees in its skill
 * list (from the context breakdown), so it can run them from mid-message;
 * until that list is known, Claude Code's own entries count as commands.
 */
export function toChatCommands(commands: readonly SlashCommand[], skillNames: ReadonlySet<string> | null): ChatCommand[] {
  return commands.flatMap((command) => {
    if (command.builtin && HIDDEN_BUILTIN_COMMANDS.has(command.name)) return []
    const skill = skillNames ? skillNames.has(command.name) : !command.builtin
    const aliases = command.aliases?.filter((alias) => alias !== command.name)
    return [{
      name: command.name,
      description: command.description.slice(0, 500),
      ...(command.argumentHint ? { argumentHint: command.argumentHint.slice(0, 200) } : {}),
      ...(aliases?.length ? { aliases } : {}),
      kind: skill ? 'skill' : 'command',
    }]
  })
}

function shortTitle(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > 60 ? `${line.slice(0, 59)}…` : line
}

export interface AgentSessionEvents {
  items: (items: ChatItem[]) => void
  session: (info: ChatSessionInfo) => void
  /** The `/` menu's list changed. */
  commands: (commands: ChatCommand[]) => void
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
  private readonly listeners: { [K in keyof AgentSessionEvents]: AgentSessionEvents[K][] } = { items: [], session: [], commands: [], closed: [] }
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
  private heldSends: { text: string; images: ChatImageRef[] }[] | null
  /** Sends with images read files first; later sends wait so turns keep their order. */
  private sendChain: Promise<void> = Promise.resolve()
  private queuedSends = 0
  private slashCommands: SlashCommand[] = []
  private skillNames: Set<string> | null = null
  private commandList: ChatCommand[] | null = null
  private files: WorkspaceFileIndex | null = null
  /**
   * Names the session's image folder. A new conversation is given this id up
   * front, so a resume (which keeps the id) finds the folder its notes name.
   */
  private readonly imageSessionId: string

  constructor(
    private readonly spec: AgentSessionSpec,
    private readonly runQuery: typeof query = query,
    now: () => number = Date.now,
    private readonly store: SessionStore = sdkSessionStore,
  ) {
    this.mapper = new ClaudeItemMapper(now, spec.images)
    this.heldSends = spec.resume ? [] : null
    this.imageSessionId = spec.resume ?? randomUUID()
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

  /** The `/` menu's list, once Claude has reported it. */
  get commands(): ChatCommand[] | null {
    return this.commandList
  }

  /** True while a turn runs or waits for an answer. */
  get busy(): boolean {
    return this.info.status === 'running' || this.info.status === 'waiting'
  }

  async start(): Promise<void> {
    let notedSessions: string[] = []
    if (this.spec.resume) {
      // Show the conversation so far before Claude continues it.
      try {
        const history = await this.store.messages(this.spec.resume, this.spec.cwd)
        const items = this.mapper.replay(history)
        if (items.length) this.emitItems(items)
        notedSessions = await this.restageNotedImages(history)
      } catch (error) {
        this.emitItems(this.mapper.notice('error', `Couldn't load earlier turns: ${error instanceof Error ? error.message : String(error)}`))
      }
      void this.refreshTitle()
    }
    const canUseTool: CanUseTool = (toolName, input, options) => this.requestPermission(toolName, input, options)
    const imageDirs = this.openImageDirs(notedSessions)
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
        ...(this.spec.resume ? { resume: this.spec.resume } : this.spec.images ? { sessionId: this.imageSessionId } : {}),
        // Claude's tools can open this chat's attached images without asking, and no other chat's.
        ...(imageDirs.length ? { additionalDirectories: imageDirs } : {}),
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
    void this.loadCommands(this.queryHandle)
    void this.refreshContext()
    const held = this.heldSends ?? []
    this.heldSends = null
    if (this.spec.initialPrompt) this.send(this.spec.initialPrompt)
    for (const send of held) this.send(send.text, send.images)
  }

  /**
   * Sends a message. Typed `/commands` and `@paths` reach Claude Code as text
   * (never `client_composed`), so it expands them as the TUI does. Images go
   * before the text, which also names their saved copies.
   */
  send(text: string, images: ChatImageRef[] = []): void {
    const trimmed = text.trim()
    if (!trimmed && !images.length) return
    if (this.heldSends) {
      this.heldSends.push({ text: trimmed, images })
      return
    }
    if (!images.length && this.queuedSends === 0) {
      this.deliver(trimmed, [])
      return
    }
    this.queuedSends += 1
    this.sendChain = this.sendChain.then(async () => {
      try {
        this.deliver(trimmed, images, await this.attach(images))
      } catch (error) {
        const quoted = trimmed ? ` Your message was: "${trimmed.length > 500 ? `${trimmed.slice(0, 500)}…` : trimmed}"` : ''
        this.emitItems(this.mapper.notice('error', `Couldn't attach the image${images.length > 1 ? 's' : ''}, so the message wasn't sent: ${errorText(error)}.${quoted}`))
      } finally {
        this.queuedSends -= 1
      }
    })
  }

  /** The image blocks for a send, and notes naming each image's copy in the session's folder. */
  private async attach(images: readonly ChatImageRef[]): Promise<{ blocks: unknown[]; notes: string[] }> {
    if (!images.length) return { blocks: [], notes: [] }
    const store = this.spec.images
    if (!store) throw new Error('this host has no image folder')
    const attached = await Promise.all(images.map(async (image) => {
      const [bytes, path] = await Promise.all([
        store.read(image.id),
        // Without a copy Claude still sees the image; it just has no file to open.
        store.stage(image.id, this.imageSessionId).catch((error: unknown) => {
          this.spec.log?.(`Couldn't save a copy of an attached image for Claude: ${errorText(error)}`)
          return null
        }),
      ])
      return {
        block: { type: 'image', source: { type: 'base64', media_type: chatImageType(image.id), data: bytes.toString('base64') } },
        note: path ? attachmentNote(image.name ?? image.id, path) : null,
      }
    }))
    return { blocks: attached.map((image) => image.block), notes: attached.flatMap((image) => image.note ? [image.note] : []) }
  }

  /** The image folders Claude may open: this session's, and any its resumed notes name. */
  private openImageDirs(notedSessions: readonly string[]): string[] {
    const store = this.spec.images
    if (!store) return []
    return [...new Set([this.imageSessionId, ...notedSessions])].flatMap((sessionId) => {
      try {
        return [store.sessionDir(sessionId)]
      } catch (error) {
        this.spec.log?.(`Claude can't open attached images without asking: ${errorText(error)}`)
        return []
      }
    })
  }

  /**
   * Copies a resumed conversation's attached images back to where its notes
   * say they are saved, in case they were pruned there, and returns the
   * sessions whose folders those are. After a /clear the conversation has a
   * new id, so its notes can name the folder of the id it had before. Notes
   * from before session folders name the shared store and are left alone.
   */
  private async restageNotedImages(history: Parameters<ClaudeItemMapper['replay']>[0]): Promise<string[]> {
    const store = this.spec.images
    if (!store) return []
    const noted = new Map(notedAttachmentPaths(history).flatMap((path) => {
      const staged = store.stagedImage(path)
      return staged ? [[path, staged] as const] : []
    }))
    const results = await Promise.allSettled([...noted.values()].map(async ({ id, sessionId }) => {
      await store.stage(id, sessionId)
      return sessionId
    }))
    const failed = results.find((result) => result.status === 'rejected')
    if (failed) this.spec.log?.(`Couldn't restore earlier attached images for Claude: ${errorText(failed.reason)}`)
    return results.flatMap((result) => result.status === 'fulfilled' ? [result.value] : [])
  }

  private deliver(text: string, images: ChatImageRef[], { blocks, notes }: { blocks: unknown[]; notes: string[] } = { blocks: [], notes: [] }): void {
    if (this.info.status === 'closed' || this.info.status === 'error') {
      this.emitItems(this.mapper.notice('error', 'This session has ended. Start commando-agent again in this pane to continue it.'))
      return
    }
    this.emitItems(this.mapper.startTurn(text, images))
    if (!this.info.title && text) this.info = { ...this.info, title: shortTitle(text) }
    // Shown at once; Claude's own session state confirms it (or folds this into the running turn).
    this.setStatus('running')
    const withNotes = [text, ...notes].filter(Boolean).join('\n\n')
    this.input.push({
      type: 'user',
      // Images first: a /command in a text block after them still expands.
      message: { role: 'user', content: blocks.length ? [...blocks, ...(withNotes ? [{ type: 'text', text: withNotes }] : [])] : text },
      parent_tool_use_id: null,
      origin: { kind: 'human' },
    } as SDKUserMessage)
  }

  /** Files and folders for an `@` mention, from the session's folder. */
  async searchFiles(query: string): Promise<ChatFileSearchResult> {
    this.files ??= new WorkspaceFileIndex(this.spec.cwd)
    try {
      return await this.files.search(query)
    } catch (error) {
      return { entries: [], truncated: false, error: `Couldn't list files: ${errorText(error)}` }
    }
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
          // An effort the new model lacks runs as something else (or not at all), so stop claiming it.
          const keepEffort = effort && (!option || option.efforts?.includes(effort))
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
    // A stale picker can offer an effort the current model lacks, which would run as another.
    const running = selectedModelOption(this.info)
    if (change.effort !== undefined && running && !running.efforts?.includes(change.effort)) {
      this.emitItems(this.mapper.notice('error', running.efforts?.length
        ? `${running.displayName} doesn't offer ${change.effort} effort.`
        : `${running.displayName} doesn't take an effort level.`))
    } else if (change.effort !== undefined) {
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

  private async loadCommands(handle: Query): Promise<void> {
    try {
      this.setSlashCommands(await handle.supportedCommands())
    } catch (error) {
      if (this.info.status === 'closed' || this.info.status === 'error') return
      // The menu keeps Commando's own entries; an empty list stops it waiting for Claude's.
      this.emitItems(this.mapper.notice('error', `Couldn't list Claude's commands for the / menu: ${errorText(error)}`))
      this.setSlashCommands([])
    }
  }

  private setSlashCommands(commands: SlashCommand[]): void {
    this.slashCommands = commands
    this.updateCommandList()
  }

  private updateCommandList(): void {
    const next = toChatCommands(this.slashCommands, this.skillNames)
    if (this.commandList && JSON.stringify(next) === JSON.stringify(this.commandList)) return
    this.commandList = next
    for (const listener of this.listeners.commands) listener(next)
  }

  /** Reads how full the context window is, for the composer's meter. */
  private async refreshContext(): Promise<void> {
    const handle = this.queryHandle
    if (!handle) return
    const read = ++this.contextReads
    try {
      const raw = await handle.getContextUsage({ detail: 'summary' })
      const usage = toContextUsage(raw)
      // A slower, older read must not overwrite a newer one.
      if (read !== this.contextReads || !usage) return
      const skills = raw.skills?.skillFrontmatter
      if (skills) {
        const names = new Set(skills.map((skill) => skill.name))
        if (!this.skillNames || names.size !== this.skillNames.size || [...names].some((name) => !this.skillNames!.has(name))) {
          this.skillNames = names
          if (this.slashCommands.length) this.updateCommandList()
        }
      }
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
    if (message.type === 'system' && message.subtype === 'commands_changed') {
      // The SDK pushes the whole list (e.g. a skill was installed); it replaces ours.
      this.setSlashCommands(message.commands)
      return
    }
    if (message.type === 'conversation_reset' && this.info.title) {
      // /clear starts a new conversation, which gets its own title.
      const { title: _previous, ...rest } = this.info
      this.info = rest
      this.emitSession()
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
      const errors = 'errors' in message && Array.isArray(message.errors) ? message.errors.join('\n') : ''
      if (interrupted) {
        this.emitItems(this.mapper.notice('info', 'Interrupted'))
      } else if (message.terminal_reason === 'image_error') {
        this.emitItems(this.mapper.notice('error', `Claude couldn't read an attached image${errors ? `: ${errors}` : ''}. Try a smaller PNG or JPEG.`))
      } else if (message.subtype !== 'success' && errors) {
        this.emitItems(this.mapper.notice('error', errors))
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
