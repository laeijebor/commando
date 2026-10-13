import { randomUUID } from 'node:crypto'
import { getSessionInfo, getSessionMessages, getSubagentMessages, query, type CanUseTool, type ModelInfo, type PermissionMode, type PermissionResult, type Query, type SDKControlGetContextUsageResponse, type SDKMessage, type SDKUserMessage, type SlashCommand } from '@anthropic-ai/claude-agent-sdk'
import {
  AGENT_HOST_PROTOCOL_VERSION,
  MAX_CHAT_IMAGES,
  MAX_QUEUED_MESSAGES,
  attachmentNote,
  chatImageType,
  isChatEffort,
  isChatPermissionMode,
  isModelValue,
  selectedModelOption,
  stripAttachmentNotesFromSummary,
  RETURNED_FROM_CLAUDE_CODE,
  type ChatAnswer,
  type ChatCommand,
  type ChatContextUsage,
  type ChatEffort,
  type ChatFileSearchResult,
  type ChatImageRef,
  type ChatItem,
  type ChatModelOption,
  type ChatQueueAction,
  type ChatQueuedMessage,
  type ChatSendOptions,
  type ChatSessionInfo,
  type ChatSessionPermissionMode,
  type ChatSessionStatus,
  type ChatSettingsChange,
  type ChatSubagentTranscript,
  type ChatSwitchAction,
  type ChatTaskAction,
} from '../../shared/agent-chat.js'
import { ClaudeItemMapper, notedAttachmentPaths, planFromInput, questionsFromInput, relayPrompt, toolTitle, type ChatImageSink } from './claude-items.js'
import { WorkspaceFileIndex } from './file-index.js'
import { shellQuote } from '../agent-resume-command.js'
import type { ChatProviderSession, ChatProviderSessionEvents, ChatProviderTui } from './provider.js'
import { NO_PLAN_LIMITS, applyRateLimitEvent, toPlanUsage } from './plan-usage.js'

export interface AgentSessionSpec {
  paneId: string
  cwd: string
  /** Claude config dir; picks the login (`~/.claudep`, `~/.claudew`). */
  configDir?: string
  resume?: string
  model?: string
  effort?: ChatEffort
  permissionMode: PermissionMode
  /** In plan mode, the mode it had before (carried across a restart or resume). */
  prePlanPermissionMode?: ChatSessionPermissionMode
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
  /** More folders Claude may read without asking: the stashed plan this pane was started with, if any. */
  readableDirectories?: string[]
  /** Problems worth a line in the pane's terminal but not a chat notice. */
  log?: (message: string) => void
  /** Claude Code just exited and handed the conversation back; the chat says so. */
  returnedFromClaudeCode?: boolean
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

type ClaudeCodeSettings = Pick<AgentSessionSpec, 'model' | 'effort' | 'permissionMode' | 'bypassAllowed'> & { readableDir?: string }

/**
 * Claude Code's own flags for this chat's settings, so the TUI runs the
 * conversation with the same model, effort and permission mode.
 */
export function claudeCodeFlags(args: ClaudeCodeSettings): string[] {
  return [
    ...(args.model ? ['--model', args.model] : []),
    ...(args.effort ? ['--effort', args.effort] : []),
    ...(args.permissionMode === 'bypassPermissions'
      ? ['--dangerously-skip-permissions']
      : ['--permission-mode', args.permissionMode, ...(args.bypassAllowed ? ['--allow-dangerously-skip-permissions'] : [])]),
    ...(args.readableDir ? ['--add-dir', args.readableDir] : []),
  ]
}

/**
 * The pane command for a switch to Claude Code: the TUI on the same
 * conversation, then (when it exits, however it exits) this chat again.
 * bash runs it with job control, so Claude Code is the pane's foreground
 * process: tmux names the pane after it (auto-resume needs that to see an
 * agent, not a shell), and Ctrl-C reaches only Claude Code.
 */
export function claudeCodeSwitchCommand(args: ClaudeCodeSettings, claudePath: string, launcher: string, sessionId: string, returnFlags: readonly string[]): string {
  const tui = [claudePath, ...claudeCodeFlags(args), '--resume', sessionId].map(shellQuote).join(' ')
  const back = ['exec', ...[launcher, 'claude', ...returnFlags, '--resume', sessionId, '--from-claude-code'].map(shellQuote)].join(' ')
  return `exec /bin/bash -c ${shellQuote(`set -m; ${tui}; ${back}`)}`
}

type TranscriptMessage = { type: string; message: unknown; parent_tool_use_id: string | null }

/** Reads saved transcripts and titles; swapped out in tests. */
export interface SessionStore {
  messages: (sessionId: string, cwd: string) => Promise<readonly TranscriptMessage[]>
  title: (sessionId: string, cwd: string) => Promise<string | undefined>
  /** One subagent's own transcript (it is saved apart from the conversation's). */
  subagentMessages?: (sessionId: string, agentId: string, cwd: string) => Promise<readonly TranscriptMessage[]>
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
  subagentMessages: async (sessionId, agentId, cwd) => (await getSubagentMessages(sessionId, agentId, { dir: cwd })).slice(-HISTORY_MESSAGES),
}

/**
 * What Claude is told when the chat captures its plan instead of approving
 * ExitPlanMode (t3code's wording): the plan shows as a card, and the user
 * implements or refines it in a later turn.
 */
export const PLAN_CAPTURED_MESSAGE = "The client captured your proposed plan. Stop here and wait for the user's feedback or implementation request in a later turn."

/** Turn results that only mean the turn was cut short (a steer or Stop), not that it failed. */
const ABORTED_REASONS = new Set(['aborted_streaming', 'aborted_tools'])
/** Experimental in the SDK: a rename shows up as a type error here when the SDK is upgraded. */
const PLAN_USAGE_METHOD = 'usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET' satisfies keyof Query
const PLAN_USAGE_TURN_REFRESH_MS = 60_000
const PLAN_USAGE_IDLE_REFRESH_MS = 5 * 60_000

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

/** A message as notices quote it back. */
function quote(text: string): string {
  return text.length > 2000 ? `${text.slice(0, 2000)}…` : text
}

function shortTitle(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > 60 ? `${line.slice(0, 59)}…` : line
}

export interface AgentSessionEvents extends ChatProviderSessionEvents {
  /** A switch to Claude Code may go now: the turn is over and nothing waits on Claude. */
  switchReady: () => void
}

type HeldSend = { text: string; images: ChatImageRef[]; options: ChatSendOptions }

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
export class AgentSession implements ChatProviderSession {
  readonly tui: ChatProviderTui = {
    label: 'Claude Code',
    env: {},
    onReady: (listener) => this.on('switchReady', listener),
    requestSwitch: (action) => this.requestSwitch(action),
    command: (launcher, returnFlags, sessionId) => this.tuiCommand(launcher, returnFlags, sessionId),
    handOver: () => this.handOver(),
    endSwitch: (notice) => this.endSwitch(notice),
  }
  private readonly mapper: ClaudeItemMapper
  private readonly input = new InputQueue<SDKUserMessage>()
  private readonly pending = new Map<string, PendingRequest>()
  private readonly listeners: { [K in keyof AgentSessionEvents]: AgentSessionEvents[K][] } = { items: [], session: [], commands: [], closed: [], switchReady: [] }
  private queryHandle: Query | null = null
  private info: ChatSessionInfo
  /** Set once Claude reports session_state_changed; it then decides idle and running. */
  private stateEvents = false
  private contextReads = 0
  private planUsageReads = 0
  /** When the plan limits were last asked for; turns closer together than a minute reuse the reading. */
  private planUsageAskedAt = 0
  /** Set when the account has no plan limits (API key, Bedrock) or the SDK lost the method. */
  private planUsageOff = false
  private planUsageTimer: NodeJS.Timeout | undefined
  /** Set by interrupt(); the turn's error result then reads as interrupted. */
  private interruptRequested = false
  /**
   * Sends that arrive while a resumed transcript is still replaying wait here,
   * so they land after the earlier turns instead of inside them.
   */
  private heldSends: HeldSend[] | null
  /** Messages the user queued (Enter) while a turn ran; sent together when it ends. */
  private queue: ChatQueuedMessage[] = []
  private queueCounter = 0
  /** True from a send until its turn's result: queued messages wait while it is. */
  private turnOpen = false
  /** Steers sent while a turn ran; each cut-short result they cause is not the end. */
  private steersPending = 0
  /**
   * Something was sent that Claude hasn't yet shown it took up (no result or
   * running since). An idle then is stale: the one for the previous turn (or
   * from start-up), arriving after the send. It must not end the new turn.
   */
  private unseenDelivery = false
  /** Sends with images read files first; later sends wait so turns keep their order. */
  private sendChain: Promise<void> = Promise.resolve()
  private queuedSends = 0
  private slashCommands: SlashCommand[] = []
  private skillNames: Set<string> | null = null
  private commandList: ChatCommand[] | null = null
  private files: WorkspaceFileIndex | null = null
  /** The queue went to the daemon with a switch to Claude Code. */
  private handedOver = false
  /**
   * Names the session's image folder. A new conversation is given this id up
   * front, so a resume (which keeps the id) finds the folder its notes name.
   */
  private readonly imageSessionId: string

  constructor(
    private readonly spec: AgentSessionSpec,
    private readonly runQuery: typeof query = query,
    private readonly now: () => number = Date.now,
    private readonly store: SessionStore = sdkSessionStore,
  ) {
    if (spec.configDir) this.tui.env.CLAUDE_CONFIG_DIR = spec.configDir
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
      ...(spec.permissionMode === 'plan' && spec.prePlanPermissionMode ? { prePlanPermissionMode: spec.prePlanPermissionMode } : {}),
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

  /** True while a turn runs or waits for an answer, or sends are still on their way. */
  get busy(): boolean {
    return this.info.status === 'running' || this.info.status === 'waiting' || this.turnOpen || this.queue.length > 0 || this.queuedSends > 0
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
    if (this.spec.returnedFromClaudeCode) this.emitItems(this.mapper.notice('info', RETURNED_FROM_CLAUDE_CODE))
    const canUseTool: CanUseTool = (toolName, input, options) => this.requestPermission(toolName, input, options)
    const readableDirs = [...this.openImageDirs(notedSessions), ...(this.spec.readableDirectories ?? [])]
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
        // Claude's tools can open this chat's attached images (and the plan it was started with)
        // without asking, and no other chat's.
        ...(readableDirs.length ? { additionalDirectories: readableDirs } : {}),
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
        // Subagents' own text and thinking, so a subagent's transcript can be shown live.
        forwardSubagentText: true,
        canUseTool,
      },
    })
    this.setStatus('idle')
    void this.consume(this.queryHandle)
    void this.loadModels(this.queryHandle)
    void this.loadStartingModel(this.queryHandle)
    void this.loadCommands(this.queryHandle)
    void this.refreshContext()
    void this.refreshPlanUsage()
    // Windows reset and other chats spend the same plan while this one sits idle.
    this.planUsageTimer = setInterval(() => void this.refreshPlanUsage(), PLAN_USAGE_IDLE_REFRESH_MS)
    this.planUsageTimer.unref?.()
    const held = this.heldSends ?? []
    this.heldSends = null
    if (this.spec.initialPrompt) this.send(this.spec.initialPrompt)
    for (const send of held) this.send(send.text, send.images, send.options)
    // A switch asked for while the earlier turns replayed can go now.
    this.checkSwitch()
  }

  /**
   * Sends a message. Typed `/commands` and `@paths` reach Claude Code as text
   * (never `client_composed`), so it expands them as the TUI does. Images go
   * before the text, which also names their saved copies.
   */
  send(text: string, images: ChatImageRef[] = [], options: ChatSendOptions = {}): void {
    const trimmed = text.trim()
    if (!trimmed && !images.length) return
    if (this.heldSends) {
      this.heldSends.push({ text: trimmed, images, options })
      return
    }
    if (this.info.claudeCodeSwitch === 'switching') {
      this.emitItems(this.mapper.notice('error', `The chat is switching to Claude Code, so your message wasn't sent.${trimmed ? ` It was: "${quote(trimmed)}"` : ''}`))
      return
    }
    if (options.delivery === 'queue' && this.turnOpen) {
      this.enqueue(trimmed, images)
      return
    }
    // A steer only means something while a turn runs; otherwise it is a plain send.
    const steer = options.delivery === 'steer' && this.turnOpen
    if (!images.length && !options.permissionMode && this.queuedSends === 0) {
      this.deliver(trimmed, [], undefined, { steer, ...(options.relayTo ? { relayTo: options.relayTo } : {}) })
      return
    }
    this.queuedSends += 1
    this.sendChain = this.sendChain.then(async () => {
      const quoted = trimmed ? ` Your message was: "${trimmed.length > 500 ? `${trimmed.slice(0, 500)}…` : trimmed}"` : ''
      try {
        if (options.permissionMode && !(await this.switchPermissionMode(options.permissionMode))) {
          this.emitItems(this.mapper.notice('error', `Couldn't switch to ${options.permissionMode} mode, so the message wasn't sent.${quoted}`))
          return
        }
        let attached: Awaited<ReturnType<AgentSession['attach']>>
        try {
          attached = await this.attach(images)
        } catch (error) {
          this.emitItems(this.mapper.notice('error', `Couldn't attach the image${images.length > 1 ? 's' : ''}, so the message wasn't sent: ${errorText(error)}.${quoted}`))
          return
        }
        this.deliver(trimmed, images, attached, { steer, ...(options.relayTo ? { relayTo: options.relayTo } : {}) })
      } catch (error) {
        // Keep the chain usable for later sends, and say what was lost.
        this.emitItems(this.mapper.notice('error', `The message wasn't sent: ${errorText(error)}.${quoted}`))
      } finally {
        this.queuedSends -= 1
        // Whatever stayed queued behind a send that failed goes now, not after the next message.
        if (!this.turnOpen) this.flushQueue()
        this.checkSwitch()
      }
    })
  }

  /** Edits, removes or steers a queued message. */
  updateQueue(change: ChatQueueAction): void {
    const entry = this.queue.find((queued) => queued.id === change.id)
    if (!entry) {
      // It went to Claude with the rest of the queue before this change arrived.
      this.emitItems(this.mapper.notice('info', change.action === 'edit'
        ? `That queued message was already sent, so your edit wasn't applied: "${quote(change.text)}"`
        : 'That queued message was already sent.'))
      return
    }
    if (change.action === 'edit') {
      this.setQueue(this.queue.map((queued) => (queued.id === change.id ? { ...queued, text: change.text.trim() || queued.text } : queued)))
      return
    }
    this.setQueue(this.queue.filter((queued) => queued.id !== change.id))
    if (change.action === 'steer') this.send(entry.text, entry.images ?? [], { delivery: 'steer' })
  }

  private enqueue(text: string, images: ChatImageRef[]): void {
    if (this.queue.length >= MAX_QUEUED_MESSAGES) {
      this.emitItems(this.mapper.notice('error', `The queue holds ${MAX_QUEUED_MESSAGES} messages, so this one wasn't queued: "${quote(text)}"`))
      return
    }
    this.queueCounter += 1
    this.setQueue([...this.queue, { id: `queued-${Date.now().toString(36)}-${this.queueCounter}`, text, ...(images.length ? { images } : {}) }])
  }

  private setQueue(queue: ChatQueuedMessage[]): void {
    this.queue = queue
    const { queue: _previous, ...rest } = this.info
    this.info = queue.length ? { ...rest, queue } : rest
    this.emitSession()
  }

  /**
   * Sends what was queued once the running turn ends, as one message: the
   * user wrote them while watching the same turn, so Claude reads them
   * together (as the Claude Code TUI joins its queued prompts). A message
   * that would push the images over the limit waits for the next turn.
   */
  private flushQueue(): void {
    // A switch to Claude Code carries the queue across instead.
    if (!this.queue.length || this.turnOpen || this.info.claudeCodeSwitch || this.info.status === 'closed' || this.info.status === 'error') return
    const batch: ChatQueuedMessage[] = []
    let imageCount = 0
    for (const queued of this.queue) {
      const count = queued.images?.length ?? 0
      if (batch.length && imageCount + count > MAX_CHAT_IMAGES) break
      batch.push(queued)
      imageCount += count
    }
    this.setQueue(this.queue.slice(batch.length))
    this.send(batch.map((queued) => queued.text).filter(Boolean).join('\n\n'), batch.flatMap((queued) => queued.images ?? []))
  }

  /** A turn is over: the queue can go. */
  private closeTurn(): void {
    this.turnOpen = false
    this.steersPending = 0
    this.flushQueue()
    this.checkSwitch()
  }

  private tuiCommand(launcher: string | undefined, returnFlags: readonly string[], sessionId: string | undefined): string {
    if (!launcher || !this.spec.claudePath || !sessionId) {
      throw new Error(!sessionId
        ? 'this chat has no conversation yet'
        : "this host was started without the commando-agent launcher or can't find claude")
    }
    const readableIndex = returnFlags.indexOf('--readable-dir')
    return claudeCodeSwitchCommand({
      ...(this.info.selectedModel ? { model: this.info.selectedModel } : {}),
      ...(this.info.effort ? { effort: this.info.effort } : {}),
      permissionMode: isChatPermissionMode(this.info.permissionMode) ? this.info.permissionMode : this.spec.permissionMode,
      ...(this.info.bypassAllowed ? { bypassAllowed: true } : {}),
      ...(readableIndex >= 0 ? { readableDir: returnFlags[readableIndex + 1] } : {}),
    }, this.spec.claudePath, launcher, sessionId, returnFlags)
  }

  /**
   * Asks to hand the conversation to Claude Code: once the turn ends
   * (`after_turn`), or by interrupting it (`now`). The queue is held, not sent,
   * and goes across with the switch. `cancel` withdraws a switch still waiting.
   */
  async requestSwitch(action: ChatSwitchAction): Promise<void> {
    const current = this.info.claudeCodeSwitch
    if (current === 'switching') return
    if (action === 'cancel') {
      if (current) this.endSwitch()
      return
    }
    if (this.info.status === 'closed' || this.info.status === 'error') {
      this.emitItems(this.mapper.notice('error', "This session isn't running, so it can't switch to Claude Code."))
      return
    }
    if (!this.info.sessionId) {
      this.emitItems(this.mapper.notice('error', 'Send a message first: Claude Code resumes a conversation, and this chat has none yet.'))
      return
    }
    if (current === action || (current === 'now' && action === 'after_turn')) return
    this.info = { ...this.info, claudeCodeSwitch: action }
    this.emitSession()
    if (action === 'now' && (this.turnOpen || this.info.status === 'running' || this.info.status === 'waiting')) await this.interrupt()
    this.checkSwitch()
  }

  /** The switch is off (cancelled, or it failed): the chat carries on, and what was queued goes. */
  endSwitch(notice?: string): void {
    if (!this.info.claudeCodeSwitch) return
    const { claudeCodeSwitch: _switch, ...rest } = this.info
    this.info = rest
    if (notice) this.emitItems(this.mapper.notice('error', notice))
    this.emitSession()
    if (!this.turnOpen) this.flushQueue()
  }

  /** The messages a switch carries across. */
  get queued(): ChatQueuedMessage[] {
    return [...this.queue]
  }

  /** The daemon kept the queue for the switch: end the session, without saying the queue was lost. */
  handOver(): void {
    this.handedOver = true
    this.close()
  }

  /** Starts a requested switch once nothing is running or waiting on Claude. */
  private checkSwitch(): void {
    const requested = this.info.claudeCodeSwitch
    if (requested !== 'after_turn' && requested !== 'now') return
    if (this.turnOpen || this.queuedSends > 0 || this.pending.size > 0 || this.heldSends) return
    if (this.info.status !== 'idle') return
    this.info = { ...this.info, claudeCodeSwitch: 'switching' }
    this.emitSession()
    for (const listener of this.listeners.switchReady) listener()
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

  private deliver(
    text: string,
    images: ChatImageRef[],
    { blocks, notes }: { blocks: unknown[]; notes: string[] } = { blocks: [], notes: [] },
    { steer = false, relayTo }: { steer?: boolean; relayTo?: { agentId: string; label: string } } = {},
  ): void {
    if (this.info.status === 'closed' || this.info.status === 'error') {
      this.emitItems(this.mapper.notice('error', `This session has ended, so your message wasn't sent. Start commando-agent again in this pane to continue it.${text ? ` Your message was: "${quote(text)}"` : ''}`))
      return
    }
    this.emitItems(this.mapper.startTurn(text, images, { ...(steer ? { steered: true } : {}), ...(relayTo ? { relayTo } : {}) }))
    if (steer) this.steersPending += 1
    this.turnOpen = true
    this.unseenDelivery = true
    if (!this.info.title && text) this.info = { ...this.info, title: shortTitle(text) }
    // Shown at once; Claude's own session state confirms it (or folds this into the running turn).
    this.setStatus('running')
    const prompt = relayTo ? relayPrompt(text, relayTo) : text
    const withNotes = [prompt, ...notes].filter(Boolean).join('\n\n')
    this.input.push({
      type: 'user',
      // Images first: a /command in a text block after them still expands.
      message: { role: 'user', content: blocks.length ? [...blocks, ...(withNotes ? [{ type: 'text', text: withNotes }] : [])] : prompt },
      parent_tool_use_id: null,
      // 'now' ends the running turn early and runs this as its own turn: at once
      // while Claude writes; a command it has only just started is aborted, one
      // it already tracks as a task finishes first.
      ...(steer ? { priority: 'now' } : {}),
      origin: { kind: 'human' },
    } as SDKUserMessage)
  }

  /** Stops or backgrounds one running subagent. */
  async controlTask(action: ChatTaskAction, agentId: string, toolUseId: string): Promise<void> {
    const handle = this.queryHandle
    if (!handle || this.info.status === 'closed' || this.info.status === 'error') {
      this.emitItems(this.mapper.notice('error', "This session isn't running, so its subagents can't be changed."))
      return
    }
    try {
      if (action === 'stop') {
        await handle.stopTask(agentId)
      } else if (!(await handle.backgroundTasks(toolUseId))) {
        this.emitItems(this.mapper.notice('info', 'That subagent already runs in the background or has finished.'))
      }
    } catch (error) {
      this.emitItems(this.mapper.notice('error', `Couldn't ${action === 'stop' ? 'stop' : 'background'} the subagent: ${errorText(error)}`))
    }
  }

  /** A subagent's own turns from its saved transcript (after a resume, or once it is done). */
  async subagentTranscript(agentId: string): Promise<ChatSubagentTranscript> {
    const sessionId = this.info.sessionId
    if (!sessionId) return { items: [], error: 'This chat has no saved conversation yet' }
    if (!this.store.subagentMessages) return { items: [], error: "This host can't read subagent transcripts" }
    try {
      const messages = await this.store.subagentMessages(sessionId, agentId, this.spec.cwd)
      if (!messages.length) return { items: [], error: "Claude Code hasn't saved this subagent's transcript" }
      // Claude Code tags the subagent's own messages with its Agent call; here they are the whole conversation.
      return { items: new ClaudeItemMapper(Date.now, this.spec.images).replay(messages.map((message) => ({ ...message, parent_tool_use_id: null }))) }
    } catch (error) {
      return { items: [], error: `Couldn't read the subagent's transcript: ${errorText(error)}` }
    }
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

  /**
   * Stops the running turn. `dropQueued` names queued messages the client
   * took back into its draft (as the TUI does on Esc), so they aren't sent.
   */
  async interrupt(dropQueued: readonly string[] = []): Promise<void> {
    if (dropQueued.length) this.setQueue(this.queue.filter((queued) => !dropQueued.includes(queued.id)))
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
    // A question dismissed on the island or phone arrives as a denial.
    const dismissed = request?.requestKind === 'question' && answer.kind === 'approval' && answer.decision === 'deny'
    if (!request || (!dismissed && request.requestKind !== (answer.kind === 'approval' ? 'approval' : 'question'))) return false
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
    this.emitItems(this.mapper.resolveRequest(requestId, dismissed ? { kind: 'cancelled', reason: 'Dismissed' } : answer))
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
        await this.switchPermissionMode(change.permissionMode)
      }
    }
    this.emitSession()
  }

  /** Switches the permission mode; false (with a notice) when Claude refuses. */
  private async switchPermissionMode(mode: ChatSessionPermissionMode): Promise<boolean> {
    const handle = this.queryHandle
    if (!handle) return false
    if (mode === 'bypassPermissions' && !this.info.bypassAllowed) {
      this.emitItems(this.mapper.notice('error', 'Bypass permissions is only available in a chat started with it.'))
      return false
    }
    try {
      await handle.setPermissionMode(mode)
      this.recordPermissionMode(mode)
      this.emitSession()
      return true
    } catch (error) {
      this.emitItems(this.mapper.notice('error', `Couldn't change the permission mode: ${errorText(error)}`))
      return false
    }
  }

  /** Notes a mode change, remembering the mode the chat left for plan mode. */
  private recordPermissionMode(mode: string): void {
    const previous = this.info.permissionMode
    if (mode === previous) return
    const leftForPlan = mode === 'plan' && isChatPermissionMode(previous) && previous !== 'plan'
    this.info = { ...this.info, permissionMode: mode, ...(leftForPlan ? { prePlanPermissionMode: previous } : {}) }
  }

  /** Points the session's resume command at its current settings. */
  setResumeCommand(command: string): void {
    if (command === this.info.resumeCommand) return
    this.info = { ...this.info, resumeCommand: command }
    this.emitSession()
  }

  close(): void {
    this.stopPlanUsage()
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

  /**
   * The model a fresh chat will run, settings included, so the picker can name it before
   * the first turn; Claude only reports the model in that turn's `system/init`.
   */
  private async loadStartingModel(handle: Query): Promise<void> {
    // Not in the SDK's typings yet; without it the picker names the default row instead.
    const { getSettings } = handle as { getSettings?: () => Promise<{ applied?: { model?: unknown } }> }
    if (typeof getSettings !== 'function') return
    try {
      const model = (await getSettings.call(handle)).applied?.model
      // A pick or the first turn may have named the model meanwhile.
      if (this.info.model || !isModelValue(model)) return
      this.info = { ...this.info, model }
      this.emitSession()
    } catch (error) {
      this.spec.log?.(`Couldn't read the model Claude will run: ${errorText(error)}`)
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

  /** Reads the plan's rate limits (Claude's `/usage`), for the composer's usage meter. */
  private async refreshPlanUsage(): Promise<void> {
    const handle = this.queryHandle
    if (!handle || this.planUsageOff) return
    const readUsage = handle[PLAN_USAGE_METHOD]
    if (typeof readUsage !== 'function') {
      this.stopPlanUsage()
      return
    }
    const read = ++this.planUsageReads
    this.planUsageAskedAt = this.now()
    try {
      const report = await readUsage.call(handle, { skipBehaviors: true })
      if (read !== this.planUsageReads) return
      const usage = toPlanUsage(report, this.now())
      if (usage === NO_PLAN_LIMITS) {
        this.stopPlanUsage()
        if (!this.info.planUsage) return
        const { planUsage: _gone, ...rest } = this.info
        this.info = rest
      } else if (usage) {
        this.info = { ...this.info, planUsage: usage }
      } else {
        // The usage fetch failed this time; the last reading stands and shows as stale once it ages.
        this.spec.log?.("Couldn't read plan usage: Claude returned no limits")
        return
      }
      this.emitSession()
    } catch (error) {
      // The meter keeps the last reading, which shows as stale once it ages.
      if (this.info.status !== 'closed' && this.info.status !== 'error') this.spec.log?.(`Couldn't read plan usage: ${errorText(error)}`)
    }
  }

  private stopPlanUsage(): void {
    this.planUsageOff = true
    if (this.planUsageTimer) clearInterval(this.planUsageTimer)
    this.planUsageTimer = undefined
  }

  /** After a turn: the meter changed, and a model list that failed to load gets another try. */
  private refreshBetweenTurns(): void {
    void this.refreshContext()
    if (this.now() - this.planUsageAskedAt >= PLAN_USAGE_TURN_REFRESH_MS) void this.refreshPlanUsage()
    if (!this.info.models && this.queryHandle) void this.loadModels(this.queryHandle)
  }

  private applySessionState(state: 'idle' | 'running' | 'requires_action'): void {
    if (this.info.status === 'closed' || this.info.status === 'error') return
    if (state === 'idle') {
      this.refreshBetweenTurns()
      if (this.unseenDelivery) {
        // E.g. the idle for a result we already answered by sending the queue:
        // that send's turn runs next, so the chat stays running and Enter keeps
        // queueing. Ignored once, so the chat can't stick on running.
        this.unseenDelivery = false
        return
      }
      this.setStatus('idle')
      // A backstop: the turn's result normally sent the queue already.
      this.closeTurn()
    } else {
      // Claude took up what was sent; its next idle is real.
      this.unseenDelivery = false
      this.setStatus(state === 'requires_action' || this.pending.size ? 'waiting' : 'running')
    }
  }

  private requestPermission(
    toolName: string,
    input: Record<string, unknown>,
    options: Parameters<CanUseTool>[2],
  ): Promise<PermissionResult> {
    const requestId = options.requestId || options.toolUseID
    if (toolName === 'ExitPlanMode' && !options.agentID) {
      // The plan becomes a card with Implement and Refine; without a plan, the generic approval below.
      const plan = planFromInput(input)
      if (plan) {
        this.emitItems(this.mapper.plan(options.toolUseID, plan))
        return Promise.resolve({ behavior: 'deny', message: PLAN_CAPTURED_MESSAGE })
      }
    }
    const requestKind = toolName === 'AskUserQuestion' ? 'question' : 'approval'
    const title = requestKind === 'question'
      ? 'Claude is asking'
      : options.title ?? `Allow ${options.displayName ?? toolTitle(toolName, input)}?`
    const detail = requestKind === 'approval' ? approvalDetail(toolName, input) : undefined
    if (options.signal.aborted) return Promise.resolve({ behavior: 'deny', message: 'Cancelled.' })
    return new Promise<PermissionResult>((resolve) => {
      this.pending.set(requestId, { requestKind, input, suggestions: options.suggestions, resolve })
      this.emitItems(this.mapper.request(requestId, options.agentID, {
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
      // Queued messages can't go any more; say what they were rather than drop them unseen.
      // A switch to Claude Code has handed them over already.
      if (this.queue.length && this.handedOver) {
        this.setQueue([])
      } else if (this.queue.length) {
        const texts = this.queue.map((queued) => `"${quote(queued.text)}"`).join(', ')
        this.setQueue([])
        this.emitItems(this.mapper.notice('error', `The session ended with messages still queued, so they weren't sent: ${texts}`))
      }
      this.stopPlanUsage()
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
        if (model) this.info = { ...this.info, model }
        if (permissionMode) this.recordPermissionMode(permissionMode)
        this.emitSession()
      }
    }
    if (message.type === 'result') {
      const interrupted = this.interruptRequested
      this.interruptRequested = false
      // A steer or Stop cuts the turn short; what it was doing ends, it didn't fail.
      const aborted = interrupted || ABORTED_REASONS.has(message.terminal_reason ?? '')
      const steered = this.steersPending > 0 && aborted
      this.unseenDelivery = false
      this.emitItems(this.mapper.settleRunning(aborted ? 'interrupted' : message.subtype === 'success' ? 'completed' : 'failed', { keepBackground: true }))
      const errors = 'errors' in message && Array.isArray(message.errors) ? message.errors.join('\n') : ''
      if (interrupted) {
        this.emitItems(this.mapper.notice('info', 'Interrupted'))
      } else if (aborted) {
        // The steer that cut it short starts its own turn; its bubble says so.
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
      // The steered message now runs as its own turn; the queue waits for that one.
      if (steered) this.steersPending -= 1
      // Background subagents keep Claude from reporting idle, so the queue goes at the turn's end.
      else this.closeTurn()
      void this.refreshTitle()
      return
    }
    if (message.type === 'rate_limit_event') {
      if (this.planUsageOff) return
      const usage = applyRateLimitEvent(this.info.planUsage, message.rate_limit_info, this.now())
      if (usage && usage !== this.info.planUsage) {
        // A /usage read already under way predates this; drop it, and let the next turn read again.
        this.planUsageReads += 1
        this.planUsageAskedAt = 0
        this.info = { ...this.info, planUsage: usage }
        this.emitSession()
      }
      return
    }
    if (message.type === 'assistant' && !message.parent_tool_use_id) {
      // A turn Claude started itself (a background task finished) holds the queue too.
      this.turnOpen = true
    }
    this.emitItems(this.mapper.handle(message))
  }

  /** Claude names conversations after a turn or two; pick that up for the pane title. */
  private async refreshTitle(): Promise<void> {
    const sessionId = this.info.sessionId
    if (!sessionId) return
    try {
      // Until Claude summarises it, the title is the first prompt, which can carry attachment notes.
      const stored = await this.store.title(sessionId, this.spec.cwd)
      const title = stored && shortTitle(stripAttachmentNotesFromSummary(stored))
      if (title && title !== this.info.title) {
        this.info = { ...this.info, title }
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
    if (status === 'idle') this.checkSwitch()
  }

  private emitSession(): void {
    for (const listener of this.listeners.session) listener({ ...this.info })
  }

  private emitItems(items: ChatItem[]): void {
    if (!items.length) return
    for (const listener of this.listeners.items) listener(items)
  }
}
