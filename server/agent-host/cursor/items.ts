import { isAgentId, MAX_CHAT_ITEMS, notedVideos, stripAttachmentNotes, type ChatImageRef, type ChatItem, type ChatItemStatus, type ChatTodo } from '../../../shared/agent-chat.js'

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
    return [{ content: text(todo.content), status: todo.status === 'completed' || todo.status === 'cancelled' ? 'completed' : todo.status === 'inProgress' || todo.status === 'in_progress' ? 'in_progress' : 'pending' }]
  })
}
const lines = (value: string) => value ? value.replace(/\n$/, '').split('\n') : []
function changes(args: Record<string, unknown>, edit?: Record<string, unknown>): { additions: number; deletions: number; patch?: string } {
  const old = string(args.old_string) ?? string(args.oldString) ?? string(args.oldText)
  const next = string(args.new_string) ?? string(args.newString) ?? string(args.newText) ?? string(args.fileText) ?? string(args.contents)
  const patch = edit ? string(edit.diffString) : string(args.patch) ?? string(args.diff)
    ?? (next !== undefined ? [...lines(old ?? '').map((line) => `-${line}`), ...lines(next).map((line) => `+${line}`)].join('\n') : undefined)
  const count = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
  return { additions: count(edit?.linesAdded) ?? (patch ? patch.split('\n').filter((line) => line.startsWith('+') && !line.startsWith('+++')).length : 0),
    deletions: count(edit?.linesRemoved) ?? (patch ? patch.split('\n').filter((line) => line.startsWith('-') && !line.startsWith('---')).length : 0),
    ...(patch !== undefined ? { patch: patch.slice(0, MAX_TEXT) } : {}) }
}
export const QUESTION_REFUSED = "Cursor tried to ask a question, which it can't do in a Commando chat; it continues without an answer. Reply in the chat if it needs one."
const TITLES: Record<string, string> = { read: 'Read file', grep: 'Search text', glob: 'Find files', ls: 'List files', mcp: 'MCP tool', semSearch: 'Search code', readLints: 'Read diagnostics', generateImage: 'Generate image' }

function mcpTitle(args: Record<string, unknown>): string {
  const provider = string(args.providerIdentifier)
  const tool = string(args.toolName)
  if (provider && tool) return `${provider} · ${tool}`
  if (tool) return `MCP · ${tool}`
  if (provider) return `MCP · ${provider}`
  return TITLES.mcp
}

function mcpOutput(callResult: unknown, result: Record<string, unknown>, value: Record<string, unknown>): string {
  if (result.status === 'error') return detail(result.error)
  const texts = list(value.content).flatMap((entry) => {
    const content = string(record(record(entry).text).text)
    return content !== undefined ? [content] : []
  })
  return texts.length ? texts.join('\n').slice(0, MAX_TEXT) : detail(callResult)
}

type NormalizedStep =
  | { kind: 'assistant'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'tool'; call: Record<string, unknown> }

function normalizeToolCall(raw: unknown): Record<string, unknown> | undefined {
  const call = record(raw)
  if (string(call.type)) return call
  // Proto3 toJson() ToolCall oneof uses `<name>ToolCall` keys, e.g. `shellToolCall`.
  for (const [key, value] of Object.entries(call)) {
    if (!key.endsWith('ToolCall')) continue
    const inner = record(value)
    if (!Object.keys(inner).length) continue
    const rawType = key.slice(0, -'ToolCall'.length)
    const result = record(inner.result)
    const normalizedResult = result.status
      ? result
      : result.success !== undefined
        ? { status: 'success', value: result.success }
        : result.error !== undefined
          ? { status: 'error', error: result.error }
          : undefined
    return {
      type: rawType,
      args: record(inner.args),
      ...(normalizedResult ? { result: normalizedResult } : {}),
    }
  }
  return undefined
}

function normalizeStep(raw: unknown): NormalizedStep | null {
  const step = record(raw)
  if (step.type === 'assistantMessage') {
    const content = string(record(step.message).text)
    return content !== undefined ? { kind: 'assistant', text: content } : null
  }
  if (step.type === 'thinkingMessage') {
    const content = string(record(step.message).text)
    return content !== undefined ? { kind: 'thinking', text: content } : null
  }
  if (step.type === 'toolCall') {
    const call = normalizeToolCall(step.message)
    return call ? { kind: 'tool', call } : null
  }
  if (step.assistantMessage !== undefined) {
    const content = string(record(step.assistantMessage).text)
    return content !== undefined ? { kind: 'assistant', text: content } : null
  }
  if (step.thinkingMessage !== undefined || step.thinking !== undefined) {
    const content = string(record(step.thinkingMessage ?? step.thinking).text)
    return content !== undefined ? { kind: 'thinking', text: content } : null
  }
  if (step.toolCall !== undefined) {
    const call = normalizeToolCall(step.toolCall)
    return call ? { kind: 'tool', call } : null
  }
  return null
}

function lastAssistantText(steps: unknown[]): string | undefined {
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    const parsed = normalizeStep(steps[index])
    if (parsed?.kind === 'assistant' && parsed.text.trim()) return parsed.text
  }
  return undefined
}

function safeSubagentKey(raw: string): string {
  if (isAgentId(raw as unknown)) return raw
  const cleaned = raw.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 128)
  return cleaned || 'subagent'
}

const JSONL_TOOL_MAP: Record<string, string> = {
  shell: 'shell',
  bash: 'shell',
  read: 'read',
  edit: 'edit',
  strreplace: 'edit',
  write: 'write',
  delete: 'delete',
  grep: 'grep',
  glob: 'glob',
  ls: 'ls',
  task: 'task',
  todowrite: 'updateTodos',
  updatetodos: 'updateTodos',
  readlints: 'readLints',
  semsearch: 'semSearch',
  createplan: 'createPlan',
  generateimage: 'generateImage',
}

function jsonlToolType(name: string): string {
  return JSONL_TOOL_MAP[name.toLowerCase()] ?? name
}

function jsonlContentText(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    const parts = value.flatMap((entry) => {
      if (typeof entry === 'string') return [entry]
      const block = record(entry)
      const textValue = string(block.text)
      return textValue !== undefined ? [textValue] : []
    })
    return parts.join('\n')
  }
  return value !== undefined ? detail(value) : ''
}

export interface CursorSubagentSource {
  steps?: unknown[]
  transcriptPath?: string
}

export class CursorItemMapper {
  private readonly items = new Map<string, ChatItem>()
  private turnId = 'cursor'
  private counter = 0
  private replayCounter = 0
  private step = 0
  private readonly calls = new Set<string>()
  private activeShellId?: string
  private readonly subagentSteps = new Map<string, number>()
  private readonly subagentCalls = new Map<string, Set<string>>()
  private readonly subagents = new Map<string, CursorSubagentSource>()

  constructor(private readonly now = Date.now) {}

  list(): ChatItem[] { return [...this.items.values()] }

  begin(turnId: string): void {
    this.turnId = turnId
    this.step = 0
    this.calls.clear()
    this.activeShellId = undefined
    this.subagentSteps.clear()
    this.subagentCalls.clear()
  }

  clear(): void {
    this.items.clear()
    this.calls.clear()
    this.step = 0
    this.activeShellId = undefined
    this.subagentSteps.clear()
    this.subagentCalls.clear()
    this.subagents.clear()
  }

  private base(id: string, status: ChatItemStatus, parentToolUseId?: string) {
    return {
      id,
      turnId: this.turnId,
      ...(parentToolUseId ? { parentToolUseId } : {}),
      status,
      createdAt: this.items.get(id)?.createdAt ?? this.now(),
      updatedAt: this.now(),
    }
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
    if (!turnId || (this.activeShellId && this.items.get(this.activeShellId)?.turnId === turnId)) {
      this.activeShellId = undefined
    }
    return this.list().flatMap((item) => item.status !== 'running' || (turnId && item.turnId !== turnId) ? [] : [this.put({
      ...item, status, updatedAt: this.now(),
      ...(item.kind === 'subagent' ? { state: status === 'interrupted' ? 'stopped' as const : status } : {}),
    })])
  }

  private settleChildren(parentId: string, status: Exclude<ChatItemStatus, 'running'>): ChatItem[] {
    return this.list().flatMap((item) => item.parentToolUseId !== parentId || item.status !== 'running' ? [] : [this.put({
      ...item, status, updatedAt: this.now(),
      ...(item.kind === 'subagent' ? { state: status === 'interrupted' ? 'stopped' as const : status } : {}),
    })])
  }

  private parentItemId(parentCallId: string): string {
    return `cursor:${this.turnId}:tool:${parentCallId}`
  }

  private message(kind: 'assistant_message' | 'reasoning', value: unknown, complete = false, append = true, parentCallId?: string): ChatItem[] {
    const parentId = parentCallId ? this.parentItemId(parentCallId) : undefined
    const step = parentId ? (this.subagentSteps.get(parentId) ?? 0) : this.step
    const id = parentCallId
      ? `cursor:${this.turnId}:sub:${parentCallId}:${kind}:${step}`
      : `cursor:${this.turnId}:${kind}:${step}`
    const previous = this.items.get(id)
    if (previous && previous.status !== 'running' && !complete) return []
    return [this.put({ ...this.base(id, complete ? 'completed' : 'running', parentId), kind,
      text: `${append && previous && 'text' in previous ? previous.text : ''}${text(value)}`.slice(0, MAX_TEXT) })]
  }

  private shellOutputDelta(update: Record<string, unknown>): ChatItem[] {
    const event = record(update.event)
    const eventCase = string(event.case)
    const data = string(record(event.value).data)
    if ((eventCase !== 'stdout' && eventCase !== 'stderr') || !data || !this.activeShellId) return []
    const item = this.items.get(this.activeShellId)
    if (!item || item.kind !== 'command' || item.status !== 'running') return []
    return [this.put({ ...item, output: `${item.output ?? ''}${data}`.slice(-MAX_TEXT), updatedAt: this.now() })]
  }

  private subagentDelta(update: Record<string, unknown>): ChatItem[] {
    const parentCallId = string(update.callId)
    if (!parentCallId) return []
    const taskUpdate = record(update.taskUpdate)
    const parentId = this.parentItemId(parentCallId)
    switch (taskUpdate.type) {
      case 'text-delta':
        return this.message('assistant_message', taskUpdate.text, false, true, parentCallId)
      case 'thinking-delta':
        return this.message('reasoning', taskUpdate.text, false, true, parentCallId)
      case 'thinking-completed':
        return this.message('reasoning', '', false, true, parentCallId)
          .map((item) => this.put({ ...item, status: 'completed' }))
      case 'tool-call-started': case 'partial-tool-call': case 'tool-call-completed': {
        const nestedCallId = string(taskUpdate.callId)
        if (!nestedCallId) return []
        let seen = this.subagentCalls.get(parentId)
        if (!seen) {
          seen = new Set()
          this.subagentCalls.set(parentId, seen)
        }
        const ended = seen.has(nestedCallId) ? [] : this.endStep(parentId)
        seen.add(nestedCallId)
        return [...ended, ...this.tool(nestedCallId, taskUpdate.toolCall, taskUpdate.type === 'tool-call-completed', parentCallId)]
      }
      default:
        return []
    }
  }

  delta(raw: unknown): ChatItem[] {
    const update = record(raw)
    switch (update.type) {
      case 'text-delta': return this.message('assistant_message', update.text)
      case 'thinking-delta': return this.message('reasoning', update.text)
      case 'thinking-completed': return this.message('reasoning', '')
        .map((item) => this.put({ ...item, status: 'completed' }))
      case 'shell-output-delta': return this.shellOutputDelta(update)
      case 'tool-call-delta': return this.subagentDelta(update)
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

  private endStep(parentToolUseId?: string): ChatItem[] {
    const updates = this.list().flatMap((item) => item.turnId === this.turnId
      && item.parentToolUseId === parentToolUseId
      && item.status === 'running'
      && (item.kind === 'assistant_message' || item.kind === 'reasoning')
      ? [this.put({ ...item, status: 'completed', updatedAt: this.now() })]
      : [])
    if (parentToolUseId) this.subagentSteps.set(parentToolUseId, (this.subagentSteps.get(parentToolUseId) ?? 0) + 1)
    else this.step++
    return updates
  }

  replaySteps(steps: unknown[]): ChatItem[] {
    const items: ChatItem[] = []
    for (const [index, value] of steps.entries()) {
      const parsed = normalizeStep(value)
      if (!parsed) continue
      if (parsed.kind === 'tool') {
        items.push(...this.endStep(), ...this.tool(`step-${index}`, parsed.call, true))
      } else {
        items.push(...this.message(parsed.kind === 'assistant' ? 'assistant_message' : 'reasoning', parsed.text, true, false))
        this.step++
      }
    }
    return items
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
    const sent = string(record(turn.userMessage).text)
    // Attached videos were sent as notes after the typed text.
    const items = sent !== undefined ? this.expectUser(stripAttachmentNotes(sent), notedVideos(sent)) : []
    items.push(...this.replaySteps(list(turn.steps)))
    return items
  }

  subagentTranscript(agentId: string): { items: ChatItem[]; transcriptPath?: string } | null {
    const source = this.subagents.get(agentId)
    if (!source) return null
    if (source.steps?.length) {
      const temp = new CursorItemMapper(this.now)
      temp.begin(`subagent-${agentId}`)
      const items = temp.replaySteps(source.steps)
      return { items, ...(source.transcriptPath ? { transcriptPath: source.transcriptPath } : {}) }
    }
    if (source.transcriptPath) return { items: [], transcriptPath: source.transcriptPath }
    return null
  }

  private tool(callId: string, raw: unknown, complete: boolean, parentCallId?: string): ChatItem[] {
    const call = record(raw)
    const type = string(call.type)
    if (!type) return []
    const parentId = parentCallId ? this.parentItemId(parentCallId) : undefined
    const id = parentCallId
      ? `cursor:${this.turnId}:sub:${parentCallId}:tool:${callId}`
      : `cursor:${this.turnId}:tool:${callId}`
    const previous = this.items.get(id)
    if (!complete && previous && previous.status !== 'running') return []
    const args = record(call.args)
    const result = record(call.result)
    const value = record(result.value)
    const failed = result.status === 'error'
    const base = this.base(id, failed ? 'failed' : complete ? 'completed' : 'running', parentId)
    const error = failed ? { isError: true as const } : {}
    switch (type) {
      case 'shell': {
        if (!parentId) {
          if (complete || failed) {
            if (this.activeShellId === id) this.activeShellId = undefined
          } else {
            this.activeShellId = id
          }
        }
        const streamedOutput = call.result === undefined && previous?.kind === 'command' && previous.output !== undefined
          ? { output: previous.output }
          : {}
        const finalOutput = call.result !== undefined
          ? { output: failed ? detail(result.error) : `${text(value.stdout)}${text(value.stderr)}`.slice(-MAX_TEXT) }
          : streamedOutput
        const cwd = (string(args.workingDirectory) ?? string(args.working_directory) ?? string(args.cwd))?.trim().slice(0, 4096)
          || (previous?.kind === 'command' ? previous.cwd : undefined)
        return [this.put({ ...base, kind: 'command', toolUseId: callId, command: text(args.command).slice(0, 16384), ...(cwd ? { cwd } : {}), ...finalOutput, ...error })]
      }
      case 'edit': case 'write': case 'delete':
        if (!string(args.path)) return []
        return [this.put({ ...base, kind: 'file_change', toolUseId: callId, toolName: type, path: text(args.path), ...changes(args, type === 'edit' ? value : undefined), ...error })]
      case 'updateTodos': return [this.put({ ...base, kind: 'todo_list', todos: todos(args.todos) })]
      case 'createPlan': return [this.put({ ...base, kind: 'plan', toolUseId: callId, text: text(args.plan) })]
      // The local SDK refuses questions without showing them; say so rather than leave a dead tool row.
      case 'askQuestion': return [this.put({ ...base, status: 'completed', kind: 'notice', level: 'info', text: QUESTION_REFUSED })]
      case 'task': {
        const steps = list(value.conversationSteps)
        const transcriptPath = string(value.transcriptPath)?.trim() || undefined
        const durationMs = typeof value.durationMs === 'number' && Number.isFinite(value.durationMs) && value.durationMs >= 0
          ? value.durationMs
          : undefined
        const background = value.isBackground === true ? true : undefined
        const assistant = !failed && result.status === 'success' ? lastAssistantText(steps) : undefined
        const suffix = string(value.resultSuffix)?.trim()
        const output = call.result !== undefined
          ? failed
            ? detail(result.error !== undefined ? result.error : call.result)
            : assistant !== undefined
              ? (suffix ? `${assistant}\n\n${suffix}` : assistant).slice(0, MAX_TEXT)
              : detail(call.result)
          : undefined
        let agentId: string | undefined
        // Only attach agentId once complete with a real transcript source; running rows must not
        // advertise stop/background controls because the Cursor SDK has no subagent control API.
        if (complete && !failed && (steps.length > 0 || Boolean(transcriptPath))) {
          agentId = safeSubagentKey(string(value.agentId) ?? callId)
          this.subagents.set(agentId, {
            ...(steps.length ? { steps } : {}),
            ...(transcriptPath ? { transcriptPath } : {}),
          })
        }
        const settled = complete ? this.settleChildren(id, failed ? 'failed' : 'completed') : []
        const item = this.put({
          ...base,
          kind: 'subagent',
          toolUseId: callId,
          description: text(args.description).slice(0, 500),
          state: failed ? 'failed' : complete ? 'completed' : 'running',
          prompt: text(args.prompt),
          model: string(args.model),
          subagentType: string(record(args.subagentType).name) ?? string(record(args.subagentType).kind),
          ...(agentId ? { agentId } : {}),
          ...(background ? { background } : {}),
          ...(durationMs !== undefined ? { durationMs } : {}),
          ...(output !== undefined ? { output } : {}),
        })
        return [...settled, item]
      }
      case 'mcp': {
        const mcpFailed = failed || value.isError === true
        const mcpBase = this.base(id, mcpFailed ? 'failed' : complete ? 'completed' : 'running', parentId)
        return [this.put({
          ...mcpBase,
          kind: 'tool',
          toolUseId: callId,
          toolName: type,
          title: mcpTitle(args),
          detail: detail(args.args !== undefined ? args.args : call.args),
          ...(call.result !== undefined ? { output: mcpOutput(call.result, result, value) } : {}),
          ...(mcpFailed ? { isError: true as const } : {}),
        })]
      }
      default: return [this.put({ ...base, kind: 'tool', toolUseId: callId, toolName: type, title: `${TITLES[type] ?? type.replace(/([a-z])([A-Z])/g, '$1 $2')}${string(args.path) ? `: ${text(args.path)}` : ''}`,
        detail: detail(call.args), ...(call.result !== undefined ? { output: detail(call.result) } : {}), ...error })]
    }
  }
}

/** Parses a saved Cursor subagent `.jsonl` transcript into `ChatItem[]`. */
export function parseCursorTranscriptJsonl(raw: string, turnId: string, now = Date.now): ChatItem[] {
  const mapper = new CursorItemMapper(now)
  mapper.begin(turnId)
  const toolItemsById = new Map<string, ChatItem>()
  let toolCounter = 0

  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    let parsed: unknown
    try { parsed = JSON.parse(line) } catch { continue }

    if (normalizeStep(parsed)) {
      mapper.replaySteps([parsed])
      continue
    }

    const entry = record(parsed)
    const role = string(entry.role) ?? string(entry.type)
    const message = record(entry.message)
    const content = message.content !== undefined ? message.content : entry.content ?? message.text ?? entry.text

    if (role === 'user') {
      if (typeof content === 'string') {
        const clean = stripAttachmentNotes(content)
        if (clean) mapper.expectUser(clean, notedVideos(content))
        continue
      }
      const userTexts: string[] = []
      for (const rawBlock of list(content)) {
        const block = record(rawBlock)
        if (block.type === 'tool_result') {
          const refId = string(block.tool_use_id) ?? string(block.toolUseId)
          const existing = refId ? toolItemsById.get(refId) : undefined
          if (existing && (existing.kind === 'tool' || existing.kind === 'command' || existing.kind === 'file_change')) {
            const output = jsonlContentText(block.content).slice(0, MAX_TEXT)
            const isError = block.is_error === true || block.isError === true
            existing.status = isError ? 'failed' : 'completed'
            if (output) existing.output = output
            if (isError) existing.isError = true
            existing.updatedAt = now()
          }
          continue
        }
        const blockText = string(block.text)
        if (blockText) userTexts.push(blockText)
      }
      const combined = userTexts.join('\n').trim()
      if (combined) mapper.expectUser(stripAttachmentNotes(combined), notedVideos(combined))
      continue
    }

    if (role === 'assistant') {
      if (typeof content === 'string') {
        if (content.trim()) mapper.replaySteps([{ type: 'assistantMessage', message: { text: content } }])
        continue
      }
      for (const rawBlock of list(content)) {
        const block = record(rawBlock)
        if (block.type === 'thinking') {
          const thought = string(block.thinking) ?? string(block.text)
          if (thought) mapper.replaySteps([{ type: 'thinkingMessage', message: { text: thought } }])
        } else if (block.type === 'text') {
          const reply = string(block.text)
          if (reply) mapper.replaySteps([{ type: 'assistantMessage', message: { text: reply } }])
        } else if (block.type === 'tool_use') {
          const name = string(block.name)
          if (!name) continue
          const callId = string(block.id) ?? `jsonl-${++toolCounter}`
          const rawInput = record(block.input)
          const input = rawInput.path === undefined && typeof rawInput.file_path === 'string'
            ? { ...rawInput, path: rawInput.file_path }
            : rawInput
          const mapped = mapper.delta({
            type: 'tool-call-completed',
            callId,
            toolCall: { type: jsonlToolType(name), args: input },
          })
          const created = mapped.at(-1)
          if (created) toolItemsById.set(callId, created)
        }
      }
    }
  }
  return mapper.list()
}
