/**
 * Chat panes: an agent host process runs inside a tmux pane, drives the agent
 * through its SDK, and streams typed turn items to the daemon, which relays
 * them to the web UI. Every host message names the pane it is about, so one
 * host can carry one session (per-pane mode) or many (shared mode).
 */

export const AGENT_HOST_PROTOCOL_VERSION = 5
/**
 * Hosts from this version accept `configure` and report their picker state.
 * Older hosts keep running after a merge until restarted, so check before
 * offering pickers or trusting their (missing) settings.
 */
export const CHAT_SETTINGS_HOST_VERSION = 2

export function hostTakesSettings(session: { hostVersion: number }): boolean {
  return session.hostVersion >= CHAT_SETTINGS_HOST_VERSION
}
/** Hosts from this version list commands, search files and accept images. */
export const CHAT_INPUT_HOST_VERSION = 3

export function hostTakesInput(session: { hostVersion: number }): boolean {
  return session.hostVersion >= CHAT_INPUT_HOST_VERSION
}
/**
 * Hosts from this version hold a send queue, steer, capture plans and report
 * subagents; older ones would send a queued message straight to Claude.
 */
export const CHAT_FLOW_HOST_VERSION = 4

export function hostTakesTurnFlow(session: { hostVersion: number }): boolean {
  return session.hostVersion >= CHAT_FLOW_HOST_VERSION
}
/** Hosts from this version can hand their conversation to Claude Code in the same pane. */
export const CHAT_SWITCH_HOST_VERSION = 5

export function hostTakesSwitch(session: { hostVersion: number }): boolean {
  return session.hostVersion >= CHAT_SWITCH_HOST_VERSION
}
/** WebSocket close code the daemon uses when a host does not run in the pane it claims. */
export const HOST_REFUSED_CLOSE_CODE = 4003
export const AGENT_HOST_WS_PATH = '/agent-host/ws'

export type ChatProvider = 'claude' | 'codex'
export type ChatItemStatus = 'running' | 'completed' | 'failed' | 'interrupted'
export type ChatSessionStatus = 'starting' | 'idle' | 'running' | 'waiting' | 'closed' | 'error'

export interface ChatTodo {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
}

export interface ChatQuestionOption {
  label: string
  description?: string
}

export interface ChatQuestion {
  question: string
  header?: string
  options: ChatQuestionOption[]
  multiSelect: boolean
}

/** What the user decided about a request; kept on the item once answered. */
export type ChatRequestAnswer =
  | { kind: 'approval'; decision: 'allow' | 'allow_always' | 'deny'; message?: string }
  | { kind: 'question'; answers: Record<string, string> }
  | { kind: 'cancelled'; reason: string }

/** Image types Claude reads; anything else is refused before upload. */
export const CHAT_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const
export type ChatImageType = typeof CHAT_IMAGE_TYPES[number]
export const MAX_CHAT_IMAGE_BYTES = 10 * 1024 * 1024
export const MAX_CHAT_IMAGES = 10
/**
 * Longest edge the browser keeps when it resizes an image before upload.
 * Claude Code downsizes anything larger to 2000px itself, so matching it
 * avoids resizing twice.
 */
export const CHAT_IMAGE_MAX_DIMENSION = 2000
export const CHAT_IMAGE_EXTENSIONS: Record<ChatImageType, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' }
/**
 * Names the saved copy of an attached image in the text Claude gets, so its
 * tools can open the file (after t3code's AttachmentPrompt). The host appends
 * one per image after the typed text.
 */
export function attachmentNote(name: string, path: string): string {
  return `[Attached image "${name.replace(/["\]\r\n]/g, '_').slice(0, 120)}" is saved at: ${path}]`
}

/** Matches attachmentNote's notes; the first group is the saved path. */
export const ATTACHMENT_NOTES = /\s*\[Attached image "[^"\n]*" is saved at: ([^\]\n]+)\]/g
const ATTACHMENT_NOTE_START = '[Attached image "'

/** The text the person typed, without the notes the host added for Claude. */
export function stripAttachmentNotes(text: string): string {
  return text.replace(ATTACHMENT_NOTES, '').trim()
}

/** A shortened prompt (a hook's summary, a session's first prompt) without the notes, even one cut off at the end. */
export function stripAttachmentNotesFromSummary(text: string): string {
  const stripped = stripAttachmentNotes(text)
  // A length limit can cut a note anywhere: after its opening (the image name
  // may hold a "["), or inside its opening words.
  const marker = stripped.lastIndexOf(ATTACHMENT_NOTE_START)
  const open = marker >= 0 && !stripped.slice(marker).includes(']') ? marker : stripped.lastIndexOf('[')
  const tail = stripped.slice(open)
  const cutNote = open >= 0 && (open === 0 || /\s/.test(stripped[open - 1]!)) && !tail.includes(']')
    && (tail.startsWith(ATTACHMENT_NOTE_START) || ATTACHMENT_NOTE_START.startsWith(tail))
  return cutNote ? stripped.slice(0, open).trim() : stripped
}

/** Images are stored by content hash, so an id is also a safe file name. */
const CHAT_IMAGE_ID = /^[0-9a-f]{64}\.(png|jpg|gif|webp)$/

export function isChatImageId(value: unknown): value is string {
  return typeof value === 'string' && CHAT_IMAGE_ID.test(value)
}

export function chatImageType(id: string): ChatImageType {
  const extension = id.slice(id.lastIndexOf('.') + 1)
  return (Object.entries(CHAT_IMAGE_EXTENSIONS).find(([, value]) => value === extension)?.[0] ?? 'image/png') as ChatImageType
}

/** Where the browser loads a stored chat image from. */
export function chatImageUrl(id: string): string {
  return `/chat-images/${id}`
}

/** An image in a message or tool result, stored by the daemon or host. */
export interface ChatImageRef {
  id: string
  /** The file name it was pasted or dropped with. */
  name?: string
}

/** A `/` menu entry: one of Claude Code's commands or skills. */
export interface ChatCommand {
  name: string
  description: string
  argumentHint?: string
  aliases?: string[]
  /**
   * Skills are also listed to Claude, which can run them through its Skill
   * tool when they appear mid-message; commands only run at the start.
   */
  kind: 'skill' | 'command'
}

/** One `@` mention candidate, relative to the session's folder. */
export interface ChatFileEntry {
  path: string
  kind: 'file' | 'directory'
}

export interface ChatFileSearchResult {
  entries: ChatFileEntry[]
  /** More files matched (or the index was capped) than were returned. */
  truncated: boolean
  error?: string
}

/** A message the host holds until Claude's turn ends (Enter while Claude works). */
export interface ChatQueuedMessage {
  id: string
  text: string
  images?: ChatImageRef[]
}

/**
 * How a send reaches Claude. `queue` waits for the running turn to end; `steer`
 * goes in at once with `priority: 'now'`, ending the running turn at its next
 * safe point. Without one, the message goes straight to Claude (older clients).
 */
export type ChatDelivery = 'queue' | 'steer'

/** A subagent run: its Agent tool call, kept up to date from Claude's task events. */
export type ChatSubagentState = 'running' | 'completed' | 'failed' | 'stopped'

interface ChatItemBase {
  id: string
  /** Groups items into turns; a turn starts with the user's message. */
  turnId: string
  /** Set when the item came from a subagent's tool call. */
  parentToolUseId?: string
  status: ChatItemStatus
  createdAt: number
  updatedAt: number
}

export type ChatItem = ChatItemBase & (
  | {
      kind: 'user_message'
      text: string
      images?: ChatImageRef[]
      /** Sent with ⌘Enter while Claude worked: it ended the running turn early. */
      steered?: boolean
      /** Relayed through main Claude's SendMessage tool to this subagent. */
      relayTo?: { agentId: string; label: string }
    }
  | { kind: 'assistant_message'; text: string }
  | { kind: 'reasoning'; text: string }
  | { kind: 'command'; toolUseId: string; command: string; description?: string; output?: string; isError?: boolean }
  | {
      kind: 'file_change'
      toolUseId: string
      toolName: string
      path: string
      additions: number
      deletions: number
      /** Unified-style hunk text built from the tool input (not a git diff). */
      patch?: string
      isError?: boolean
      output?: string
    }
  | { kind: 'tool'; toolUseId: string; toolName: string; title: string; detail?: string; output?: string; isError?: boolean; images?: ChatImageRef[] }
  | { kind: 'todo_list'; todos: ChatTodo[] }
  | {
      kind: 'request'
      requestId: string
      requestKind: 'approval' | 'question'
      toolName: string
      title: string
      detail?: string
      questions?: ChatQuestion[]
      answer?: ChatRequestAnswer
    }
  | { kind: 'notice'; level: 'info' | 'error'; text: string }
  /** Claude's plan from ExitPlanMode, captured instead of a generic approval. */
  | { kind: 'plan'; toolUseId: string; text: string }
  | {
      kind: 'subagent'
      /** The Agent tool call that started it; its own items carry this as parentToolUseId. */
      toolUseId: string
      description: string
      subagentType?: string
      /** The task id from task events, which is also the subagent's agent id. */
      agentId?: string
      prompt?: string
      /** Runs in the background: the Agent call returned at once and the turn went on. */
      background?: boolean
      state: ChatSubagentState
      toolUses?: number
      durationMs?: number
      totalTokens?: number
      lastToolName?: string
      /** Claude's one-line progress summary, or its final report once done. */
      summary?: string
      output?: string
    }
)

export type ChatItemKind = ChatItem['kind']

/** How hard Claude works on a reply (the SDK's effort levels). */
export type ChatEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export const CHAT_EFFORTS: readonly ChatEffort[] = ['low', 'medium', 'high', 'xhigh', 'max']

/** The SDK's permission modes; a chat can switch between them while it runs. */
export type ChatSessionPermissionMode = 'default' | 'acceptEdits' | 'plan' | 'auto' | 'dontAsk' | 'bypassPermissions'
export const CHAT_SESSION_PERMISSION_MODES: readonly ChatSessionPermissionMode[] = ['default', 'acceptEdits', 'plan', 'auto', 'dontAsk', 'bypassPermissions']

/** A model the session can switch to, as `supportedModels()` lists it. */
export interface ChatModelOption {
  /** What `setModel` and `--model` take: an alias (`sonnet`) or a full id. */
  value: string
  displayName: string
  description?: string
  /** The model id the value runs as, to match the id `system/init` reports. */
  resolvedModel?: string
  efforts?: ChatEffort[]
  supportsAutoMode?: boolean
}

/** How full the context window is, from `getContextUsage({detail: 'summary'})`. */
export interface ChatContextUsage {
  usedTokens: number
  maxTokens: number
  /** Tokens at which Claude compacts the conversation by itself. */
  autoCompactThreshold?: number
  autoCompact: boolean
  /** What fills the used part of the window, largest first. */
  categories: { name: string; tokens: number }[]
}

/** A picker change; at least one field is set. */
export interface ChatSettingsChange {
  model?: string
  effort?: ChatEffort
  permissionMode?: ChatSessionPermissionMode
}

export interface ChatSessionInfo {
  /** tmux pane id (`%N`) the session belongs to. */
  paneId: string
  provider: ChatProvider
  cwd: string
  status: ChatSessionStatus
  sessionId?: string
  /** The model running, as `system/init` reports it (a full id). */
  model?: string
  /** The model value picked in the chat or at launch; restarts and resumes carry it. */
  selectedModel?: string
  /** The effort picked in the chat or at launch (Claude does not report its default). */
  effort?: ChatEffort
  permissionMode?: string
  /** Bypass needs a flag at launch, so only a chat started with it can switch to it. */
  bypassAllowed?: boolean
  models?: ChatModelOption[]
  contextUsage?: ChatContextUsage
  /** Claude config directory (`~/.claudep`, `~/.claudew`); decides the login used. */
  configDir?: string
  hostPid: number
  hostVersion: number
  /** Fingerprint of the host's source; the daemon compares it with the checkout. */
  hostBuild?: string
  /** Conversation title (Claude's summary, a custom title, or the first prompt). */
  title?: string
  /** The command that resumes this conversation as a chat pane. */
  resumeCommand?: string
  /** Last error that stopped or broke the session. */
  error?: string
  /** Messages held until the running turn ends, oldest first. */
  queue?: ChatQueuedMessage[]
  /** The mode the chat had before it entered plan mode; Implement returns to it. */
  prePlanPermissionMode?: ChatSessionPermissionMode
  /** A switch to Claude Code in this pane: waiting for the turn to end, or under way. */
  claudeCodeSwitch?: ChatClaudeCodeSwitch
}

/**
 * `after_turn` waits for the running turn (and any answers it needs) to end;
 * `now` interrupted it; `switching` hands the conversation over.
 */
export type ChatClaudeCodeSwitch = 'after_turn' | 'now' | 'switching'
const CLAUDE_CODE_SWITCHES = new Set<ChatClaudeCodeSwitch>(['after_turn', 'now', 'switching'])

/** What a switch request asks of the host. */
export type ChatSwitchAction = 'after_turn' | 'now' | 'cancel'

export function isChatSwitchAction(value: unknown): value is ChatSwitchAction {
  return value === 'after_turn' || value === 'now' || value === 'cancel'
}

/** The chat's notice when Claude Code exits and the chat resumes the conversation. */
export const RETURNED_FROM_CLAUDE_CODE = 'Returned from Claude Code'

/**
 * What a chat held when it switched to Claude Code (the unsent draft, then
 * its queued messages), offered back to the composer when the chat returns.
 */
export interface ChatCarriedDraft {
  id: string
  text: string
  images: ChatImageRef[]
}

/** `claude-opus-5-5` for `claude-opus-5-5[1m]`: no row lists the context-window variant a setting can pick. */
export function baseModelId(id: string): string {
  return id.replace(/\[[^\]]*\]$/, '')
}

/**
 * The model the session runs, as a row of its list: the explicit pick, else the default row
 * while it runs, or before Claude reports a model at all (a fresh chat runs the default).
 */
export function selectedModelOption(session: Pick<ChatSessionInfo, 'models' | 'selectedModel' | 'model'>): ChatModelOption | undefined {
  const models = session.models ?? []
  // A persisted full id (`--model claude-sonnet-5-5`) may only match an alias row by `resolvedModel`.
  const named = (id: string) => models.find((model) => model.value === id)
    ?? models.find((model) => model.value !== 'default' && model.resolvedModel === id)
    ?? models.find((model) => model.resolvedModel === id)
  const running = session.model && baseModelId(session.model)
  if (session.selectedModel) return named(session.selectedModel) ?? (running ? named(running) : undefined)
  if (!running) return models.find((model) => model.value === 'default')
  return models.find((model) => model.value === 'default' && model.resolvedModel === running)
    ?? models.find((model) => model.value === running || model.resolvedModel === running)
}

/** A chat as the daemon relays it to clients: session plus its items in order. */
export interface ChatState {
  paneId: string
  targetId?: string
  session: ChatSessionInfo
  items: ChatItem[]
  /** False while the host is disconnected (daemon restarted, host gone). */
  hostConnected: boolean
  /** The host runs older code than the daemon's checkout; restarting it picks up the update. */
  updateAvailable?: boolean
  /** Claude Code's commands and skills, for the `/` menu. */
  commands?: ChatCommand[]
  /** The draft and queue the chat had when it switched to Claude Code, until a composer takes them. */
  carried?: ChatCarriedDraft
}

// ---- host ⇄ daemon ----

export type HostToDaemonMessage =
  | { type: 'hello'; hostId: string; version: number; mode: 'pane' | 'shared'; pid: number }
  /** Full state for one session: sent on (re)connect and when a session starts. */
  | { type: 'session_snapshot'; session: ChatSessionInfo; items: ChatItem[] }
  | { type: 'session_update'; session: ChatSessionInfo }
  /** Upserts by item id, in order. */
  | { type: 'items'; paneId: string; items: ChatItem[] }
  | { type: 'session_closed'; paneId: string }
  /** The full command list; replaces the previous one. */
  | { type: 'commands'; paneId: string; commands: ChatCommand[] }
  | ({ type: 'file_search_result'; paneId: string; requestId: string } & ChatFileSearchResult)
  | ({ type: 'subagent_transcript_result'; paneId: string; requestId: string } & ChatSubagentTranscript)
  /**
   * The host is about to hand the conversation to Claude Code: the daemon keeps
   * its queue (and the client's draft) until the chat comes back, and the
   * flags that bring it back. The host waits for `handoff_saved`.
   */
  | { type: 'handoff'; paneId: string; sessionId: string; cwd: string; queue: ChatQueuedMessage[]; returnFlags: string[] }

/** A finished subagent's own turns, read from its saved transcript. */
export interface ChatSubagentTranscript {
  items: ChatItem[]
  error?: string
}

/** Extra instructions for one send; see `ChatDelivery`. */
export interface ChatSendOptions {
  delivery?: ChatDelivery
  /** Switch to this permission mode first (Implement leaves plan mode). */
  permissionMode?: ChatSessionPermissionMode
  relayTo?: { agentId: string; label: string }
}

export type ChatQueueAction =
  | { action: 'edit'; id: string; text: string }
  | { action: 'remove'; id: string }
  /** Take it out of the queue and send it now, steering the running turn. */
  | { action: 'steer'; id: string }

export type ChatTaskAction = 'stop' | 'background'

/** What Implement sends, after t3code's buildPlanImplementationPrompt. */
export const PLAN_IMPLEMENTATION_PREFIX = 'PLEASE IMPLEMENT THIS PLAN:\n'

export function planImplementationPrompt(plan: string): string {
  return `${PLAN_IMPLEMENTATION_PREFIX}${plan.trim()}`
}

/** A plan's first heading (as t3code's proposedPlanTitle reads it), else its first line. */
export function chatPlanTitle(markdown: string, max = 200): string {
  const heading = /^\s{0,3}#{1,6}\s+(.+)$/m.exec(markdown)?.[1]?.trim()
  const firstLine = markdown.split('\n').find((line) => line.trim())?.trim()
  const title = (heading || firstLine || 'Claude plan').replace(/[\u0000-\u001f\u007f]/g, ' ').trim()
  return title.length > max ? `${title.slice(0, max - 1)}…` : title
}

export type ChatAnswer =
  | { kind: 'approval'; decision: 'allow' | 'allow_always' | 'deny'; message?: string }
  | { kind: 'question'; answers: Record<string, string> }

export type DaemonToHostMessage =
  | { type: 'welcome'; version: number }
  | ({ type: 'send'; paneId: string; text: string; images?: ChatImageRef[]; requestId: string } & ChatSendOptions)
  | ({ type: 'queue'; paneId: string; requestId: string } & ChatQueueAction)
  /** Stop or background one running subagent. */
  | { type: 'task'; paneId: string; action: ChatTaskAction; agentId: string; toolUseId: string; requestId: string }
  | { type: 'subagent_transcript'; paneId: string; agentId: string; requestId: string }
  /** Finds files and folders in the session's folder for an `@` mention. */
  | { type: 'file_search'; paneId: string; query: string; requestId: string }
  /** `dropQueued` names queued messages the client took back into its draft. */
  | { type: 'interrupt'; paneId: string; requestId: string; dropQueued?: string[] }
  | { type: 'answer'; paneId: string; chatRequestId: string; answer: ChatAnswer; requestId: string }
  /** Restart the host on the same conversation once the current turn ends. */
  | { type: 'restart'; paneId: string; requestId: string }
  /** Switch the model, effort or permission mode for the rest of the session. */
  | { type: 'configure'; paneId: string; settings: ChatSettingsChange; requestId: string }
  /** Hand the conversation to Claude Code in this pane, or cancel a switch that waits for the turn. */
  | { type: 'switch'; paneId: string; action: ChatSwitchAction; requestId: string }
  /** Answers `handoff`: false when the daemon couldn't keep it, and the switch is off. */
  | { type: 'handoff_saved'; paneId: string; ok: boolean; error?: string }

// ---- validation (host and client input both cross a trust boundary) ----

const PANE_ID = /^%\d+$/
const MAX_TEXT = 256 * 1024
export const MAX_FILE_QUERY = 512
const MAX_ID = 200

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function shortString(value: unknown, max = MAX_ID): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max
}

function optionalString(value: unknown, max = MAX_TEXT): boolean {
  return value === undefined || (typeof value === 'string' && value.length <= max)
}

export function isPaneId(value: unknown): value is string {
  return typeof value === 'string' && PANE_ID.test(value)
}

const ITEM_STATUSES = new Set<ChatItemStatus>(['running', 'completed', 'failed', 'interrupted'])
/** Model values reach a shell command line (quoted), so keep them to id characters. */
const MODEL_VALUE = /^[A-Za-z0-9][A-Za-z0-9._:@[\]/-]{0,199}$/

export function isChatEffort(value: unknown): value is ChatEffort {
  return CHAT_EFFORTS.includes(value as ChatEffort)
}

export function isChatPermissionMode(value: unknown): value is ChatSessionPermissionMode {
  return CHAT_SESSION_PERMISSION_MODES.includes(value as ChatSessionPermissionMode)
}

export function isModelValue(value: unknown): value is string {
  return typeof value === 'string' && MODEL_VALUE.test(value)
}

/** A picker change from the client or daemon: known fields only, at least one set. */
export function parseChatSettingsChange(value: unknown): ChatSettingsChange | null {
  if (!isRecord(value)) return null
  if (value.model !== undefined && !isModelValue(value.model)) return null
  if (value.effort !== undefined && !isChatEffort(value.effort)) return null
  if (value.permissionMode !== undefined && !isChatPermissionMode(value.permissionMode)) return null
  const change = withOptional({} as ChatSettingsChange, { model: value.model, effort: value.effort, permissionMode: value.permissionMode })
  return Object.keys(change).length ? change : null
}

function finiteCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function parseModels(value: unknown): ChatModelOption[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.slice(0, 64).flatMap((model) => {
    if (!isRecord(model) || !isModelValue(model.value) || typeof model.displayName !== 'string') return []
    const efforts = Array.isArray(model.efforts) ? model.efforts.filter(isChatEffort) : undefined
    return [withOptional({ value: model.value, displayName: model.displayName.slice(0, 200) } as ChatModelOption, {
      description: optionalText(model.description, 500),
      resolvedModel: isModelValue(model.resolvedModel) ? model.resolvedModel : undefined,
      efforts: efforts?.length ? efforts : undefined,
      supportsAutoMode: model.supportsAutoMode === true ? true : undefined,
    })]
  })
}

function parseContextUsage(value: unknown): ChatContextUsage | undefined {
  if (!isRecord(value) || !finiteCount(value.usedTokens) || !finiteCount(value.maxTokens) || value.maxTokens === 0) return undefined
  const categories = Array.isArray(value.categories)
    ? value.categories.slice(0, 32).flatMap((category) => (
        isRecord(category) && typeof category.name === 'string' && finiteCount(category.tokens)
          ? [{ name: category.name.slice(0, 120), tokens: category.tokens }]
          : []
      ))
    : []
  return withOptional({ usedTokens: value.usedTokens, maxTokens: value.maxTokens, autoCompact: value.autoCompact === true, categories } as ChatContextUsage, {
    autoCompactThreshold: finiteCount(value.autoCompactThreshold) ? value.autoCompactThreshold : undefined,
  })
}
const SESSION_STATUSES = new Set<ChatSessionStatus>(['starting', 'idle', 'running', 'waiting', 'closed', 'error'])

export function parseChatAnswer(value: unknown): ChatAnswer | null {
  if (!isRecord(value)) return null
  if (value.kind === 'approval') {
    if (value.decision !== 'allow' && value.decision !== 'allow_always' && value.decision !== 'deny') return null
    if (!optionalString(value.message, 4096)) return null
    return { kind: 'approval', decision: value.decision, ...(typeof value.message === 'string' ? { message: value.message } : {}) }
  }
  if (value.kind === 'question') {
    if (!isRecord(value.answers)) return null
    const answers: Record<string, string> = {}
    const entries = Object.entries(value.answers)
    if (entries.length > 16) return null
    for (const [question, answer] of entries) {
      if (question.length > 4096 || typeof answer !== 'string' || answer.length > 16_384) return null
      answers[question] = answer
    }
    return { kind: 'question', answers }
  }
  return null
}

function optionalText(value: unknown, max = MAX_TEXT): string | undefined {
  return typeof value === 'string' ? value.slice(0, max) : undefined
}

function withOptional<T extends object>(target: T, fields: Record<string, unknown>): T {
  for (const [key, value] of Object.entries(fields)) if (value !== undefined) (target as Record<string, unknown>)[key] = value
  return target
}

function parseTodos(value: unknown): ChatTodo[] | null {
  if (!Array.isArray(value) || value.length > 200) return null
  return value.flatMap((todo) => {
    if (!isRecord(todo) || typeof todo.content !== 'string') return []
    const status = todo.status === 'completed' || todo.status === 'in_progress' ? todo.status : 'pending'
    return [{ content: todo.content.slice(0, 2000), status }]
  })
}

function parseQuestions(value: unknown): ChatQuestion[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.slice(0, 16).flatMap((question) => {
    if (!isRecord(question) || typeof question.question !== 'string') return []
    const options = Array.isArray(question.options)
      ? question.options.slice(0, 32).flatMap((option) => (
          isRecord(option) && typeof option.label === 'string'
            ? [withOptional({ label: option.label.slice(0, 500) } as ChatQuestionOption, { description: optionalText(option.description, 2000) })]
            : []
        ))
      : []
    return [withOptional({ question: question.question.slice(0, 4096), options, multiSelect: question.multiSelect === true } as ChatQuestion, { header: optionalText(question.header, 200) })]
  })
}

/** Image refs on a message or tool result; ids are content hashes, so nothing else is trusted. */
export function parseChatImageRefs(value: unknown, max = MAX_CHAT_IMAGES): ChatImageRef[] | null {
  if (!Array.isArray(value) || value.length > max) return null
  const refs: ChatImageRef[] = []
  for (const ref of value) {
    if (!isRecord(ref) || !isChatImageId(ref.id) || !optionalString(ref.name, 1000)) return null
    refs.push(withOptional({ id: ref.id } as ChatImageRef, { name: typeof ref.name === 'string' ? ref.name.slice(0, 200) : undefined }))
  }
  return refs
}

/** Tool results can carry more images than a message the user sends. */
const MAX_ITEM_IMAGES = 20

function optionalImages(value: unknown): ChatImageRef[] | undefined {
  if (value === undefined) return undefined
  const refs = parseChatImageRefs(value, MAX_ITEM_IMAGES)
  return refs?.length ? refs : undefined
}

const COMMAND_NAME = /^[\w][\w:.@-]{0,127}$/

function parseChatCommands(value: unknown): ChatCommand[] | null {
  if (!Array.isArray(value)) return null
  return value.slice(0, 1000).flatMap((command) => {
    if (!isRecord(command) || typeof command.name !== 'string' || !COMMAND_NAME.test(command.name)) return []
    if (command.kind !== 'skill' && command.kind !== 'command') return []
    const aliases = Array.isArray(command.aliases)
      ? command.aliases.filter((alias): alias is string => typeof alias === 'string' && COMMAND_NAME.test(alias)).slice(0, 8)
      : []
    return [withOptional({ name: command.name, description: optionalText(command.description, 500) ?? '', kind: command.kind } as ChatCommand, {
      argumentHint: optionalText(command.argumentHint, 200) || undefined,
      aliases: aliases.length ? aliases : undefined,
    })]
  })
}

const MAX_FILE_ENTRIES = 200

function parseFileEntries(value: unknown): ChatFileEntry[] | null {
  if (!Array.isArray(value) || value.length > MAX_FILE_ENTRIES) return null
  return value.flatMap((entry) => (
    isRecord(entry) && shortString(entry.path, 4096) && !entry.path.includes('\0') && (entry.kind === 'file' || entry.kind === 'directory')
      ? [{ path: entry.path, kind: entry.kind }]
      : []
  ))
}

/** Agent ids are task ids (`a711460f062a7b1ef`); they reach Claude in a relay prompt. */
const AGENT_ID = /^[A-Za-z0-9_-]{1,128}$/

export function isAgentId(value: unknown): value is string {
  return typeof value === 'string' && AGENT_ID.test(value)
}

const RELAY_LABEL_MAX = 200

function parseRelayTarget(value: unknown): { agentId: string; label: string } | null | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value) || !isAgentId(value.agentId) || typeof value.label !== 'string') return null
  return { agentId: value.agentId, label: value.label.replace(/[\r\n"]/g, ' ').slice(0, RELAY_LABEL_MAX) }
}

/** The optional delivery fields of a send; null when one is malformed. */
export function parseChatSendOptions(value: Record<string, unknown>): ChatSendOptions | null {
  if (value.delivery !== undefined && value.delivery !== 'queue' && value.delivery !== 'steer') return null
  if (value.permissionMode !== undefined && !isChatPermissionMode(value.permissionMode)) return null
  const relayTo = parseRelayTarget(value.relayTo)
  if (relayTo === null) return null
  return withOptional({} as ChatSendOptions, { delivery: value.delivery, permissionMode: value.permissionMode, relayTo })
}

/** The most messages the host holds in a chat's queue. */
export const MAX_QUEUED_MESSAGES = 20
const MAX_QUEUED = MAX_QUEUED_MESSAGES

export function parseChatQueueAction(value: Record<string, unknown>): ChatQueueAction | null {
  if (!shortString(value.id)) return null
  if (value.action === 'remove' || value.action === 'steer') return { action: value.action, id: value.id }
  if (value.action === 'edit' && typeof value.text === 'string' && value.text.trim() && value.text.length <= MAX_TEXT) return { action: 'edit', id: value.id, text: value.text }
  return null
}

function parseQueue(value: unknown): ChatQueuedMessage[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.slice(0, MAX_QUEUED).flatMap((entry) => {
    if (!isRecord(entry) || !shortString(entry.id) || typeof entry.text !== 'string') return []
    return [withOptional({ id: entry.id, text: entry.text.slice(0, MAX_TEXT) } as ChatQueuedMessage, { images: optionalImages(entry.images) })]
  })
}

const SUBAGENT_STATES = new Set<ChatSubagentState>(['running', 'completed', 'failed', 'stopped'])

function optionalCount(value: unknown): number | undefined {
  return finiteCount(value) ? value : undefined
}

function parseRequestAnswer(value: unknown): ChatRequestAnswer | undefined {
  if (!isRecord(value)) return undefined
  if (value.kind === 'cancelled') return { kind: 'cancelled', reason: optionalText(value.reason, 500) ?? 'Cancelled' }
  return parseChatAnswer(value) ?? undefined
}

/**
 * Items come from our own host process, but the socket is still an input
 * boundary: copy only known, well-typed fields (they render straight into the
 * UI), and drop malformed items rather than the batch.
 */
export function parseChatItem(value: unknown): ChatItem | null {
  if (!isRecord(value)) return null
  if (!shortString(value.id) || !shortString(value.turnId) || typeof value.kind !== 'string') return null
  if (!ITEM_STATUSES.has(value.status as ChatItemStatus)) return null
  if (typeof value.createdAt !== 'number' || typeof value.updatedAt !== 'number') return null
  if (value.parentToolUseId !== undefined && !shortString(value.parentToolUseId)) return null
  const base = withOptional(
    { id: value.id, turnId: value.turnId, status: value.status as ChatItemStatus, createdAt: value.createdAt, updatedAt: value.updatedAt },
    { parentToolUseId: value.parentToolUseId },
  )
  const isError = value.isError === true ? true : undefined
  switch (value.kind) {
    case 'user_message':
      return typeof value.text === 'string'
        ? withOptional({ ...base, kind: 'user_message' as const, text: value.text.slice(0, MAX_TEXT) }, {
            images: optionalImages(value.images),
            steered: value.steered === true ? true : undefined,
            relayTo: parseRelayTarget(value.relayTo) ?? undefined,
          })
        : null
    case 'assistant_message':
    case 'reasoning':
      return typeof value.text === 'string' ? { ...base, kind: value.kind, text: value.text.slice(0, MAX_TEXT) } : null
    case 'command':
      if (!shortString(value.toolUseId) || typeof value.command !== 'string') return null
      return withOptional({ ...base, kind: 'command' as const, toolUseId: value.toolUseId, command: value.command.slice(0, 16_384) }, {
        description: optionalText(value.description, 2000), output: optionalText(value.output), isError,
      })
    case 'file_change':
      if (!shortString(value.toolUseId) || typeof value.path !== 'string' || typeof value.toolName !== 'string') return null
      if (!Number.isFinite(value.additions) || !Number.isFinite(value.deletions)) return null
      return withOptional({
        ...base, kind: 'file_change' as const, toolUseId: value.toolUseId, toolName: value.toolName.slice(0, 200), path: value.path.slice(0, 4096),
        additions: value.additions as number, deletions: value.deletions as number,
      }, { patch: optionalText(value.patch), output: optionalText(value.output), isError })
    case 'tool':
      if (!shortString(value.toolUseId) || typeof value.toolName !== 'string' || typeof value.title !== 'string') return null
      return withOptional({ ...base, kind: 'tool' as const, toolUseId: value.toolUseId, toolName: value.toolName.slice(0, 200), title: value.title.slice(0, 4096) }, {
        detail: optionalText(value.detail), output: optionalText(value.output), isError, images: optionalImages(value.images),
      })
    case 'todo_list': {
      const todos = parseTodos(value.todos)
      return todos ? { ...base, kind: 'todo_list', todos } : null
    }
    case 'request':
      if (!shortString(value.requestId) || (value.requestKind !== 'approval' && value.requestKind !== 'question')) return null
      if (typeof value.title !== 'string' || typeof value.toolName !== 'string') return null
      return withOptional({
        ...base, kind: 'request' as const, requestId: value.requestId, requestKind: value.requestKind as 'approval' | 'question', toolName: value.toolName.slice(0, 200), title: value.title.slice(0, 1000),
      }, { detail: optionalText(value.detail, 16_384), questions: parseQuestions(value.questions), answer: parseRequestAnswer(value.answer) })
    case 'notice':
      return (value.level === 'info' || value.level === 'error') && typeof value.text === 'string'
        ? { ...base, kind: 'notice', level: value.level, text: value.text.slice(0, 16_384) }
        : null
    case 'plan':
      return shortString(value.toolUseId) && typeof value.text === 'string'
        ? { ...base, kind: 'plan', toolUseId: value.toolUseId, text: value.text.slice(0, MAX_TEXT) }
        : null
    case 'subagent':
      if (!shortString(value.toolUseId) || typeof value.description !== 'string' || !SUBAGENT_STATES.has(value.state as ChatSubagentState)) return null
      return withOptional({
        ...base, kind: 'subagent' as const, toolUseId: value.toolUseId, description: value.description.slice(0, 500), state: value.state as ChatSubagentState,
      }, {
        subagentType: optionalText(value.subagentType, 200),
        agentId: isAgentId(value.agentId) ? value.agentId : undefined,
        prompt: optionalText(value.prompt, 16_384),
        background: value.background === true ? true : undefined,
        toolUses: optionalCount(value.toolUses),
        durationMs: optionalCount(value.durationMs),
        totalTokens: optionalCount(value.totalTokens),
        lastToolName: optionalText(value.lastToolName, 200),
        summary: optionalText(value.summary, 4000),
        output: optionalText(value.output),
      })
    default:
      return null
  }
}

export function parseChatSessionInfo(value: unknown): ChatSessionInfo | null {
  if (!isRecord(value)) return null
  if (!isPaneId(value.paneId) || (value.provider !== 'claude' && value.provider !== 'codex') || typeof value.cwd !== 'string') return null
  if (!SESSION_STATUSES.has(value.status as ChatSessionStatus)) return null
  if (typeof value.hostPid !== 'number' || typeof value.hostVersion !== 'number') return null
  for (const key of ['sessionId', 'model', 'permissionMode', 'configDir', 'error', 'hostBuild', 'title', 'resumeCommand'] as const) {
    if (!optionalString(value[key], 4096)) return null
  }
  if (value.selectedModel !== undefined && !isModelValue(value.selectedModel)) return null
  if (value.effort !== undefined && !isChatEffort(value.effort)) return null
  const models = parseModels(value.models)
  const contextUsage = parseContextUsage(value.contextUsage)
  const queue = parseQueue(value.queue)
  return {
    paneId: value.paneId,
    provider: value.provider,
    cwd: value.cwd,
    status: value.status as ChatSessionStatus,
    hostPid: value.hostPid,
    hostVersion: value.hostVersion,
    ...(typeof value.sessionId === 'string' ? { sessionId: value.sessionId } : {}),
    ...(typeof value.model === 'string' ? { model: value.model } : {}),
    ...(typeof value.permissionMode === 'string' ? { permissionMode: value.permissionMode } : {}),
    ...(typeof value.configDir === 'string' ? { configDir: value.configDir } : {}),
    ...(typeof value.error === 'string' ? { error: value.error } : {}),
    ...(typeof value.hostBuild === 'string' ? { hostBuild: value.hostBuild } : {}),
    ...(typeof value.title === 'string' ? { title: value.title } : {}),
    ...(typeof value.resumeCommand === 'string' ? { resumeCommand: value.resumeCommand } : {}),
    ...(typeof value.selectedModel === 'string' ? { selectedModel: value.selectedModel } : {}),
    ...(isChatEffort(value.effort) ? { effort: value.effort } : {}),
    ...(value.bypassAllowed === true ? { bypassAllowed: true } : {}),
    ...(models ? { models } : {}),
    ...(contextUsage ? { contextUsage } : {}),
    ...(queue?.length ? { queue } : {}),
    ...(isChatPermissionMode(value.prePlanPermissionMode) ? { prePlanPermissionMode: value.prePlanPermissionMode } : {}),
    ...(CLAUDE_CODE_SWITCHES.has(value.claudeCodeSwitch as ChatClaudeCodeSwitch) ? { claudeCodeSwitch: value.claudeCodeSwitch as ChatClaudeCodeSwitch } : {}),
  }
}

function parseItems(value: unknown): ChatItem[] | null {
  if (!Array.isArray(value)) return null
  // Keep the newest items rather than refusing a long conversation outright.
  return value.slice(-5000).map(parseChatItem).filter((item): item is ChatItem => item !== null)
}

export function parseHostMessage(value: unknown): HostToDaemonMessage | null {
  if (!isRecord(value)) return null
  switch (value.type) {
    case 'hello':
      if (!shortString(value.hostId) || typeof value.version !== 'number' || typeof value.pid !== 'number') return null
      if (value.mode !== 'pane' && value.mode !== 'shared') return null
      return { type: 'hello', hostId: value.hostId, version: value.version, mode: value.mode, pid: value.pid }
    case 'session_snapshot': {
      const session = parseChatSessionInfo(value.session)
      const items = parseItems(value.items)
      return session && items ? { type: 'session_snapshot', session, items } : null
    }
    case 'session_update': {
      const session = parseChatSessionInfo(value.session)
      return session ? { type: 'session_update', session } : null
    }
    case 'items': {
      const items = parseItems(value.items)
      return isPaneId(value.paneId) && items ? { type: 'items', paneId: value.paneId, items } : null
    }
    case 'session_closed':
      return isPaneId(value.paneId) ? { type: 'session_closed', paneId: value.paneId } : null
    case 'commands': {
      const commands = parseChatCommands(value.commands)
      return isPaneId(value.paneId) && commands ? { type: 'commands', paneId: value.paneId, commands } : null
    }
    case 'file_search_result': {
      const entries = parseFileEntries(value.entries)
      if (!isPaneId(value.paneId) || !shortString(value.requestId) || !entries) return null
      return withOptional({ type: 'file_search_result' as const, paneId: value.paneId, requestId: value.requestId, entries, truncated: value.truncated === true }, {
        error: optionalText(value.error, 1000),
      })
    }
    case 'subagent_transcript_result': {
      const items = parseItems(value.items)
      if (!isPaneId(value.paneId) || !shortString(value.requestId) || !items) return null
      return withOptional({ type: 'subagent_transcript_result' as const, paneId: value.paneId, requestId: value.requestId, items }, {
        error: optionalText(value.error, 1000),
      })
    }
    case 'handoff': {
      const queue = parseQueue(value.queue)
      const flags = Array.isArray(value.returnFlags) && value.returnFlags.length <= 64 && value.returnFlags.every((flag) => typeof flag === 'string' && flag.length <= 4096 && !flag.includes('\0'))
        ? value.returnFlags as string[]
        : null
      if (!isPaneId(value.paneId) || !shortString(value.sessionId) || !shortString(value.cwd, 4096) || !queue || !flags) return null
      return { type: 'handoff', paneId: value.paneId, sessionId: value.sessionId, cwd: value.cwd, queue, returnFlags: flags }
    }
    default:
      return null
  }
}

export function parseDaemonMessage(value: unknown): DaemonToHostMessage | null {
  if (!isRecord(value)) return null
  switch (value.type) {
    case 'welcome':
      return typeof value.version === 'number' ? { type: 'welcome', version: value.version } : null
    case 'send': {
      if (!isPaneId(value.paneId) || typeof value.text !== 'string' || value.text.length > MAX_TEXT || !shortString(value.requestId)) return null
      const images = value.images === undefined ? [] : parseChatImageRefs(value.images)
      const options = parseChatSendOptions(value)
      if (!images || !options) return null
      return withOptional({ type: 'send' as const, paneId: value.paneId, text: value.text, requestId: value.requestId, ...options }, { images: images.length ? images : undefined })
    }
    case 'queue': {
      const action = parseChatQueueAction(value)
      return isPaneId(value.paneId) && action && shortString(value.requestId) ? { type: 'queue', paneId: value.paneId, requestId: value.requestId, ...action } : null
    }
    case 'task':
      return isPaneId(value.paneId) && (value.action === 'stop' || value.action === 'background') && isAgentId(value.agentId) && shortString(value.toolUseId) && shortString(value.requestId)
        ? { type: 'task', paneId: value.paneId, action: value.action, agentId: value.agentId, toolUseId: value.toolUseId, requestId: value.requestId }
        : null
    case 'subagent_transcript':
      return isPaneId(value.paneId) && isAgentId(value.agentId) && shortString(value.requestId)
        ? { type: 'subagent_transcript', paneId: value.paneId, agentId: value.agentId, requestId: value.requestId }
        : null
    case 'file_search':
      return isPaneId(value.paneId) && typeof value.query === 'string' && value.query.length <= MAX_FILE_QUERY && shortString(value.requestId)
        ? { type: 'file_search', paneId: value.paneId, query: value.query, requestId: value.requestId }
        : null
    case 'interrupt': {
      const dropQueued = parseQueueIds(value.dropQueued)
      return isPaneId(value.paneId) && shortString(value.requestId) && dropQueued !== null
        ? withOptional({ type: 'interrupt' as const, paneId: value.paneId, requestId: value.requestId }, { dropQueued })
        : null
    }
    case 'restart':
      return isPaneId(value.paneId) && shortString(value.requestId)
        ? { type: 'restart', paneId: value.paneId, requestId: value.requestId }
        : null
    case 'configure': {
      const settings = parseChatSettingsChange(value.settings)
      return isPaneId(value.paneId) && settings && shortString(value.requestId)
        ? { type: 'configure', paneId: value.paneId, settings, requestId: value.requestId }
        : null
    }
    case 'switch':
      return isPaneId(value.paneId) && isChatSwitchAction(value.action) && shortString(value.requestId)
        ? { type: 'switch', paneId: value.paneId, action: value.action, requestId: value.requestId }
        : null
    case 'handoff_saved':
      return isPaneId(value.paneId) && typeof value.ok === 'boolean'
        ? withOptional({ type: 'handoff_saved' as const, paneId: value.paneId, ok: value.ok }, { error: optionalText(value.error, 1000) })
        : null
    case 'answer': {
      const answer = parseChatAnswer(value.answer)
      return isPaneId(value.paneId) && shortString(value.chatRequestId) && answer && shortString(value.requestId)
        ? { type: 'answer', paneId: value.paneId, chatRequestId: value.chatRequestId, answer, requestId: value.requestId }
        : null
    }
    default:
      return null
  }
}

/** Queued message ids a client names; undefined when absent, null when malformed. */
export function parseQueueIds(value: unknown): string[] | null | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length > MAX_QUEUED || !value.every((id) => shortString(id))) return null
  return value as string[]
}

/** Upserts items by id, keeping first-seen order. Returns a new array. */
export function mergeChatItems(current: readonly ChatItem[], updates: readonly ChatItem[], limit = 2000): ChatItem[] {
  if (updates.length === 0) return current as ChatItem[]
  const next = current.slice()
  const index = new Map(next.map((item, position) => [item.id, position]))
  for (const item of updates) {
    const position = index.get(item.id)
    if (position === undefined) {
      index.set(item.id, next.length)
      next.push(item)
    } else {
      next[position] = item
    }
  }
  return next.length > limit ? next.slice(next.length - limit) : next
}
