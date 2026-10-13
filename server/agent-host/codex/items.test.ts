import { describe, expect, it } from 'vitest'
import { CodexItemMapper } from './items.js'
import { parseChatItem } from '../../../shared/agent-chat.js'
import { requestKey } from './protocol.js'

const threadId = 'thread-123'
const turnId = 'turn-123'
const agent = { type: 'agentMessage', id: 'a', text: '', phase: null, memoryCitation: null, delivery: null, questions: null }
const command = { type: 'commandExecution', id: 'c', pluginId: null, scriptPath: null, command: 'printf hello', cwd: '/tmp', processId: null, source: 'agent', status: 'inProgress', commandActions: [], aggregatedOutput: null, exitCode: null, durationMs: null }
const file = { type: 'fileChange', id: 'f', status: 'inProgress', changes: [{ path: '/tmp/a.ts', kind: { type: 'update', move_path: null }, diff: '@@\n-old\n+new\n+extra' }] }
const question = { id: 'q-id', header: 'Choice', question: 'Which one?', isOther: true, isSecret: false, options: [{ label: 'A', description: 'First' }] }
function harness() {
  let now = 100
  const mapper = new CodexItemMapper(() => now++)
  const notify = (method: string, params: Record<string, unknown>) => mapper.notification({ method, params: { threadId, turnId, ...params } })
  return { mapper, notify }
}

describe('CodexItemMapper', () => {
  it('upserts streaming assistant, reasoning summaries and user turns with stable ids/timestamps', () => {
    const { mapper, notify } = harness()
    mapper.expectUser('Hi', [], true)
    const user = { type: 'userMessage', id: 'u', clientId: null, content: [{ type: 'text', text: 'Hi', text_elements: [] }] }
    notify('item/started', { item: user })
    notify('item/completed', { item: user })
    const started = notify('item/started', { item: agent })[0]!
    notify('item/agentMessage/delta', { itemId: 'a', delta: 'Hello ' })
    notify('item/agentMessage/delta', { itemId: 'a', delta: 'there' })
    const end = notify('item/completed', { item: { ...agent, text: 'Hello there' } })[0]!
    expect(end).toMatchObject({ id: started.id, createdAt: started.createdAt, turnId, kind: 'assistant_message', text: 'Hello there', status: 'completed' })
    expect(end.updatedAt).toBeGreaterThan(started.updatedAt)
    notify('item/started', { item: { type: 'reasoning', id: 'r', summary: [], content: [] } })
    notify('item/reasoning/summaryTextDelta', { itemId: 'r', summaryIndex: 0, delta: 'Think' })
    notify('item/reasoning/summaryTextDelta', { itemId: 'r', summaryIndex: 0, delta: ' carefully' })
    notify('item/reasoning/summaryTextDelta', { itemId: 'r', summaryIndex: 1, delta: 'Then act' })
    notify('item/reasoning/textDelta', { itemId: 'r', contentIndex: 0, delta: 'raw hidden reasoning' })
    expect(mapper.list().at(-1)).toMatchObject({ kind: 'reasoning', text: 'Think carefully\n\nThen act' })
    expect(mapper.list()[0]).toMatchObject({ kind: 'user_message', text: 'Hi', steered: true })
    expect(mapper.list().every((item) => parseChatItem(item))).toBe(true)
  })
  it('streams command output with approval, then resolves and completes once', () => {
    const { mapper, notify } = harness()
    notify('item/started', { item: command })
    mapper.request({ id: 3, method: 'item/commandExecution/requestApproval', params: { threadId, turnId, itemId: 'c', kind: 'command', startedAtMs: 100, environmentId: null, command: command.command, cwd: '/tmp' } })
    notify('item/commandExecution/outputDelta', { itemId: 'c', delta: 'hel' })
    notify('item/commandExecution/outputDelta', { itemId: 'c', delta: 'lo' })
    mapper.resolveRequest(requestKey(3), { kind: 'approval', decision: 'allow' })
    notify('serverRequest/resolved', { requestId: 3 })
    notify('item/completed', { item: { ...command, status: 'completed', aggregatedOutput: 'hello', exitCode: 0, durationMs: 5 } })
    expect(mapper.list()).toMatchObject([{ kind: 'command', output: 'hello', status: 'completed' }, { kind: 'request', status: 'completed', answer: { decision: 'allow' } }])
    expect(notify('item/started', { item: command })).toEqual([])
  })
  it('updates multi-file patches, counts hunks without headers and marks failures', () => {
    const { mapper, notify } = harness()
    notify('item/started', { item: file })
    const changes = [{ ...file.changes[0], diff: '--- a\n+++ b\n@@\n-old\n+new' }, { path: '/tmp/b.ts', kind: { type: 'add' }, diff: '+second' }]
    notify('item/fileChange/patchUpdated', { itemId: 'f', changes })
    notify('item/completed', { item: { ...file, status: 'failed', changes } })
    expect(mapper.list()).toMatchObject([{ kind: 'file_change', path: '/tmp/a.ts', additions: 1, deletions: 1, status: 'failed', isError: true }, { path: '/tmp/b.ts', additions: 1, deletions: 0, status: 'failed' }])
  })
  it('maps questions and cancels pending requests and running items on interrupt', () => {
    const { mapper, notify } = harness()
    notify('item/started', { item: agent })
    mapper.request({ id: 'question', method: 'item/tool/requestUserInput', params: { threadId, turnId, itemId: 'q', questions: [question], isBlocking: true, autoResolutionMs: null } })
    expect(mapper.list().at(-1)).toMatchObject({ kind: 'request', requestKind: 'question', questions: [{ question: 'Which one?', options: [{ label: 'A' }], multiSelect: false }] })
    notify('turn/completed', { turn: { id: turnId, items: [], itemsView: 'full', status: 'interrupted', error: null, startedAt: 1, completedAt: 2, durationMs: 1000 } })
    expect(mapper.list().every((item) => item.status === 'interrupted')).toBe(true)
    expect(mapper.list().at(-1)).toMatchObject({ answer: { kind: 'cancelled' } })
  })
  it('maps plans, tools, errors and warnings and tolerates new/malformed item types', () => {
    const { mapper, notify } = harness()
    notify('turn/plan/updated', { explanation: null, plan: [{ step: 'Build', status: 'inProgress' }] })
    notify('item/completed', { item: { type: 'futureTool', id: 'future', strange: 'data' } })
    notify('item/completed', { item: { type: 'webSearch', id: 'web', query: 'app server', action: null, results: null } })
    notify('error', { error: { message: 'Oops', codexErrorInfo: null, additionalDetails: null }, willRetry: false })
    notify('warning', { message: 'Careful' })
    expect(notify('item/started', { item: null })).toEqual([])
    expect(mapper.list()).toMatchObject([{ kind: 'todo_list', todos: [{ content: 'Build', status: 'in_progress' }] }, { kind: 'tool', title: 'futureTool' }, { kind: 'tool', title: 'Search: app server' }, { kind: 'notice', level: 'error', text: 'Oops' }, { kind: 'notice', level: 'info', text: 'Careful' }])
    expect(mapper.list().every((item) => parseChatItem(item))).toBe(true)
  })
  it('replays history under the live ids without duplicating final messages', () => {
    const { mapper, notify } = harness()
    mapper.replay({ id: turnId, status: 'completed', items: [{ ...agent, text: 'History' }, { ...command, status: 'completed', aggregatedOutput: 'hello' }] })
    notify('item/completed', { item: { ...agent, text: 'History' } })
    expect(mapper.list()).toHaveLength(2)
    expect(mapper.list().every((item) => item.turnId === turnId && item.status === 'completed')).toBe(true)
  })
})

it('keeps long file paths within the existing wire id limit', () => {
  const { mapper, notify } = harness()
  const path = `/tmp/${'long-folder/'.repeat(30)}file.ts`
  notify('item/completed', { item: { ...file, status: 'completed', changes: [{ path, kind: { type: 'add' }, diff: '+content' }] } })
  expect(parseChatItem(mapper.list()[0])).toMatchObject({ kind: 'file_change', path })
})
