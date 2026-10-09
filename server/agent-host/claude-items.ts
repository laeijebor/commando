import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { ChatItem, ChatItemStatus, ChatQuestion, ChatRequestAnswer, ChatTodo } from '../../shared/agent-chat.js'

const MAX_OUTPUT = 20_000
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

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        const value = record(part)
        if (value.type === 'text' && typeof value.text === 'string') return value.text
        if (value.type === 'image') return '[image]'
        return ''
      })
      .filter(Boolean)
      .join('\n')
  }
  return ''
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

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never
type ToolItemFields = DistributiveOmit<Extract<ChatItem, { kind: 'command' | 'file_change' | 'tool' }>, keyof ItemBase>

/** Tool calls that render as something other than a generic tool row. */
function toolItemFields(name: string, input: unknown, toolUseId: string): ToolItemFields | null {
  const value = record(input)
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
  /** Last block index started per API message id, to key `assistant` blocks. */
  private readonly blockIndex = new Map<string, number>()
  private currentMessageId = ''
  private readonly hiddenTools = new Set(['AskUserQuestion', 'TodoWrite', 'ExitPlanMode'])

  constructor(private readonly now: () => number = Date.now) {}

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
    return item
  }

  startTurn(text: string): ChatItem[] {
    this.turnCounter += 1
    this.turnId = `turn-${this.now()}-${this.turnCounter}`
    return [this.put({ ...this.base(`user-${this.turnId}`, 'completed'), kind: 'user_message', text })]
  }

  notice(level: 'info' | 'error', text: string): ChatItem[] {
    const id = `notice-${this.now()}-${this.items.size}`
    return [this.put({ ...this.base(id, 'completed'), kind: 'notice', level, text })]
  }

  request(requestId: string, fields: { requestKind: 'approval' | 'question'; toolName: string; title: string; detail?: string; questions?: ChatQuestion[] }): ChatItem[] {
    return [this.put({ ...this.base(`request-${requestId}`, 'running'), kind: 'request', requestId, ...fields })]
  }

  resolveRequest(requestId: string, answer: ChatRequestAnswer): ChatItem[] {
    const existing = this.items.get(`request-${requestId}`)
    if (!existing || existing.kind !== 'request') return []
    const status: ChatItemStatus = answer.kind === 'cancelled' ? 'interrupted' : 'completed'
    return [this.put({ ...existing, status, answer, updatedAt: this.now() })]
  }

  /** Ends whatever is still running, e.g. after an interrupt or a crash. */
  settleRunning(status: Exclude<ChatItemStatus, 'running'>): ChatItem[] {
    const changed: ChatItem[] = []
    for (const item of this.items.values()) {
      if (item.status !== 'running') continue
      if (item.kind === 'request' && !item.answer) {
        changed.push(this.put({ ...item, status, answer: { kind: 'cancelled', reason: 'The turn ended before this was answered.' }, updatedAt: this.now() }))
      } else {
        changed.push(this.put({ ...item, status, updatedAt: this.now() }))
      }
    }
    return changed
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
        return this.settleRunning(message.subtype === 'success' ? 'completed' : 'failed')
      case 'system':
        if (message.subtype === 'compact_boundary') return this.notice('info', 'Conversation compacted')
        return []
      default:
        return []
    }
  }

  private handleStreamEvent(event: Record<string, unknown>, parent: string | null): ChatItem[] {
    switch (event.type) {
      case 'message_start':
        this.currentMessageId = str(record(event.message).id) ?? this.currentMessageId
        return []
      case 'content_block_start': {
        const index = typeof event.index === 'number' ? event.index : 0
        this.blockIndex.set(this.currentMessageId, index)
        const block = record(event.content_block) as Block
        const id = `${this.currentMessageId}:${index}`
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
        const item = this.items.get(`${this.currentMessageId}:${index}`)
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
        const index = typeof event.index === 'number' ? event.index : this.blockIndex.get(this.currentMessageId) ?? 0
        const item = this.items.get(`${this.currentMessageId}:${index}`)
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
    const lastIndex = this.blockIndex.get(message.id)
    message.content.forEach((block, position) => {
      // The SDK emits one block per assistant message; its stream index is the
      // block most recently started for this API message.
      const index = message.content.length === 1 && lastIndex !== undefined ? lastIndex : position
      const id = `${message.id}:${index}`
      if (block.type === 'text') {
        changed.push(this.put({ ...this.base(id, 'completed', parent), kind: 'assistant_message', text: block.text ?? '' }))
      } else if (block.type === 'thinking') {
        const streamed = this.items.get(id)
        const text = block.thinking || (streamed?.kind === 'reasoning' ? streamed.text : '')
        changed.push(this.put({ ...this.base(id, 'completed', parent), kind: 'reasoning', text }))
      } else if (block.type === 'tool_use' && block.id && block.name) {
        if (block.name === 'TodoWrite') {
          changed.push(this.put({ ...this.base('todo_list', 'completed', parent), kind: 'todo_list', todos: todosFromInput(block.input) }))
          return
        }
        if (this.hiddenTools.has(block.name)) return
        const fields = toolItemFields(block.name, block.input, block.id)
        if (fields) changed.push(this.put({ ...this.base(block.id, 'running', parent), ...fields } as ChatItem))
      }
    })
    return changed
  }

  private handleToolResults(message: { content: unknown }): ChatItem[] {
    if (!Array.isArray(message.content)) return []
    const changed: ChatItem[] = []
    for (const part of message.content) {
      const value = record(part)
      if (value.type !== 'tool_result' || typeof value.tool_use_id !== 'string') continue
      const item = this.items.get(value.tool_use_id)
      if (!item || (item.kind !== 'command' && item.kind !== 'file_change' && item.kind !== 'tool')) continue
      const isError = value.is_error === true
      const output = truncate(toolResultText(value.content), MAX_OUTPUT)
      changed.push(this.put({ ...item, status: isError ? 'failed' : 'completed', output, ...(isError ? { isError } : {}), updatedAt: this.now() }))
    }
    return changed
  }
}
