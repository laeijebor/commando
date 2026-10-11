/**
 * Chat panes: an agent host process runs inside a tmux pane, drives the agent
 * through its SDK, and streams typed turn items to the daemon, which relays
 * them to the web UI. Every host message names the pane it is about, so one
 * host can carry one session (per-pane mode) or many (shared mode).
 */

export const AGENT_HOST_PROTOCOL_VERSION = 2
/**
 * Hosts from this version accept `configure` and report their picker state.
 * Older hosts keep running after a merge until restarted, so check before
 * offering pickers or trusting their (missing) settings.
 */
export const CHAT_SETTINGS_HOST_VERSION = 2

export function hostTakesSettings(session: { hostVersion: number }): boolean {
  return session.hostVersion >= CHAT_SETTINGS_HOST_VERSION
}
/** WebSocket close code the daemon uses when a host does not run in the pane it claims. */
export const HOST_REFUSED_CLOSE_CODE = 4003
export const AGENT_HOST_WS_PATH = '/agent-host/ws'

export type ChatProvider = 'claude'
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
  | { kind: 'user_message'; text: string }
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
  | { kind: 'tool'; toolUseId: string; toolName: string; title: string; detail?: string; output?: string; isError?: boolean }
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

export type ChatAnswer =
  | { kind: 'approval'; decision: 'allow' | 'allow_always' | 'deny'; message?: string }
  | { kind: 'question'; answers: Record<string, string> }

export type DaemonToHostMessage =
  | { type: 'welcome'; version: number }
  | { type: 'send'; paneId: string; text: string; requestId: string }
  | { type: 'interrupt'; paneId: string; requestId: string }
  | { type: 'answer'; paneId: string; chatRequestId: string; answer: ChatAnswer; requestId: string }
  /** Restart the host on the same conversation once the current turn ends. */
  | { type: 'restart'; paneId: string; requestId: string }
  /** Switch the model, effort or permission mode for the rest of the session. */
  | { type: 'configure'; paneId: string; settings: ChatSettingsChange; requestId: string }

// ---- validation (host and client input both cross a trust boundary) ----

const PANE_ID = /^%\d+$/
const MAX_TEXT = 256 * 1024
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
        detail: optionalText(value.detail), output: optionalText(value.output), isError,
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
    default:
      return null
  }
}

export function parseChatSessionInfo(value: unknown): ChatSessionInfo | null {
  if (!isRecord(value)) return null
  if (!isPaneId(value.paneId) || value.provider !== 'claude' || typeof value.cwd !== 'string') return null
  if (!SESSION_STATUSES.has(value.status as ChatSessionStatus)) return null
  if (typeof value.hostPid !== 'number' || typeof value.hostVersion !== 'number') return null
  for (const key of ['sessionId', 'model', 'permissionMode', 'configDir', 'error', 'hostBuild', 'title', 'resumeCommand'] as const) {
    if (!optionalString(value[key], 4096)) return null
  }
  if (value.selectedModel !== undefined && !isModelValue(value.selectedModel)) return null
  if (value.effort !== undefined && !isChatEffort(value.effort)) return null
  const models = parseModels(value.models)
  const contextUsage = parseContextUsage(value.contextUsage)
  return {
    paneId: value.paneId,
    provider: 'claude',
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
    default:
      return null
  }
}

export function parseDaemonMessage(value: unknown): DaemonToHostMessage | null {
  if (!isRecord(value)) return null
  switch (value.type) {
    case 'welcome':
      return typeof value.version === 'number' ? { type: 'welcome', version: value.version } : null
    case 'send':
      return isPaneId(value.paneId) && typeof value.text === 'string' && value.text.length <= MAX_TEXT && shortString(value.requestId)
        ? { type: 'send', paneId: value.paneId, text: value.text, requestId: value.requestId }
        : null
    case 'interrupt':
    case 'restart':
      return isPaneId(value.paneId) && shortString(value.requestId)
        ? { type: value.type, paneId: value.paneId, requestId: value.requestId }
        : null
    case 'configure': {
      const settings = parseChatSettingsChange(value.settings)
      return isPaneId(value.paneId) && settings && shortString(value.requestId)
        ? { type: 'configure', paneId: value.paneId, settings, requestId: value.requestId }
        : null
    }
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
