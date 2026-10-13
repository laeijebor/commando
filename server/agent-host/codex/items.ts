import { createHash } from 'node:crypto'
import type { ChatImageRef, ChatItem, ChatItemStatus, ChatQuestion, ChatRequestAnswer, ChatTodo } from '../../../shared/agent-chat.js'
import { list, record, requestKey, rpcId, string, type CodexTurn, type RpcNotification, type RpcRequest } from './protocol.js'

const MAX_TEXT = 200_000
const text = (value: unknown) => (string(value) ?? '').slice(0, MAX_TEXT)
function detail(value: unknown): string {
  try { return (JSON.stringify(value, null, 2) ?? '').slice(0, MAX_TEXT) } catch { return '' }
}
function status(value: unknown, complete: true): Exclude<ChatItemStatus, 'running'>
function status(value: unknown, complete: boolean): ChatItemStatus
function status(value: unknown, complete: boolean): ChatItemStatus {
  return value === 'failed' ? 'failed' : value === 'declined' || value === 'interrupted' ? 'interrupted' : complete ? 'completed' : 'running'
}
function todos(value: unknown): ChatTodo[] {
  return list(value).flatMap((value) => {
    const entry = record(value)
    const content = string(entry.step) ?? string(entry.content)
    return content ? [{ content, status: entry.status === 'completed' ? 'completed' : entry.status === 'inProgress' || entry.status === 'in_progress' ? 'in_progress' : 'pending' }] : []
  })
}
export function inputQuestions(value: unknown): { id: string; question: ChatQuestion }[] {
  return list(value).flatMap((value) => {
    const entry = record(value)
    if (!string(entry.id) || !string(entry.question)) return []
    return [{ id: entry.id as string, question: {
      question: entry.question as string,
      ...(string(entry.header) ? { header: entry.header as string } : {}),
      multiSelect: false,
      options: list(entry.options).flatMap((value) => {
        const option = record(value)
        return string(option.label) ? [{ label: option.label as string, ...(string(option.description) ? { description: option.description as string } : {}) }] : []
      }),
    } }]
  })
}

/** Upserts live and replayed items under the same turn/item ids. */
export class CodexItemMapper {
  private readonly items = new Map<string, ChatItem>()
  private readonly summaries = new Map<string, Map<number, string>>()
  private readonly expectedUsers: { text: string; images: ChatImageRef[]; steered: boolean }[] = []
  private counter = 0
  private turnId = 'codex-start'
  constructor(private readonly now: () => number = Date.now, private readonly imageForPath?: (path: string) => ChatImageRef | undefined) {}
  list(): ChatItem[] { return [...this.items.values()] }
  expectUser(text: string, images: ChatImageRef[], steered: boolean): void {
    this.expectedUsers.push({ text, images, steered })
    if (this.expectedUsers.length > 100) this.expectedUsers.shift()
  }
  forgetUser(text: string): void {
    const index = this.expectedUsers.findIndex((entry) => entry.text === text)
    if (index >= 0) this.expectedUsers.splice(index, 1)
  }
  private base(id: string, turnId: string, status: ChatItemStatus) {
    const previous = this.items.get(id)
    return { id, turnId, status, createdAt: previous?.createdAt ?? this.now(), updatedAt: this.now() }
  }
  private put(item: ChatItem): ChatItem {
    this.items.set(item.id, item)
    if (this.items.size > 5000) {
      const oldest = this.items.keys().next().value
      if (oldest !== undefined) { this.items.delete(oldest); this.summaries.delete(oldest) }
    }
    return item
  }
  notice(level: 'info' | 'error', message: string, turnId = this.turnId): ChatItem[] {
    return [this.put({ ...this.base(`codex-notice-${++this.counter}`, turnId, 'completed'), kind: 'notice', level, text: message.slice(0, MAX_TEXT) })]
  }
  request(request: RpcRequest): ChatItem[] {
    const params = record(request.params)
    const turnId = string(params.turnId) ?? this.turnId
    const key = requestKey(request.id)
    const question = request.method === 'item/tool/requestUserInput'
    const toolName = question ? 'request_user_input' : request.method.split('/')[1] ?? 'Codex'
    return [this.put({ ...this.base(`request-${key}`, turnId, 'running'), kind: 'request', requestId: key,
      requestKind: question ? 'question' : 'approval', toolName,
      title: question ? 'Codex is asking' : `Allow ${toolName}?`,
      detail: [string(params.reason), string(params.command), string(params.grantRoot), params.permissions ? detail(params.permissions) : undefined].filter(Boolean).join('\n'),
      ...(question ? { questions: inputQuestions(params.questions).map((entry) => entry.question) } : {}),
    })]
  }
  resolveRequest(key: string, answer: ChatRequestAnswer): ChatItem[] {
    const existing = this.items.get(`request-${key}`)
    if (!existing || existing.kind !== 'request' || existing.answer) return []
    return [this.put({ ...existing, answer, status: answer.kind === 'cancelled' ? 'interrupted' : 'completed', updatedAt: this.now() })]
  }
  settle(turnId: string | undefined, state: Exclude<ChatItemStatus, 'running'>): ChatItem[] {
    return [...this.items.values()].flatMap((item) => {
      if (item.status !== 'running' || (turnId && item.turnId !== turnId)) return []
      return [this.put({ ...item, status: state, updatedAt: this.now(), ...(item.kind === 'request' && !item.answer ? { answer: { kind: 'cancelled' as const, reason: 'The turn ended before this was answered.' } } : {}) })]
    })
  }
  replay(turn: CodexTurn): ChatItem[] {
    this.turnId = turn.id
    return [...turn.items.flatMap((item) => this.item(turn.id, item, true)), ...this.settle(turn.id, status(turn.status, true)), ...(turn.error ? this.notice('error', turn.error.message, turn.id) : [])]
  }
  notification({ method, params: raw }: RpcNotification): ChatItem[] {
    const params = record(raw)
    const turnId = string(params.turnId) ?? this.turnId
    if (method === 'turn/started') { this.turnId = string(record(params.turn).id) ?? turnId; return [] }
    if (method === 'turn/completed') {
      const turn = record(params.turn)
      const id = string(turn.id) ?? turnId
      // Completed notifications often omit items. Individual item events are authoritative.
      return [...list(turn.items).flatMap((item) => this.item(id, item, true)), ...this.settle(id, status(turn.status, true)),
        ...(string(record(turn.error).message) ? this.notice('error', text(record(turn.error).message), id) : [])]
    }
    if (method === 'item/started' || method === 'item/completed') return this.item(turnId, params.item, method === 'item/completed')
    if (method === 'turn/plan/updated') return [this.put({ ...this.base(`codex:${turnId}:todos`, turnId, 'completed'), kind: 'todo_list', todos: todos(params.plan) })]
    if (method === 'serverRequest/resolved' && rpcId(params.requestId)) return this.resolveRequest(requestKey(params.requestId), { kind: 'cancelled', reason: 'Resolved by Codex' })
    if (method === 'error' || method === 'warning') return this.notice(method === 'error' ? 'error' : 'info', text(params.message ?? record(params.error).message) || `Codex ${method}`, turnId)
    const itemId = string(params.itemId)
    if (!itemId) return []
    const id = `codex:${turnId}:${itemId}`
    const previous = this.items.get(id)
    if (method === 'item/fileChange/patchUpdated') return this.item(turnId, { type: 'fileChange', id: itemId, changes: params.changes }, false)
    if (method === 'item/agentMessage/delta' || method === 'item/plan/delta' || method === 'item/reasoning/summaryTextDelta' || method === 'item/reasoning/textDelta') {
      if (previous && previous.status !== 'running') return []
      const kind = method === 'item/plan/delta' ? 'plan' : method.includes('/reasoning/') ? 'reasoning' : 'assistant_message'
      let next = `${previous && 'text' in previous ? previous.text : ''}${text(params.delta)}`
      if (method === 'item/reasoning/summaryTextDelta') {
        const summary = this.summaries.get(id) ?? new Map<number, string>()
        const index = typeof params.summaryIndex === 'number' ? params.summaryIndex : 0
        summary.set(index, `${summary.get(index) ?? ''}${text(params.delta)}`.slice(0, MAX_TEXT))
        this.summaries.set(id, summary)
        next = [...summary.entries()].sort(([a], [b]) => a - b).map(([, value]) => value).join('\n\n')
      } else if (method === 'item/reasoning/textDelta' && this.summaries.has(id)) return []
      return [this.put({ ...this.base(id, turnId, 'running'), kind, text: next.slice(0, MAX_TEXT), ...(kind === 'plan' ? { toolUseId: itemId } : {}) } as ChatItem)]
    }
    if (method === 'item/commandExecution/outputDelta') {
      if (previous?.kind !== 'command' || previous.status !== 'running') return []
      return [this.put({ ...previous, output: `${previous.output ?? ''}${text(params.delta)}`.slice(-MAX_TEXT), updatedAt: this.now() })]
    }
    return []
  }
  private item(turnId: string, raw: unknown, complete: boolean): ChatItem[] {
    const item = record(raw)
    const itemId = string(item.id)
    const type = string(item.type)
    if (!itemId || !type) return []
    const id = `codex:${turnId}:${itemId}`
    const previous = this.items.get(id)
    // Out-of-order starts must not re-open completed items.
    if (!complete && previous && previous.status !== 'running') return []
    const state = status(item.status, complete)
    const base = this.base(id, turnId, state)
    switch (type) {
      case 'userMessage': {
        const content = list(item.content)
        const message = content.map((input) => text(record(input).text)).filter(Boolean).join('\n')
        const expectedIndex = this.expectedUsers.findIndex((entry) => entry.text === message)
        const expected = expectedIndex >= 0 ? this.expectedUsers.splice(expectedIndex, 1)[0] : undefined
        const images = expected?.images ?? content.flatMap((input) => {
          const path = string(record(input).path)
          const image = path ? this.imageForPath?.(path) : undefined
          return image ? [image] : []
        })
        return [this.put({ ...base, ...(previous?.kind === 'user_message' ? previous : {}), kind: 'user_message', text: message, status: 'completed', ...(images.length ? { images } : {}), ...(expected?.steered ? { steered: true } : {}) })]
      }
      case 'agentMessage': case 'plan': case 'reasoning': {
        const kind = type === 'agentMessage' ? 'assistant_message' : type === 'plan' ? 'plan' : 'reasoning'
        const parts = list(item.summary).length ? list(item.summary) : list(item.content)
        const value = type === 'reasoning' ? parts.map(text).join('\n\n') : text(item.text)
        return [this.put({ ...base, kind, text: value || (previous && 'text' in previous ? previous.text : ''), ...(kind === 'plan' ? { toolUseId: itemId } : {}) } as ChatItem)]
      }
      case 'commandExecution': return [this.put({ ...base, kind: 'command', toolUseId: itemId, command: text(item.command).slice(0, 16384) || (previous?.kind === 'command' ? previous.command : ''),
        output: string(item.aggregatedOutput)?.slice(-MAX_TEXT) ?? (previous?.kind === 'command' ? previous.output : undefined), ...(state === 'failed' ? { isError: true } : {}) })]
      case 'fileChange': return list(item.changes).flatMap((value) => {
        const change = record(value)
        const path = string(change.path)
        if (!path) return []
        const fileId = `${id}:file:${createHash('sha256').update(path).digest('hex').slice(0, 16)}`
        const existing = this.items.get(fileId)
        if (!complete && existing && existing.status !== 'running') return []
        const patch = text(change.diff)
        const lines = patch.split('\n')
        return [this.put({ ...this.base(fileId, turnId, state), kind: 'file_change', toolUseId: itemId, toolName: 'apply_patch', path, patch,
          additions: lines.filter((line) => line.startsWith('+') && !line.startsWith('+++')).length,
          deletions: lines.filter((line) => line.startsWith('-') && !line.startsWith('---')).length, ...(state === 'failed' ? { isError: true } : {}) })]
      })
      case 'todo': case 'todoList': return [this.put({ ...base, kind: 'todo_list', todos: todos(item.todos ?? item.plan) })]
      default: return [this.put({ ...base, kind: 'tool', toolUseId: itemId, toolName: string(item.tool) ?? type,
        title: type === 'mcpToolCall' ? `${text(item.server)} · ${text(item.tool)}` : type === 'webSearch' ? `Search: ${text(item.query)}` : string(item.tool) ?? type,
        detail: detail(item.arguments ?? item.action ?? item), output: item.result == null ? undefined : detail(item.result),
        ...(state === 'failed' || item.error ? { isError: true } : {}) })]
    }
  }
}
