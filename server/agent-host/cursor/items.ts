import { MAX_CHAT_ITEMS, type ChatImageRef, type ChatItem, type ChatItemStatus, type ChatTodo } from '../../../shared/agent-chat.js'

export const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
export const string = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined
export const list = (value: unknown): unknown[] => Array.isArray(value) ? value : []
const MAX_TEXT = 200_000
const text = (value: unknown) => (string(value) ?? '').slice(0, MAX_TEXT)
function detail(value: unknown): string {
  try { return (JSON.stringify(value, null, 2) ?? '').slice(0, MAX_TEXT) } catch { return '' }
}
function todos(value: unknown): ChatTodo[] {
  return list(value).flatMap((value) => {
    const todo = record(value)
    if (!string(todo.content)) return []
    return [{ content: text(todo.content), status: todo.status === 'completed' || todo.status === 'cancelled' ? 'completed' : todo.status === 'inProgress' ? 'in_progress' : 'pending' }]
  })
}
const lines = (value: string) => value ? value.replace(/\n$/, '').split('\n') : []
function changes(args: Record<string, unknown>, edit?: Record<string, unknown>): { additions: number; deletions: number; patch?: string } {
  const old = string(args.old_string) ?? string(args.oldString) ?? string(args.oldText)
  const next = string(args.new_string) ?? string(args.newString) ?? string(args.newText) ?? string(args.fileText)
  const patch = edit ? string(edit.diffString) : string(args.patch) ?? string(args.diff)
    ?? (next !== undefined ? [...lines(old ?? '').map((line) => `-${line}`), ...lines(next).map((line) => `+${line}`)].join('\n') : undefined)
  const count = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
  return { additions: count(edit?.linesAdded) ?? (patch ? patch.split('\n').filter((line) => line.startsWith('+') && !line.startsWith('+++')).length : 0),
    deletions: count(edit?.linesRemoved) ?? (patch ? patch.split('\n').filter((line) => line.startsWith('-') && !line.startsWith('---')).length : 0),
    ...(patch !== undefined ? { patch: patch.slice(0, MAX_TEXT) } : {}) }
}
export const QUESTION_REFUSED = "Cursor tried to ask a question, which it can't do in a Commando chat; it continues without an answer. Reply in the chat if it needs one."
const TITLES: Record<string, string> = { read: 'Read file', grep: 'Search text', glob: 'Find files', ls: 'List files', mcp: 'MCP tool', semSearch: 'Search code', readLints: 'Read diagnostics', generateImage: 'Generate image' }

export class CursorItemMapper {
  private readonly items = new Map<string, ChatItem>()
  private turnId = 'cursor'
  private counter = 0
  private replayCounter = 0
  private step = 0
  private readonly calls = new Set<string>()
  constructor(private readonly now = Date.now) {}
  list(): ChatItem[] { return [...this.items.values()] }
  begin(turnId: string): void { this.turnId = turnId; this.step = 0; this.calls.clear() }
  private base(id: string, status: ChatItemStatus) {
    return { id, turnId: this.turnId, status, createdAt: this.items.get(id)?.createdAt ?? this.now(), updatedAt: this.now() }
  }
  private put(item: ChatItem): ChatItem {
    this.items.set(item.id, item)
    if (this.items.size > MAX_CHAT_ITEMS) {
      const oldest = this.items.keys().next().value
      if (oldest !== undefined) this.items.delete(oldest)
    }
    return item
  }
  notice(level: 'info' | 'error', message: string): ChatItem[] {
    return [this.put({ ...this.base(`cursor-notice-${++this.counter}`, 'completed'), kind: 'notice', level, text: text(message) })]
  }
  expectUser(message: string, images: ChatImageRef[] = [], steered = false): ChatItem[] {
    return [this.put({ ...this.base(`cursor:${this.turnId}:user-${++this.counter}`, 'completed'), kind: 'user_message', text: text(message),
      ...(images.length ? { images } : {}), ...(steered ? { steered: true } : {}) })]
  }
  settle(turnId: string | undefined, status: Exclude<ChatItemStatus, 'running'>): ChatItem[] {
    return this.list().flatMap((item) => item.status !== 'running' || (turnId && item.turnId !== turnId) ? [] : [this.put({
      ...item, status, updatedAt: this.now(),
      ...(item.kind === 'subagent' ? { state: status === 'interrupted' ? 'stopped' as const : status } : {}),
    })])
  }
  private message(kind: 'assistant_message' | 'reasoning', value: unknown, complete = false, append = true): ChatItem[] {
    const id = `cursor:${this.turnId}:${kind}:${this.step}`
    const previous = this.items.get(id)
    if (previous && previous.status !== 'running' && !complete) return []
    return [this.put({ ...this.base(id, complete ? 'completed' : 'running'), kind,
      text: `${append && previous && 'text' in previous ? previous.text : ''}${text(value)}`.slice(0, MAX_TEXT) })]
  }
  delta(raw: unknown): ChatItem[] {
    const update = record(raw)
    switch (update.type) {
      case 'text-delta': return this.message('assistant_message', update.text)
      case 'thinking-delta': return this.message('reasoning', update.text)
      case 'thinking-completed': return this.message('reasoning', '')
        .map((item) => this.put({ ...item, status: 'completed' }))
      case 'tool-call-started': case 'partial-tool-call': case 'tool-call-completed': {
        const callId = string(update.callId)
        if (!callId) return []
        const ended = this.calls.has(callId) ? [] : this.endStep()
        this.calls.add(callId)
        return [...ended, ...this.tool(callId, update.toolCall, update.type === 'tool-call-completed')]
      }
      // Run.wait() owns settlement: turn-ended can precede a cancellation or failure result.
      case 'turn-ended': return []
      case 'summary-started': return [this.put({ ...this.base(`cursor:${this.turnId}:summary`, 'running'), kind: 'notice', level: 'info', text: 'Summarizing conversation…' })]
      case 'summary': case 'summary-completed': {
        const id = `cursor:${this.turnId}:summary`
        const previous = this.items.get(id)
        return [this.put({ ...this.base(id, update.type === 'summary-completed' ? 'completed' : 'running'), kind: 'notice', level: 'info',
          text: text(update.summary) || (previous && 'text' in previous ? previous.text : 'Conversation summarized.') })]
      }
      default: return []
    }
  }
  private endStep(): ChatItem[] {
    const updates = this.list().flatMap((item) => item.turnId === this.turnId && item.status === 'running'
      && (item.kind === 'assistant_message' || item.kind === 'reasoning') ? [this.put({ ...item, status: 'completed', updatedAt: this.now() })] : [])
    this.step++
    return updates
  }
  replay(raw: unknown): ChatItem[] {
    const entry = record(raw)
    const turn = record(entry.turn)
    this.begin(`history-${++this.replayCounter}`)
    if (entry.type === 'shellConversationTurn') {
      const output = record(turn.shellOutput)
      return this.tool('shell', { type: 'shell', args: record(turn.shellCommand), result: {
        status: typeof output.exitCode === 'number' && output.exitCode !== 0 ? 'error' : 'success', value: output, error: output,
      } }, true)
    }
    if (entry.type !== 'agentConversationTurn') return []
    const items = string(record(turn.userMessage).text) !== undefined ? this.expectUser(text(record(turn.userMessage).text)) : []
    for (const [index, value] of list(turn.steps).entries()) {
      const step = record(value)
      if (step.type === 'toolCall') { items.push(...this.endStep(), ...this.tool(`step-${index}`, step.message, true)) }
      else if (step.type === 'assistantMessage' || step.type === 'thinkingMessage') {
        items.push(...this.message(step.type === 'assistantMessage' ? 'assistant_message' : 'reasoning', record(step.message).text, true, false))
        this.step++
      }
    }
    return items
  }
  private tool(callId: string, raw: unknown, complete: boolean): ChatItem[] {
    const call = record(raw)
    const type = string(call.type)
    if (!type) return []
    const id = `cursor:${this.turnId}:tool:${callId}`
    const previous = this.items.get(id)
    if (!complete && previous && previous.status !== 'running') return []
    const args = record(call.args)
    const result = record(call.result)
    const value = record(result.value)
    const failed = result.status === 'error'
    const base = this.base(id, failed ? 'failed' : complete ? 'completed' : 'running')
    const error = failed ? { isError: true as const } : {}
    switch (type) {
      case 'shell': return [this.put({ ...base, kind: 'command', toolUseId: callId, command: text(args.command).slice(0, 16384),
        ...(call.result !== undefined ? { output: failed ? detail(result.error) : `${text(value.stdout)}${text(value.stderr)}`.slice(-MAX_TEXT) } : {}), ...error })]
      case 'edit': case 'write': case 'delete':
        if (!string(args.path)) return []
        return [this.put({ ...base, kind: 'file_change', toolUseId: callId, toolName: type, path: text(args.path), ...changes(args, type === 'edit' ? value : undefined), ...error })]
      case 'updateTodos': return [this.put({ ...base, kind: 'todo_list', todos: todos(args.todos) })]
      case 'createPlan': return [this.put({ ...base, kind: 'plan', toolUseId: callId, text: text(args.plan) })]
      // The local SDK refuses questions without showing them; say so rather than leave a dead tool row.
      case 'askQuestion': return [this.put({ ...base, status: 'completed', kind: 'notice', level: 'info', text: QUESTION_REFUSED })]
      // No runtime (that marks a run the daemon observes) and no agentId: the SDK offers no
      // subagent stop or transcript, so the row shows only its prompt and report.
      case 'task': return [this.put({ ...base, kind: 'subagent', toolUseId: callId, description: text(args.description).slice(0, 500),
        state: failed ? 'failed' : complete ? 'completed' : 'running', prompt: text(args.prompt), model: string(args.model),
        subagentType: string(record(args.subagentType).name) ?? string(record(args.subagentType).kind),
        ...(call.result !== undefined ? { output: detail(call.result) } : {}) })]
      default: return [this.put({ ...base, kind: 'tool', toolUseId: callId, toolName: type, title: `${TITLES[type] ?? type.replace(/([a-z])([A-Z])/g, '$1 $2')}${string(args.path) ? `: ${text(args.path)}` : ''}`,
        detail: detail(call.args), ...(call.result !== undefined ? { output: detail(call.result) } : {}), ...error })]
    }
  }
}
