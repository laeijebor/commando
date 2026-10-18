import type { ChatImageRef, ChatItem, ChatItemStatus, ChatQuestion, ChatRequestAnswer, ChatTodo } from '../../../shared/agent-chat.js'
import { record } from '../rpc-client.js'

const MAX_TEXT = 200_000
const string = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : []
const text = (value: unknown) => (string(value) ?? '').slice(0, MAX_TEXT)
const number = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : 0

/** Muse's end-of-turn reminder checks and hook runs are its own bookkeeping, not the conversation. */
const HIDDEN_KINDS = new Set(['reminderChild', 'hookRun'])

function status(value: unknown): ChatItemStatus {
  if (value === 'inProgress') return 'running'
  if (value === 'completed') return 'completed'
  if (value === 'cancelled' || value === 'rejected') return 'interrupted'
  return 'failed'
}

function parseArgs(value: unknown): Record<string, unknown> {
  try { return record(JSON.parse(string(value) ?? '')) } catch { return {} }
}

function pretty(value: Record<string, unknown>, raw: unknown): string {
  if (!Object.keys(value).length) return text(raw)
  try { return JSON.stringify(value, null, 2).slice(0, MAX_TEXT) } catch { return '' }
}

export function museTodos(value: unknown): ChatTodo[] {
  return list(value).flatMap((value) => {
    const entry = record(value)
    const content = string(entry.text)
    if (!content) return []
    const state: ChatTodo['status'] = entry.status === 'completed' ? 'completed' : entry.status === 'inProgress' ? 'in_progress' : 'pending'
    return [{ content, status: state }]
  })
}

export interface MuseQuestion { id: string; question: ChatQuestion }
export function museQuestions(value: unknown): MuseQuestion[] {
  return list(value).flatMap((value) => {
    const entry = record(value)
    if (!string(entry.id) || !string(entry.question)) return []
    return [{ id: entry.id as string, question: {
      question: entry.question as string,
      ...(string(entry.header) ? { header: entry.header as string } : {}),
      multiSelect: record(entry.selection).mode === 'multiple',
      options: list(entry.options).flatMap((value) => {
        const option = record(value)
        return string(option.label) ? [{ label: option.label as string, ...(string(option.description) ? { description: option.description as string } : {}) }] : []
      }),
    } }]
  })
}

/** What an approval asks to do, in a line or two. */
function approvalDetail(params: Record<string, unknown>): string {
  const subject = record(params.subject)
  const stages = list(subject.stages).map((stage) => list(record(stage).argv).filter((word) => typeof word === 'string').join(' ')).filter(Boolean)
  return [string(subject.command) ?? stages.join(' | '), string(subject.path), string(subject.host) && `${subject.host}${typeof subject.port === 'number' ? `:${subject.port}` : ''}`, string(subject.target)]
    .filter(Boolean).join('\n').slice(0, MAX_TEXT)
}

/** Upserts live and resumed MSP items under their own ids. */
export class MuseItemMapper {
  private readonly items = new Map<string, ChatItem>()
  /** MSP item ids that render nothing, so their deltas are ignored too. */
  private readonly hidden = new Set<string>()
  private readonly revisions = new Map<string, number>()
  private readonly summaries = new Map<string, string[]>()
  private readonly expectedUsers: { text: string; images: ChatImageRef[] }[] = []
  private counter = 0
  private turnId = 'muse-start'
  constructor(private readonly now: () => number = Date.now) {}
  list(): ChatItem[] { return [...this.items.values()] }
  setTurn(turnId: string): void { this.turnId = turnId }
  expectUser(text: string, images: ChatImageRef[]): void {
    this.expectedUsers.push({ text, images })
    if (this.expectedUsers.length > 100) this.expectedUsers.shift()
  }
  forgetUser(text: string): void {
    const index = this.expectedUsers.findIndex((entry) => entry.text === text)
    if (index >= 0) this.expectedUsers.splice(index, 1)
  }
  private base(id: string, turnId: string, state: ChatItemStatus) {
    const previous = this.items.get(id)
    return { id, turnId, status: state, createdAt: previous?.createdAt ?? this.now(), updatedAt: this.now() }
  }
  private put(item: ChatItem): ChatItem {
    this.items.set(item.id, item)
    if (this.items.size > 5000) {
      const oldest = this.items.keys().next().value
      if (oldest !== undefined) this.items.delete(oldest)
    }
    return item
  }
  notice(level: 'info' | 'error', message: string, turnId = this.turnId): ChatItem[] {
    return [this.put({ ...this.base(`muse-notice-${++this.counter}`, turnId, 'completed'), kind: 'notice', level, text: message.slice(0, MAX_TEXT) })]
  }
  todos(value: unknown, turnId = this.turnId): ChatItem[] {
    return [this.put({ ...this.base(`muse:${turnId}:todos`, turnId, 'completed'), kind: 'todo_list', todos: museTodos(value) })]
  }
  approval(key: string, params: Record<string, unknown>): ChatItem[] {
    const toolName = string(params.toolName) ?? 'tool'
    return [this.put({ ...this.base(`request-${key}`, string(params.turnId) ?? this.turnId, 'running'), kind: 'request', requestId: key,
      requestKind: 'approval', toolName, title: `Allow ${toolName}?`, detail: approvalDetail(params) })]
  }
  question(key: string, params: Record<string, unknown>): ChatItem[] {
    return [this.put({ ...this.base(`request-${key}`, string(params.turnId) ?? this.turnId, 'running'), kind: 'request', requestId: key,
      requestKind: 'question', toolName: string(params.toolName) ?? 'request_user_input', title: 'Muse is asking',
      questions: museQuestions(params.questions).map((entry) => entry.question) })]
  }
  resolveRequest(key: string, answer: ChatRequestAnswer): ChatItem[] {
    const existing = this.items.get(`request-${key}`)
    if (!existing || existing.kind !== 'request' || existing.answer) return []
    return [this.put({ ...existing, answer, status: answer.kind === 'cancelled' ? 'interrupted' : 'completed', updatedAt: this.now() })]
  }
  settle(turnId: string | undefined, state: Exclude<ChatItemStatus, 'running'>): ChatItem[] {
    return [...this.items.values()].flatMap((item) => {
      if (item.status !== 'running' || (turnId && item.turnId !== turnId)) return []
      return [this.put({
        ...item, status: state, updatedAt: this.now(),
        ...(item.kind === 'request' && !item.answer ? { answer: { kind: 'cancelled' as const, reason: 'The turn ended before this was answered.' } } : {}),
      })]
    })
  }
  /**
   * Applies an MSP item. Only a higher revision replaces one already applied: deltas do not bump
   * the revision, so a redelivered equal revision would drop the text streamed since.
   */
  item(raw: unknown): ChatItem[] {
    const item = record(raw)
    const itemId = string(item.itemId)
    const kind = string(item.kind)
    if (!itemId || !kind) return []
    if (HIDDEN_KINDS.has(kind)) { this.hidden.add(itemId); return [] }
    const revision = number(item.revision)
    if (revision && revision <= (this.revisions.get(itemId) ?? 0)) return []
    if (revision) this.revisions.set(itemId, revision)
    const turnId = string(item.turnId) ?? this.turnId
    const id = `muse:${itemId}`
    const previous = this.items.get(id)
    const state = status(item.status)
    const base = this.base(id, turnId, state)
    switch (kind) {
      case 'userMessage': {
        if (item.retracted === true) { this.items.delete(id); return [] }
        const message = text(item.displayText ?? item.text)
        const expectedIndex = this.expectedUsers.findIndex((entry) => entry.text === message || entry.text === text(item.text))
        const expected = expectedIndex >= 0 ? this.expectedUsers.splice(expectedIndex, 1)[0] : undefined
        const images = expected?.images ?? (previous?.kind === 'user_message' ? previous.images : undefined)
        return [this.put({ ...base, kind: 'user_message', status: 'completed', text: expected?.text ?? message,
          ...(images?.length ? { images } : {}), ...(item.steered === true ? { steered: true } : {}) })]
      }
      case 'agentMessage': {
        const value = text(item.text) || (previous?.kind === 'assistant_message' ? previous.text : '')
        return [this.put({ ...base, kind: 'assistant_message', text: value })]
      }
      case 'reasoning': {
        const summary = list(item.summary).map(text)
        if (summary.length) this.summaries.set(id, summary)
        const value = summary.join('\n\n') || text(item.text) || (previous?.kind === 'reasoning' ? previous.text : '')
        return [this.put({ ...base, kind: 'reasoning', text: value })]
      }
      case 'toolCall': return [this.put(this.toolCall(base, itemId, item, previous))]
      case 'compaction': return state === 'running' ? [] : this.notice('info', 'Muse compacted the conversation to free up context.', turnId)
      default: {
        const title = text(item.fallbackText ?? item.objective) || kind
        return [this.put({ ...base, kind: 'tool', toolUseId: itemId, toolName: kind, title: title.slice(0, 400),
          ...(string(item.finalSummary ?? item.message) ? { output: text(item.finalSummary ?? item.message) } : {}),
          ...(state === 'failed' ? { isError: true } : {}) })]
      }
    }
  }
  private toolCall(base: ReturnType<MuseItemMapper['base']>, itemId: string, item: Record<string, unknown>, previous: ChatItem | undefined): ChatItem {
    const tool = string(item.tool) ?? 'tool'
    const args = parseArgs(item.args)
    const output = string(item.visibleOutput)?.slice(-MAX_TEXT) ?? (previous && 'output' in previous ? previous.output : undefined)
    const failed = base.status === 'failed'
    if (tool === 'bash' || tool === 'shell') {
      return { ...base, kind: 'command', toolUseId: itemId, command: text(args.command ?? args.cmd).slice(0, 16384) || (previous?.kind === 'command' ? previous.command : ''),
        ...(string(args.description) ? { description: args.description as string } : {}), ...(output !== undefined ? { output } : {}), ...(failed ? { isError: true } : {}) }
    }
    const path = string(args.path ?? args.file_path ?? args.filePath)
    if ((tool === 'edit_file' || tool === 'write_file' || tool === 'apply_patch') && path) {
      const summary = record(item.patchSummary)
      return { ...base, kind: 'file_change', toolUseId: itemId, toolName: tool, path, additions: number(summary.added), deletions: number(summary.removed),
        ...(output !== undefined ? { output } : {}), ...(failed ? { isError: true } : {}) }
    }
    const label = record(item.displayLabel)
    const title = (base.status === 'running' ? string(label.active) : string(label.done)) ?? string(label.neutral) ?? (path ? `${tool} ${path}` : tool)
    return { ...base, kind: 'tool', toolUseId: itemId, toolName: tool, title: title.slice(0, 400), detail: pretty(args, item.args),
      ...(output !== undefined ? { output } : {}), ...(failed || string(item.failureReason) ? { isError: true } : {}) }
  }
  /** Streams text into an item that `item/started` opened. */
  delta(params: Record<string, unknown>): ChatItem[] {
    const itemId = string(params.itemId)
    if (!itemId || this.hidden.has(itemId)) return []
    const id = `muse:${itemId}`
    const previous = this.items.get(id)
    if (!previous || previous.status !== 'running') return []
    const field = string(params.field) ?? 'text'
    const delta = text(params.delta)
    if (field === 'text' && (previous.kind === 'assistant_message' || previous.kind === 'reasoning')) {
      return [this.put({ ...previous, text: `${previous.text}${delta}`.slice(0, MAX_TEXT), updatedAt: this.now() })]
    }
    const part = /^summary\.(\d+)$/.exec(field)
    if (part && previous.kind === 'reasoning') {
      const summary = [...(this.summaries.get(id) ?? [])]
      const index = Number(part[1])
      summary[index] = `${summary[index] ?? ''}${delta}`.slice(0, MAX_TEXT)
      this.summaries.set(id, summary)
      return [this.put({ ...previous, text: summary.filter((value) => value !== undefined).join('\n\n'), updatedAt: this.now() })]
    }
    if (field === 'output' && (previous.kind === 'command' || previous.kind === 'tool' || previous.kind === 'file_change')) {
      return [this.put({ ...previous, output: `${previous.output ?? ''}${delta}`.slice(-MAX_TEXT), updatedAt: this.now() })]
    }
    return []
  }
}
