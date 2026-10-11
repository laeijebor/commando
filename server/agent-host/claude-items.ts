import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { isAgentId, type ChatImageRef, type ChatItem, type ChatItemStatus, type ChatQuestion, type ChatRequestAnswer, type ChatSubagentState, type ChatTodo } from '../../shared/agent-chat.js'

const MAX_OUTPUT = 20_000
/** Transcript user entries that Claude Code wrote itself, not the person. */
const REPLAY_NOISE = /^\s*(?:<(?:local-command-|command-|system-reminder|task-notification|bash-|user-memory-input)|\[Request interrupted|This session is being continued from a previous conversation|Caveat: The messages below)/
/** The host keeps the latest items only; the daemon keeps the same window. */
export const MAX_HOST_ITEMS = 2000
const MAX_PATCH_LINES = 400
const MAX_DETAIL = 4_000

type Block = { type: string; id?: string; name?: string; input?: unknown; text?: string; thinking?: string }

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n… (${text.length - max} more characters)` : text
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function lineCount(text: string): number {
  if (!text) return 0
  return text.replace(/\n$/, '').split('\n').length
}

function prefixed(text: string, prefix: string): string[] {
  if (!text) return []
  return text.replace(/\n$/, '').split('\n').map((line) => `${prefix}${line}`)
}

function capPatch(lines: string[]): string {
  return lines.length > MAX_PATCH_LINES
    ? [...lines.slice(0, MAX_PATCH_LINES), `… ${lines.length - MAX_PATCH_LINES} more lines`].join('\n')
    : lines.join('\n')
}

/** Stores images found in tool results and transcripts so the UI can show them. */
export interface ChatImageSink {
  saveBase64(data: string, name?: string): ChatImageRef | undefined
}

/** The base64 data of an image content block, if it is one. */
function imageData(part: unknown): string | undefined {
  const value = record(part)
  if (value.type !== 'image') return undefined
  const source = record(value.source)
  return source.type === 'base64' ? str(source.data) : undefined
}

/**
 * Names the saved copy of an attached image in the text Claude gets, so its
 * tools can open the file (after t3code's AttachmentPrompt).
 */
export function attachmentNote(name: string, path: string): string {
  return `[Attached image "${name.replace(/["\]\r\n]/g, '_').slice(0, 120)}" is saved at: ${path}]`
}

const ATTACHMENT_NOTES = /\s*\[Attached image "[^"\n]*" is saved at: [^\]\n]+\]/g

/** The text the person typed, without the notes the host added for Claude. */
export function stripAttachmentNotes(text: string): string {
  return text.replace(ATTACHMENT_NOTES, '').trim()
}

function toolResultContent(content: unknown, images: ChatImageSink | undefined): { text: string; images: ChatImageRef[] } {
  if (typeof content === 'string') return { text: content, images: [] }
  const refs: ChatImageRef[] = []
  if (!Array.isArray(content)) return { text: '', images: refs }
  const text = content
    .map((part) => {
      const value = record(part)
      if (value.type === 'text' && typeof value.text === 'string') return value.text
      if (value.type === 'image') {
        const data = imageData(part)
        const ref = data ? images?.saveBase64(data) : undefined
        if (ref) {
          refs.push(ref)
          return ''
        }
        return '[image]'
      }
      return ''
    })
    .filter(Boolean)
    .join('\n')
  return { text, images: refs }
}

/** The text main Claude gets for a message the user relays to a subagent. */
export function relayPrompt(text: string, target: { agentId: string; label: string }): string {
  return [
    `The user wants this message relayed to your subagent "${target.label}" (agentId: ${target.agentId}).`,
    'Send it to that subagent with your SendMessage tool, word for word, then reply in one short line that you relayed it.',
    '',
    text,
  ].join('\n')
}

const RELAY_PROMPT = /^The user wants this message relayed to your subagent "([^"\n]*)" \(agentId: ([A-Za-z0-9_-]+)\)\.\nSend it to that subagent with your SendMessage tool, word for word, then reply in one short line that you relayed it\.\n\n([\s\S]*)$/

/** A relayed message as the user typed it, from the prompt the host built. */
export function parseRelayPrompt(text: string): { text: string; relayTo: { agentId: string; label: string } } | null {
  const match = RELAY_PROMPT.exec(text)
  return match ? { text: match[3]!, relayTo: { label: match[1]!, agentId: match[2]! } } : null
}

/** Short, human title for a tool call, in the spirit of t3code's work-log labels. */
export function toolTitle(name: string, input: unknown): string {
  const value = record(input)
  const path = str(value.file_path) ?? str(value.path) ?? str(value.notebook_path)
  switch (name) {
    case 'Read': return `Read ${path ?? 'file'}`
    case 'Grep': return `Search ${JSON.stringify(str(value.pattern) ?? '')}${path ? ` in ${path}` : ''}`
    case 'Glob': return `Find ${str(value.pattern) ?? 'files'}`
    case 'WebFetch': return `Fetch ${str(value.url) ?? 'page'}`
    case 'WebSearch': return `Search the web for ${JSON.stringify(str(value.query) ?? '')}`
    case 'Task':
    case 'Agent': return `Agent: ${str(value.description) ?? str(value.subagent_type) ?? 'subtask'}`
    case 'Skill': return `Skill ${str(value.skill) ?? ''}`.trim()
    case 'NotebookEdit': return `Edit notebook ${path ?? ''}`.trim()
    default: {
      const mcp = /^mcp__(.+?)__(.+)$/.exec(name)
      return mcp ? `${mcp[1]} · ${mcp[2]}` : name
    }
  }
}

function inputDetail(input: unknown): string | undefined {
  try {
    const text = JSON.stringify(input, null, 2)
    return text && text !== '{}' ? truncate(text, MAX_DETAIL) : undefined
  } catch {
    return undefined
  }
}

function fileChange(name: string, input: unknown): { path: string; additions: number; deletions: number; patch?: string } | null {
  const value = record(input)
  const path = str(value.file_path)
  if (!path) return null
  if (name === 'Write') {
    const content = str(value.content) ?? ''
    return { path, additions: lineCount(content), deletions: 0, patch: capPatch(prefixed(content, '+')) }
  }
  if (name === 'Edit') {
    const before = str(value.old_string) ?? ''
    const after = str(value.new_string) ?? ''
    return { path, additions: lineCount(after), deletions: lineCount(before), patch: capPatch([...prefixed(before, '-'), ...prefixed(after, '+')]) }
  }
  if (name === 'MultiEdit' && Array.isArray(value.edits)) {
    let additions = 0
    let deletions = 0
    const lines: string[] = []
    for (const edit of value.edits) {
      const before = str(record(edit).old_string) ?? ''
      const after = str(record(edit).new_string) ?? ''
      additions += lineCount(after)
      deletions += lineCount(before)
      if (lines.length) lines.push('@@')
      lines.push(...prefixed(before, '-'), ...prefixed(after, '+'))
    }
    return { path, additions, deletions, patch: capPatch(lines) }
  }
  return null
}

export function todosFromInput(input: unknown): ChatTodo[] {
  const todos = record(input).todos
  if (!Array.isArray(todos)) return []
  return todos.flatMap((todo) => {
    const value = record(todo)
    const content = str(value.content)?.trim()
    if (!content) return []
    const status = value.status === 'completed' || value.status === 'in_progress' ? value.status : 'pending'
    return [{ content, status }]
  })
}

export function questionsFromInput(input: unknown): ChatQuestion[] {
  const questions = record(input).questions
  if (!Array.isArray(questions)) return []
  return questions.flatMap((entry) => {
    const value = record(entry)
    const question = str(value.question)
    if (!question) return []
    const options = Array.isArray(value.options)
      ? value.options.flatMap((option) => {
          const label = str(record(option).label)
          const description = str(record(option).description)
          return label ? [{ label, ...(description ? { description } : {}) }] : []
        })
      : []
    const header = str(value.header)
    return [{ question, ...(header ? { header } : {}), options, multiSelect: value.multiSelect === true }]
  })
}

/**
 * The plan text of an ExitPlanMode call. The SDK types the input with only
 * `allowedPrompts`; the plan is an untyped `plan` string (after t3code's
 * claudeProposedPlan).
 */
export function planFromInput(input: unknown): string | null {
  const plan = record(input).plan
  return typeof plan === 'string' && plan.trim() ? plan.trim() : null
}

/** The subagent id an Agent tool result names, for reading its transcript later. */
export function agentIdFromResult(text: string): string | undefined {
  const id = /\bagentId: ([A-Za-z0-9_-]+)/.exec(text)?.[1]
  return isAgentId(id) ? id : undefined
}

/**
 * A subagent's final report without the frame Claude Code wraps it in (the
 * "[Subagent hand-back]" preamble, two-space indent, agentId and usage lines).
 */
export function subagentReport(text: string): string {
  const marker = 'The report follows:\n'
  const start = text.startsWith('[Subagent hand-back]') ? text.indexOf(marker) : -1
  if (start < 0) return text
  return text
    .slice(start + marker.length)
    .replace(/\nagentId: [\s\S]*$/, '')
    .split('\n')
    .map((line) => line.replace(/^ {2}/, ''))
    .join('\n')
    .trim()
}

/** What a stopped or interrupted Agent call leaves as its result. */
const STOPPED_RESULT = /^\s*\[Request interrupted/

/** An Agent result that only says the subagent went on in the background. */
const BACKGROUND_RESULT = /^\s*(?:Async agent launched|.{0,200}running in the background)/i

/** Fields of `<task-notification>` text, which a resumed transcript holds instead of task events. */
export function taskNotificationFromText(text: string): { taskId: string; toolUseId?: string; status: string; summary?: string } | null {
  if (!text.trimStart().startsWith('<task-notification>')) return null
  const field = (name: string) => new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(text)?.[1]?.trim()
  const taskId = field('task-id')
  const status = field('status')
  if (!taskId || !status) return null
  const toolUseId = field('tool-use-id')
  const summary = field('summary')
  return { taskId, status, ...(toolUseId ? { toolUseId } : {}), ...(summary ? { summary } : {}) }
}

const SUBAGENT_TOOLS = new Set(['Agent', 'Task'])

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never
type ToolItemFields = DistributiveOmit<Extract<ChatItem, { kind: 'command' | 'file_change' | 'tool' | 'subagent' }>, keyof ItemBase>

/** Tool calls that render as something other than a generic tool row. */
function toolItemFields(name: string, input: unknown, toolUseId: string): ToolItemFields | null {
  const value = record(input)
  if (SUBAGENT_TOOLS.has(name)) {
    const subagentType = str(value.subagent_type)
    const prompt = str(value.prompt)
    return {
      kind: 'subagent',
      toolUseId,
      description: str(value.description) ?? subagentType ?? 'Subagent',
      state: 'running',
      ...(subagentType ? { subagentType } : {}),
      ...(prompt ? { prompt: truncate(prompt, 16_000) } : {}),
      ...(value.run_in_background === true ? { background: true } : {}),
    }
  }
  if (name === 'Bash') {
    const description = str(value.description)
    return { kind: 'command', toolUseId, command: str(value.command) ?? '', ...(description ? { description } : {}) }
  }
  const change = fileChange(name, input)
  if (change) return { kind: 'file_change', toolUseId, toolName: name, ...change }
  const detail = inputDetail(input)
  return { kind: 'tool', toolUseId, toolName: name, title: toolTitle(name, input), ...(detail ? { detail } : {}) }
}

type ItemBase = { id: string; turnId: string; parentToolUseId?: string; status: ChatItemStatus; createdAt: number; updatedAt: number }

/**
 * Turns the SDK's message stream into chat items. Text streams in through
 * `stream_event` deltas and is then confirmed by the `assistant` message for
 * the same block; tool calls are keyed by their tool_use id so results and
 * permission requests land on the same item.
 */
export class ClaudeItemMapper {
  private readonly items = new Map<string, ChatItem>()
  private turnId = 'turn-0'
  private turnCounter = 0
  private noticeCounter = 0
  /** Open API message per stream (main agent or a subagent's tool_use id). */
  private readonly currentMessage = new Map<string, string>()
  /**
   * Blocks already confirmed by `assistant` messages, per API message id. The
   * SDK confirms blocks in stream order, so this count is the next block's
   * stream index, with or without stream events.
   */
  private readonly confirmedBlocks = new Map<string, number>()
  private readonly hiddenTools = new Set(['AskUserQuestion', 'TodoWrite', 'ExitPlanMode'])
  /** Subagent item (its Agent tool_use id) per task id; a SendMessage resume reuses the task id. */
  private readonly subagentByTask = new Map<string, string>()

  constructor(private readonly now: () => number = Date.now, private readonly images?: ChatImageSink) {}

  list(): ChatItem[] {
    return [...this.items.values()]
  }

  get currentTurnId(): string {
    return this.turnId
  }

  private base(id: string, status: ChatItemStatus, parentToolUseId?: string | null): ItemBase {
    const at = this.now()
    const existing = this.items.get(id)
    return {
      id,
      turnId: existing?.turnId ?? this.turnId,
      ...(parentToolUseId ? { parentToolUseId } : existing?.parentToolUseId ? { parentToolUseId: existing.parentToolUseId } : {}),
      status,
      createdAt: existing?.createdAt ?? at,
      updatedAt: at,
    }
  }

  private put(item: ChatItem): ChatItem {
    this.items.set(item.id, item)
    if (this.items.size > MAX_HOST_ITEMS) {
      const oldest = this.items.keys().next().value
      if (oldest !== undefined) this.items.delete(oldest)
    }
    return item
  }

  startTurn(text: string, images: ChatImageRef[] = [], extra: { steered?: true; relayTo?: { agentId: string; label: string } } = {}): ChatItem[] {
    this.turnCounter += 1
    this.turnId = `turn-${this.now()}-${this.turnCounter}`
    return [this.put({ ...this.base(`user-${this.turnId}`, 'completed'), kind: 'user_message', text, ...(images.length ? { images } : {}), ...extra })]
  }

  notice(level: 'info' | 'error', text: string): ChatItem[] {
    this.noticeCounter += 1
    const id = `notice-${this.noticeCounter}`
    return [this.put({ ...this.base(id, 'completed'), kind: 'notice', level, text })]
  }

  /**
   * A permission request. One from a subagent (`agentId`) belongs to its Agent
   * call, so a background subagent's request outlives the main turn's end.
   */
  request(requestId: string, agentId: string | undefined, fields: { requestKind: 'approval' | 'question'; toolName: string; title: string; detail?: string; questions?: ChatQuestion[] }): ChatItem[] {
    const parent = agentId ? this.subagentByTask.get(agentId) : undefined
    return [this.put({ ...this.base(`request-${requestId}`, 'running', parent), kind: 'request', requestId, ...fields })]
  }

  resolveRequest(requestId: string, answer: ChatRequestAnswer): ChatItem[] {
    const existing = this.items.get(`request-${requestId}`)
    if (!existing || existing.kind !== 'request') return []
    const status: ChatItemStatus = answer.kind === 'cancelled' ? 'interrupted' : 'completed'
    return [this.put({ ...existing, status, answer, updatedAt: this.now() })]
  }

  /** A plan Claude proposed with ExitPlanMode; one per call, so a repeat upserts. */
  plan(toolUseId: string, text: string, parentToolUseId?: string | null): ChatItem[] {
    return [this.put({ ...this.base(`plan-${toolUseId}`, 'completed', parentToolUseId), kind: 'plan', toolUseId, text })]
  }

  /**
   * Ends whatever is still running, e.g. after an interrupt or a crash. At the
   * end of a turn (`keepBackground`), background subagents and their work go
   * on: their own task events finish them.
   */
  settleRunning(status: Exclude<ChatItemStatus, 'running'>, options: { keepBackground?: boolean } = {}): ChatItem[] {
    const changed: ChatItem[] = []
    for (const item of this.items.values()) {
      if (item.status !== 'running') continue
      if (options.keepBackground && this.inBackground(item)) continue
      if (item.kind === 'subagent') {
        changed.push(this.put({ ...item, status, state: status === 'failed' ? 'failed' : status === 'completed' ? 'completed' : 'stopped', updatedAt: this.now() }))
        continue
      }
      if (item.kind === 'request' && !item.answer) {
        changed.push(this.put({ ...item, status, answer: { kind: 'cancelled', reason: 'The turn ended before this was answered.' }, updatedAt: this.now() }))
      } else {
        changed.push(this.put({ ...item, status, updatedAt: this.now() }))
      }
    }
    return changed
  }

  /** True for a running background subagent and anything inside one. */
  private inBackground(item: ChatItem): boolean {
    for (let current: ChatItem | undefined = item, depth = 0; current && depth < 8; depth += 1) {
      if (current.kind === 'subagent' && current.status === 'running' && current.background) return true
      current = current.parentToolUseId ? this.items.get(current.parentToolUseId) : undefined
    }
    return false
  }

  /**
   * Rebuilds items from a saved transcript (getSessionMessages) so a resumed
   * conversation shows its earlier turns. Everything replayed is finished.
   */
  replay(messages: readonly { type: string; message: unknown; parent_tool_use_id: string | null }[]): ChatItem[] {
    for (const entry of messages) {
      const message = record(entry.message)
      if (entry.type === 'assistant' && typeof message.id === 'string' && Array.isArray(message.content)) {
        this.handleAssistant(message as unknown as { id: string; content: Block[] }, entry.parent_tool_use_id)
      } else if (entry.type === 'user' && !entry.parent_tool_use_id) {
        const text = typeof message.content === 'string'
          ? message.content
          : Array.isArray(message.content)
            ? message.content.map((part) => record(part).type === 'text' ? str(record(part).text) ?? '' : '').join('\n')
            : ''
        const notification = taskNotificationFromText(text)
        if (notification) {
          this.updateSubagent(notification.taskId, notification.toolUseId, {
            state: notificationState(notification.status),
            ...(notification.summary ? { summary: notification.summary } : {}),
          })
        } else if (Array.isArray(message.content) && message.content.some((part) => record(part).type === 'tool_result')) {
          this.handleToolResults(message as { content: unknown })
        } else if (!REPLAY_NOISE.test(text)) {
          const blocks = Array.isArray(message.content) ? message.content.filter((part) => record(part).type === 'image') : []
          const images = this.saveImages(blocks)
          const relayed = parseRelayPrompt(text)
          const typed = stripAttachmentNotes(relayed?.text ?? text)
          // An image that can't be shown still marks the turn, so it isn't lost from the timeline.
          if (typed || blocks.length) this.startTurn(typed || (images.length ? '' : '[image]'), images, relayed ? { relayTo: relayed.relayTo } : {})
        }
      } else if (entry.type === 'user') {
        this.handleToolResults(message as { content: unknown })
      }
    }
    // A tool call that never got a result was cut off when the session ended.
    this.settleRunning('interrupted')
    return this.list()
  }

  handle(message: SDKMessage): ChatItem[] {
    switch (message.type) {
      case 'stream_event':
        return this.handleStreamEvent(message.event as unknown as Record<string, unknown>, message.parent_tool_use_id)
      case 'assistant':
        return this.handleAssistant(message.message as unknown as { id: string; content: Block[] }, message.parent_tool_use_id)
      case 'user':
        return this.handleToolResults(message.message as unknown as { content: unknown })
      case 'result':
        return this.settleRunning(message.subtype === 'success' ? 'completed' : 'failed', { keepBackground: true })
      case 'system':
        if (message.subtype === 'compact_boundary') return this.notice('info', 'Conversation compacted')
        if (message.subtype === 'task_started' || message.subtype === 'task_progress' || message.subtype === 'task_updated' || message.subtype === 'task_notification') {
          return this.handleTask(message)
        }
        return []
      case 'conversation_reset':
        // /clear: Claude carries on in a fresh conversation; the earlier turns stay visible above.
        return this.notice('info', 'Context cleared: Claude starts a new conversation from here')
      default:
        return []
    }
  }

  private handleStreamEvent(event: Record<string, unknown>, parent: string | null): ChatItem[] {
    switch (event.type) {
      case 'message_start': {
        const id = str(record(event.message).id)
        if (id) this.currentMessage.set(parent ?? '', id)
        return []
      }
      case 'content_block_start': {
        const messageId = this.currentMessage.get(parent ?? '') ?? ''
        const index = typeof event.index === 'number' ? event.index : 0
        const block = record(event.content_block) as Block
        const id = `${messageId}:${index}`
        if (block.type === 'text') return [this.put({ ...this.base(id, 'running', parent), kind: 'assistant_message', text: block.text ?? '' })]
        if (block.type === 'thinking') return [this.put({ ...this.base(id, 'running', parent), kind: 'reasoning', text: block.thinking ?? '' })]
        if (block.type === 'tool_use' && block.id && block.name && !this.hiddenTools.has(block.name)) {
          const fields = toolItemFields(block.name, {}, block.id)
          if (!fields) return []
          return [this.put({ ...this.base(block.id, 'running', parent), ...fields } as ChatItem)]
        }
        return []
      }
      case 'content_block_delta': {
        const index = typeof event.index === 'number' ? event.index : 0
        const delta = record(event.delta)
        const item = this.items.get(`${this.currentMessage.get(parent ?? '') ?? ''}:${index}`)
        if (!item) return []
        if (delta.type === 'text_delta' && item.kind === 'assistant_message' && typeof delta.text === 'string') {
          return [this.put({ ...item, text: item.text + delta.text, updatedAt: this.now() })]
        }
        if (delta.type === 'thinking_delta' && item.kind === 'reasoning' && typeof delta.thinking === 'string' && delta.thinking) {
          return [this.put({ ...item, text: item.text + delta.thinking, updatedAt: this.now() })]
        }
        return []
      }
      case 'content_block_stop': {
        if (typeof event.index !== 'number') return []
        const item = this.items.get(`${this.currentMessage.get(parent ?? '') ?? ''}:${event.index}`)
        if (item && item.status === 'running' && (item.kind === 'assistant_message' || item.kind === 'reasoning')) {
          return [this.put({ ...item, status: 'completed', updatedAt: this.now() })]
        }
        return []
      }
      default:
        return []
    }
  }

  private handleAssistant(message: { id: string; content: Block[] }, parent: string | null): ChatItem[] {
    const changed: ChatItem[] = []
    const first = this.confirmedBlocks.get(message.id) ?? 0
    this.confirmedBlocks.set(message.id, first + message.content.length)
    if (this.confirmedBlocks.size > 500) {
      const oldest = this.confirmedBlocks.keys().next().value
      if (oldest !== undefined && oldest !== message.id) this.confirmedBlocks.delete(oldest)
    }
    message.content.forEach((block, position) => {
      const id = `${message.id}:${first + position}`
      if (block.type === 'text') {
        changed.push(this.put({ ...this.base(id, 'completed', parent), kind: 'assistant_message', text: block.text ?? '' }))
      } else if (block.type === 'thinking') {
        const streamed = this.items.get(id)
        const text = block.thinking || (streamed?.kind === 'reasoning' ? streamed.text : '')
        changed.push(this.put({ ...this.base(id, 'completed', parent), kind: 'reasoning', text }))
      } else if (block.type === 'tool_use' && block.id && block.name) {
        if (block.name === 'TodoWrite') {
          // One list per turn (and per subagent), updated in place as it changes.
          changed.push(this.put({ ...this.base(`todo_list:${this.turnId}:${parent ?? ''}`, 'completed', parent), kind: 'todo_list', todos: todosFromInput(block.input) }))
          return
        }
        if (block.name === 'ExitPlanMode') {
          const plan = planFromInput(block.input)
          if (plan) changed.push(...this.plan(block.id, plan, parent))
          return
        }
        if (this.hiddenTools.has(block.name)) return
        const fields = toolItemFields(block.name, block.input, block.id)
        if (!fields) return
        const existing = this.items.get(block.id)
        // A task event can land first; keep what it reported.
        const merged = fields.kind === 'subagent' && existing?.kind === 'subagent'
          ? { ...fields, ...pickDefined(existing, ['agentId', 'state', 'toolUses', 'durationMs', 'totalTokens', 'lastToolName', 'summary', 'output']), background: Boolean(fields.background || existing.background) || undefined }
          : fields
        changed.push(this.put({ ...this.base(block.id, existing?.status ?? 'running', parent), ...merged } as ChatItem))
      }
    })
    return changed
  }

  private saveImages(content: unknown[]): ChatImageRef[] {
    if (!this.images) return []
    return content.flatMap((part) => {
      const data = imageData(part)
      const ref = data ? this.images!.saveBase64(data) : undefined
      return ref ? [ref] : []
    })
  }

  private handleToolResults(message: { content: unknown }): ChatItem[] {
    if (!Array.isArray(message.content)) return []
    const changed: ChatItem[] = []
    for (const part of message.content) {
      const value = record(part)
      if (value.type !== 'tool_result' || typeof value.tool_use_id !== 'string') continue
      const item = this.items.get(value.tool_use_id)
      if (!item) continue
      const isError = value.is_error === true
      const result = toolResultContent(value.content, this.images)
      const output = truncate(result.text, MAX_OUTPUT)
      if (item.kind === 'subagent') {
        changed.push(this.subagentResult(item, result.text, isError))
        continue
      }
      if (item.kind !== 'command' && item.kind !== 'file_change' && item.kind !== 'tool') continue
      const images = item.kind === 'tool' && result.images.length ? { images: result.images } : {}
      changed.push(this.put({ ...item, status: isError ? 'failed' : 'completed', output, ...(isError ? { isError } : {}), ...images, updatedAt: this.now() } as ChatItem))
    }
    return changed
  }

  private subagentResult(item: Extract<ChatItem, { kind: 'subagent' }>, text: string, isError: boolean): ChatItem {
    const agentId = item.agentId ?? agentIdFromResult(text)
    if (agentId) this.subagentByTask.set(agentId, item.id)
    if (!isError && BACKGROUND_RESULT.test(text)) {
      // The subagent goes on; its task events (or notification) finish it.
      return this.put({ ...item, ...(agentId ? { agentId } : {}), background: true, updatedAt: this.now() })
    }
    // A task notification may already have said how it ended; a stopped one reads as interrupted.
    const state: ChatSubagentState = item.state !== 'running' ? item.state : isError ? (STOPPED_RESULT.test(text) ? 'stopped' : 'failed') : 'completed'
    // A resumed transcript has no task events; the report's usage trailer stands in for them.
    const toolUses = item.toolUses ?? usageField(text, 'tool_uses')
    const durationMs = item.durationMs ?? usageField(text, 'duration_ms')
    return this.put({
      ...item,
      ...(agentId ? { agentId } : {}),
      ...(toolUses !== undefined ? { toolUses } : {}),
      ...(durationMs !== undefined ? { durationMs } : {}),
      state,
      status: itemStatus(state),
      output: truncate(subagentReport(text), MAX_OUTPUT),
      updatedAt: this.now(),
    })
  }

  private handleTask(message: Extract<SDKMessage, { type: 'system'; subtype: 'task_started' | 'task_progress' | 'task_updated' | 'task_notification' }>): ChatItem[] {
    switch (message.subtype) {
      case 'task_started': {
        // Shells and monitors are tasks too; only subagents get a row.
        const known = this.subagentByTask.has(message.task_id) || this.items.get(message.tool_use_id ?? '')?.kind === 'subagent'
        if (!known && !message.subagent_type && message.task_type !== 'local_agent') return []
        return this.updateSubagent(message.task_id, message.tool_use_id, {
          state: 'running',
          ...(message.is_backgrounded ? { background: true } : {}),
          ...(message.subagent_type ? { subagentType: message.subagent_type } : {}),
        }, message.description, message.prompt)
      }
      case 'task_progress':
        return this.updateSubagent(message.task_id, message.tool_use_id, {
          toolUses: message.usage.tool_uses,
          durationMs: message.usage.duration_ms,
          totalTokens: message.usage.total_tokens,
          ...(message.last_tool_name ? { lastToolName: message.last_tool_name } : {}),
          // Claude's own summary when it makes one, else what the subagent is doing.
          summary: message.summary || message.description,
        }, undefined, undefined, false)
      case 'task_updated': {
        const status = message.patch.status
        const state: ChatSubagentState | undefined = status === 'completed' ? 'completed' : status === 'failed' ? 'failed' : status === 'killed' ? 'stopped' : undefined
        return this.updateSubagent(message.task_id, undefined, {
          ...(state ? { state } : {}),
          ...(message.patch.is_backgrounded ? { background: true } : {}),
          ...(message.patch.error ? { summary: message.patch.error } : {}),
        }, undefined, undefined, false)
      }
      case 'task_notification':
        return this.updateSubagent(message.task_id, message.tool_use_id, {
          state: notificationState(message.status),
          ...(message.summary ? { summary: message.summary } : {}),
          ...(message.usage ? { toolUses: message.usage.tool_uses, durationMs: message.usage.duration_ms, totalTokens: message.usage.total_tokens } : {}),
        }, undefined, undefined, false)
    }
  }

  /**
   * Applies a task event to its subagent row: found by task id, else by the
   * Agent call it names. `create` lets task_started add a row for an Agent
   * call the mapper hasn't seen (its tool_use can arrive after the event).
   */
  private updateSubagent(
    taskId: string,
    toolUseId: string | undefined,
    patch: Partial<Extract<ChatItem, { kind: 'subagent' }>>,
    description?: string,
    prompt?: string,
    create = true,
  ): ChatItem[] {
    const id = this.subagentByTask.get(taskId) ?? toolUseId
    if (!id) return []
    const existing = this.items.get(id)
    if (existing && existing.kind !== 'subagent') return []
    if (!existing && !create) return []
    if (!isAgentId(taskId)) return []
    this.subagentByTask.set(taskId, id)
    if (this.subagentByTask.size > 500) {
      const oldest = this.subagentByTask.keys().next().value
      if (oldest !== undefined && oldest !== taskId) this.subagentByTask.delete(oldest)
    }
    const current: Extract<ChatItem, { kind: 'subagent' }> = existing ?? {
      ...this.base(id, 'running'), kind: 'subagent', toolUseId: id, description: description ?? 'Subagent', state: 'running',
    }
    const state = patch.state ?? current.state
    const next = {
      ...current,
      ...patch,
      agentId: taskId,
      ...(!current.prompt && prompt ? { prompt: truncate(prompt, 16_000) } : {}),
      // A resumed subagent runs again until its next notification.
      status: itemStatus(state),
      updatedAt: this.now(),
    }
    return [this.put(next)]
  }
}

/** A number from the `<usage>` trailer of a subagent's report. */
function usageField(text: string, name: 'tool_uses' | 'duration_ms'): number | undefined {
  const value = new RegExp(`<usage>[\\s\\S]*?\\b${name}: (\\d+)`).exec(text)?.[1]
  return value === undefined ? undefined : Number(value)
}

function itemStatus(state: ChatSubagentState): ChatItemStatus {
  return state === 'running' ? 'running' : state === 'completed' ? 'completed' : state === 'failed' ? 'failed' : 'interrupted'
}

function notificationState(status: string): ChatSubagentState {
  return status === 'completed' ? 'completed' : status === 'failed' ? 'failed' : 'stopped'
}

function pickDefined<T extends object, K extends keyof T>(value: T, keys: K[]): Partial<Pick<T, K>> {
  const picked: Partial<Pick<T, K>> = {}
  for (const key of keys) if (value[key] !== undefined) picked[key] = value[key]
  return picked
}
