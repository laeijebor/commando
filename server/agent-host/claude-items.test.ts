import { readFileSync } from 'node:fs'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { describe, expect, it } from 'vitest'
import { ClaudeItemMapper, questionsFromInput, todosFromInput, toolTitle } from './claude-items.js'

// Recorded from Claude Code 2.1.296 via Agent SDK 0.3.295 (Haiku): Write, Read,
// Edit and Bash calls followed by a one-word reply. Paths rewritten to /work.
const fixture = JSON.parse(readFileSync(new URL('./fixtures/claude-tool-turn.json', import.meta.url), 'utf8')) as SDKMessage[]

function replay(mapper: ClaudeItemMapper, messages: SDKMessage[]) {
  for (const message of messages) mapper.handle(message)
  return mapper.list()
}

describe('ClaudeItemMapper', () => {
  it('maps a recorded tool turn into user, tool, file-change, command and reply items', () => {
    let clock = 1_000
    const mapper = new ClaudeItemMapper(() => clock++)
    mapper.startTurn('Create hello.txt…')
    const items = replay(mapper, fixture)

    expect(items.map((item) => item.kind)).toEqual([
      'user_message',
      'file_change',
      'reasoning',
      'tool',
      'file_change',
      'command',
      'assistant_message',
    ])
    const write = items[1]
    expect(write).toMatchObject({ kind: 'file_change', toolName: 'Write', path: '/work/hello.txt', additions: 1, deletions: 0, status: 'completed' })
    const read = items[3]
    expect(read).toMatchObject({ kind: 'tool', toolName: 'Read', title: 'Read /work/hello.txt', status: 'completed' })
    const edit = items[4]
    expect(edit).toMatchObject({ kind: 'file_change', toolName: 'Edit', additions: 1, deletions: 1, patch: '-hi\n+hello there' })
    const bash = items[5]
    expect(bash).toMatchObject({ kind: 'command', output: 'hello there', status: 'completed' })
    expect(items[6]).toMatchObject({ kind: 'assistant_message', text: 'done', status: 'completed' })
    // Every item belongs to the turn the user started.
    expect(new Set(items.map((item) => item.turnId)).size).toBe(1)
    expect(items.every((item) => item.status !== 'running')).toBe(true)
  })

  it('streams text deltas into one item that the final assistant block confirms', () => {
    const mapper = new ClaudeItemMapper(() => 1)
    mapper.startTurn('hi')
    const stream = (event: Record<string, unknown>) => ({ type: 'stream_event', event, parent_tool_use_id: null, uuid: 'u', session_id: 's' }) as unknown as SDKMessage
    mapper.handle(stream({ type: 'message_start', message: { id: 'msg_1' } }))
    mapper.handle(stream({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }))
    const partial = mapper.handle(stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hel' } }))
    expect(partial[0]).toMatchObject({ id: 'msg_1:0', text: 'Hel', status: 'running' })
    mapper.handle(stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'lo' } }))
    mapper.handle({ type: 'assistant', message: { id: 'msg_1', content: [{ type: 'text', text: 'Hello' }] }, parent_tool_use_id: null, uuid: 'a', session_id: 's' } as unknown as SDKMessage)
    const texts = mapper.list().filter((item) => item.kind === 'assistant_message')
    expect(texts).toHaveLength(1)
    expect(texts[0]).toMatchObject({ text: 'Hello', status: 'completed' })
  })

  it('keeps requests on the timeline and cancels unanswered ones when the turn ends', () => {
    const mapper = new ClaudeItemMapper(() => 5)
    mapper.startTurn('go')
    mapper.request('r1', { requestKind: 'approval', toolName: 'Bash', title: 'Allow Bash?', detail: 'git push' })
    mapper.request('r2', { requestKind: 'approval', toolName: 'Bash', title: 'Allow Bash?', detail: 'rm -rf build' })
    mapper.resolveRequest('r1', { kind: 'approval', decision: 'allow' })
    mapper.settleRunning('interrupted')
    const [first, second] = mapper.list().filter((item) => item.kind === 'request')
    expect(first).toMatchObject({ status: 'completed', answer: { kind: 'approval', decision: 'allow' } })
    expect(second).toMatchObject({ status: 'interrupted', answer: { kind: 'cancelled' } })
  })

  it('puts TodoWrite into one todo list item and hides AskUserQuestion tool rows', () => {
    const mapper = new ClaudeItemMapper(() => 1)
    mapper.startTurn('plan')
    const assistant = (content: unknown[]) => ({ type: 'assistant', message: { id: `m${content.length}`, content }, parent_tool_use_id: null, uuid: 'a', session_id: 's' }) as unknown as SDKMessage
    mapper.handle(assistant([{ type: 'tool_use', id: 't1', name: 'TodoWrite', input: { todos: [{ content: 'A', status: 'in_progress' }, { content: 'B', status: 'pending' }] } }]))
    mapper.handle(assistant([{ type: 'tool_use', id: 't2', name: 'AskUserQuestion', input: { questions: [] } }, { type: 'tool_use', id: 't3', name: 'TodoWrite', input: { todos: [{ content: 'A', status: 'completed' }] } }]))
    const items = mapper.list()
    expect(items.filter((item) => item.kind === 'todo_list')).toEqual([expect.objectContaining({ todos: [{ content: 'A', status: 'completed' }] })])
    expect(items.some((item) => 'toolUseId' in item && item.toolUseId === 't2')).toBe(false)
  })
})

describe('tool helpers', () => {
  it('titles common tools and MCP tools', () => {
    expect(toolTitle('Grep', { pattern: 'drain', path: 'server' })).toBe('Search "drain" in server')
    expect(toolTitle('mcp__linear__get_issue', {})).toBe('linear · get_issue')
  })

  it('reads AskUserQuestion questions and TodoWrite todos defensively', () => {
    expect(questionsFromInput({ questions: [{ question: 'Which?', header: 'Pick', multiSelect: true, options: [{ label: 'A', description: 'first' }, { nope: 1 }] }, { bad: true }] }))
      .toEqual([{ question: 'Which?', header: 'Pick', multiSelect: true, options: [{ label: 'A', description: 'first' }] }])
    expect(todosFromInput({ todos: [{ content: ' x ', status: 'weird' }, {}] })).toEqual([{ content: 'x', status: 'pending' }])
  })
})
