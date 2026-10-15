import { describe, expect, it } from 'vitest'
import { MAX_CHAT_ITEMS, parseChatItem } from '../../../shared/agent-chat.js'
import { CursorItemMapper } from './items.js'

const tool = (mapper: CursorItemMapper, type: string, args: unknown, result?: unknown) => mapper.delta({ type: 'tool-call-completed', callId: type, toolCall: { type, args, result } }).at(-1)
describe('CursorItemMapper', () => {
  it('appends text to one step and starts a new message after tools', () => {
    const mapper = new CursorItemMapper(() => 1)
    mapper.begin('t')
    mapper.expectUser('Hi')
    mapper.delta({ type: 'text-delta', text: 'Hello' })
    mapper.delta({ type: 'text-delta', text: ' world' })
    const original = mapper.list().at(-1)!
    expect(original).toMatchObject({ kind: 'assistant_message', text: 'Hello world', status: 'running' })
    mapper.delta({ type: 'tool-call-started', callId: 's', toolCall: { type: 'shell', args: { command: 'pwd' } } })
    mapper.delta({ type: 'partial-tool-call', callId: 's', toolCall: { type: 'shell', args: { command: 'pwd' } } })
    mapper.delta({ type: 'tool-call-completed', callId: 's', toolCall: { type: 'shell', args: { command: 'pwd' }, result: { status: 'success', value: { stdout: '/w', stderr: '' } } } })
    mapper.delta({ type: 'text-delta', text: 'Done' })
    expect(mapper.list().filter((item) => item.kind === 'command')).toHaveLength(1)
    expect(mapper.list().filter((item) => item.kind === 'assistant_message')).toMatchObject([{ id: original.id, text: 'Hello world', status: 'completed' }, { text: 'Done' }])
    expect(mapper.list().at(-2)).toMatchObject({ command: 'pwd', output: '/w', status: 'completed' })
    mapper.settle('t', 'completed')
    expect(mapper.list().every((item) => item.status === 'completed')).toBe(true)
    expect(mapper.list().every((item) => parseChatItem(item))).toBe(true)
  })
  it('maps reasoning, summaries, plans and todos, ignoring unrelated updates', () => {
    const mapper = new CursorItemMapper()
    mapper.delta({ type: 'thinking-delta', text: 'Think' })
    mapper.delta({ type: 'thinking-delta', text: ' more' })
    mapper.delta({ type: 'thinking-completed', thinkingDurationMs: 42 })
    expect(mapper.list()[0]).toMatchObject({ kind: 'reasoning', text: 'Think more', status: 'completed' })
    expect(tool(mapper, 'createPlan', { plan: '# Plan' })).toMatchObject({ kind: 'plan', text: '# Plan' })
    expect(tool(mapper, 'updateTodos', { todos: [{ content: 'A', status: 'inProgress' }, { content: 'B', status: 'completed' }, { content: 'C', status: 'pending' }] }))
      .toMatchObject({ kind: 'todo_list', todos: [{ content: 'A', status: 'in_progress' }, { content: 'B', status: 'completed' }, { content: 'C', status: 'pending' }] })
    mapper.delta({ type: 'summary-started' }); mapper.delta({ type: 'summary', summary: 'A summary' }); mapper.delta({ type: 'summary-completed' })
    expect(mapper.list().at(-1)).toMatchObject({ kind: 'notice', text: 'A summary', status: 'completed' })
    expect(mapper.delta({ type: 'token-delta', tokens: 1 })).toEqual([])
  })
  it('maps file inputs conservatively and errors to failed items', () => {
    const mapper = new CursorItemMapper()
    expect(tool(mapper, 'edit', { path: 'a' }, { status: 'success', value: { diffString: '-old\n-line\n+new', linesAdded: 1, linesRemoved: 2 } })).toMatchObject({ kind: 'file_change', additions: 1, deletions: 2, patch: '-old\n-line\n+new' })
    expect(tool(mapper, 'write', { path: 'b', fileText: 'one\ntwo\n' })).toMatchObject({ additions: 2, deletions: 0 })
    expect(tool(mapper, 'delete', { path: 'c' }, { status: 'error', error: 'denied' })).toMatchObject({ kind: 'file_change', additions: 0, deletions: 0, isError: true, status: 'failed' })
    expect(tool(mapper, 'shell', { command: 'false' }, { status: 'error', error: 'failed' })).toMatchObject({ kind: 'command', isError: true, status: 'failed' })
    const edits = mapper.list().filter((item) => item.kind === 'file_change')
    expect(edits.at(-1)).not.toHaveProperty('patch')
  })
  it('prefers edit result counts and only counts patch lines when a count is missing', () => {
    const mapper = new CursorItemMapper()
    const diffString = '--- a\n+++ a\n@@ -1,2 +1,1 @@\n-old\n-line\n+new'
    expect(tool(mapper, 'edit', { path: 'a' }, { status: 'success', value: { diffString, linesAdded: 7, linesRemoved: 0 } }))
      .toMatchObject({ patch: diffString, additions: 7, deletions: 0 })
    expect(tool(mapper, 'edit', { path: 'a' }, { status: 'success', value: { diffString, linesRemoved: 5 } }))
      .toMatchObject({ patch: diffString, additions: 1, deletions: 5 })
    expect(tool(mapper, 'edit', { path: 'a' }, { status: 'success', value: { diffString } }))
      .toMatchObject({ patch: diffString, additions: 1, deletions: 2 })
    expect(tool(mapper, 'edit', { path: 'a' }, { status: 'success', value: { linesAdded: 3 } }))
      .toMatchObject({ additions: 3, deletions: 0 })
  })
  it.each(['read', 'grep', 'glob', 'ls', 'mcp', 'semSearch', 'readLints', 'generateImage', 'futureTool'])('maps %s as a bounded generic tool', (type) => {
    const mapper = new CursorItemMapper()
    const item = tool(mapper, type, { path: 'a', text: 'x'.repeat(210_000) }, { status: 'error', error: 'y'.repeat(210_000) })
    expect(item).toMatchObject({ kind: 'tool', toolName: type, status: 'failed', isError: true })
    if (item?.kind !== 'tool') throw new Error('Missing tool')
    expect(item.title).toBeTruthy()
    expect(item.detail?.length).toBe(200_000)
    expect(item.output?.length).toBe(200_000)
  })
  it('replays user, assistant, thinking, tool and shell turns with stable item updates', () => {
    const mapper = new CursorItemMapper()
    mapper.replay({ type: 'agentConversationTurn', turn: { userMessage: { text: 'Old' }, steps: [
      { type: 'thinkingMessage', message: { text: 'Thinking' } }, { type: 'assistantMessage', message: { text: 'Hello' } },
      { type: 'toolCall', message: { type: 'task', args: { description: 'Investigate', prompt: 'Inspect', agentId: 'child' }, result: { status: 'success', value: {} } } },
    ] } })
    mapper.replay({ type: 'shellConversationTurn', turn: { shellCommand: { command: 'ls' }, shellOutput: { stdout: 'a', stderr: '', exitCode: 0 } } })
    expect(mapper.list()).toMatchObject([{ kind: 'user_message', text: 'Old' }, { kind: 'reasoning', text: 'Thinking' }, { kind: 'assistant_message', text: 'Hello' },
      { kind: 'subagent', runtime: 'cursor', agentId: 'child', state: 'completed' }, { kind: 'command', command: 'ls', output: 'a' }])
    expect(mapper.list().every((item) => parseChatItem(item))).toBe(true)
  })
  it('caps history at the newest item window and ignores malformed updates', () => {
    const mapper = new CursorItemMapper()
    for (let i = 0; i < MAX_CHAT_ITEMS + 2; i++) mapper.notice('info', String(i))
    expect(mapper.list()).toHaveLength(MAX_CHAT_ITEMS)
    expect(mapper.list()[0]).toMatchObject({ text: '2' })
    expect(mapper.delta(null)).toEqual([])
    expect(mapper.delta({ type: 'tool-call-started' })).toEqual([])
    expect(mapper.replay({})).toEqual([])
  })
})
