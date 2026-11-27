import { describe, expect, it } from 'vitest'
import { MAX_CHAT_ITEMS, parseChatItem } from '../../../shared/agent-chat.js'
import { CursorItemMapper, parseCursorTranscriptJsonl, QUESTION_REFUSED } from './items.js'

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
  it('shows a refused question as one notice, live and in replay', () => {
    const mapper = new CursorItemMapper()
    mapper.begin('t')
    mapper.delta({ type: 'tool-call-started', callId: 'q', toolCall: { type: 'askQuestion', args: { questions: [] } } })
    mapper.delta({ type: 'tool-call-completed', callId: 'q', toolCall: { type: 'askQuestion', args: { questions: [] }, result: { status: 'error' } } })
    expect(mapper.list()).toMatchObject([{ kind: 'notice', level: 'info', status: 'completed', text: QUESTION_REFUSED }])
    mapper.replay({ type: 'agentConversationTurn', turn: { steps: [{ type: 'toolCall', message: { type: 'askQuestion', args: {} } }] } })
    expect(mapper.list().filter((item) => item.kind === 'notice')).toHaveLength(2)
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
  it('formats MCP tool calls with server, tool name, text content and tool-level errors', () => {
    const mapper = new CursorItemMapper()
    const ok = tool(mapper, 'mcp', {
      providerIdentifier: 'github',
      toolName: 'create_issue',
      args: { title: 'Fix bug' },
    }, {
      status: 'success',
      value: { content: [{ text: { text: 'Created #42' } }, { text: { text: 'https://github.com/o/r/issues/42' } }], isError: false },
    })
    expect(ok).toMatchObject({
      kind: 'tool',
      toolName: 'mcp',
      title: 'github · create_issue',
      status: 'completed',
      detail: JSON.stringify({ title: 'Fix bug' }, null, 2),
      output: 'Created #42\nhttps://github.com/o/r/issues/42',
    })
    expect(ok).not.toHaveProperty('isError')
    const toolErr = tool(mapper, 'mcp', {
      providerIdentifier: 'linear',
      toolName: 'list_issues',
      args: {},
    }, {
      status: 'success',
      value: { content: [{ text: { text: 'Unauthorized' } }], isError: true },
    })
    expect(toolErr).toMatchObject({
      kind: 'tool',
      title: 'linear · list_issues',
      status: 'failed',
      isError: true,
      output: 'Unauthorized',
    })
    expect(tool(mapper, 'mcp', { toolName: 'ping' })).toMatchObject({ title: 'MCP · ping' })
    expect(tool(mapper, 'mcp', { providerIdentifier: 'docs' })).toMatchObject({ title: 'MCP · docs' })
    expect(mapper.list().every((item) => parseChatItem(item))).toBe(true)
  })
  it('replays user, assistant, thinking, tool and shell turns with stable item updates', () => {
    const mapper = new CursorItemMapper()
    mapper.replay({ type: 'agentConversationTurn', turn: { userMessage: { text: 'Old' }, steps: [
      { type: 'thinkingMessage', message: { text: 'Thinking' } }, { type: 'assistantMessage', message: { text: 'Hello' } },
      { type: 'toolCall', message: { type: 'task', args: { description: 'Investigate', prompt: 'Inspect', agentId: 'child' }, result: { status: 'success', value: {} } } },
    ] } })
    mapper.replay({ type: 'shellConversationTurn', turn: { shellCommand: { command: 'ls' }, shellOutput: { stdout: 'a', stderr: '', exitCode: 0 } } })
    expect(mapper.list()).toMatchObject([{ kind: 'user_message', text: 'Old' }, { kind: 'reasoning', text: 'Thinking' }, { kind: 'assistant_message', text: 'Hello' },
      { kind: 'subagent', prompt: 'Inspect', state: 'completed' }, { kind: 'command', command: 'ls', output: 'a' }])
    expect(mapper.list().every((item) => parseChatItem(item))).toBe(true)
    // The SDK has no subagent controls, so the row must not look like a stoppable external run.
    expect(mapper.list().find((item) => item.kind === 'subagent')).not.toHaveProperty('runtime')
    expect(mapper.list().find((item) => item.kind === 'subagent')).not.toHaveProperty('agentId')
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
  it('streams shell-output-delta stdout/stderr into the active running shell and replaces with authoritative output on completion', () => {
    let now = 10
    const mapper = new CursorItemMapper(() => ++now)
    mapper.begin('t1')
    expect(mapper.delta({ type: 'shell-output-delta', event: { case: 'stdout', value: { data: 'ignored' } } })).toEqual([])

    mapper.delta({ type: 'tool-call-started', callId: 'sh1', toolCall: { type: 'shell', args: { command: 'npm test' } } })
    const out1 = mapper.delta({ type: 'shell-output-delta', event: { case: 'stdout', value: { data: 'line 1\n' } } })
    expect(out1).toMatchObject([{ kind: 'command', command: 'npm test', output: 'line 1\n', status: 'running' }])
    const out2 = mapper.delta({ type: 'shell-output-delta', event: { case: 'stderr', value: { data: 'warn\n' } } })
    expect(out2).toMatchObject([{ kind: 'command', output: 'line 1\nwarn\n', status: 'running' }])
    // Partial tool call without result must not wipe streamed output.
    const partial = mapper.delta({ type: 'partial-tool-call', callId: 'sh1', toolCall: { type: 'shell', args: { command: 'npm test' } } })
    expect(partial).toMatchObject([{ kind: 'command', output: 'line 1\nwarn\n', status: 'running' }])
    // Completion replaces streamed output with authoritative stdout + stderr and clears active shell tracking.
    const done = mapper.delta({
      type: 'tool-call-completed',
      callId: 'sh1',
      toolCall: { type: 'shell', args: { command: 'npm test' }, result: { status: 'success', value: { stdout: 'final out\n', stderr: 'final err\n' } } },
    })
    expect(done).toMatchObject([{ kind: 'command', output: 'final out\nfinal err\n', status: 'completed' }])
    expect(mapper.delta({ type: 'shell-output-delta', event: { case: 'stdout', value: { data: 'late' } } })).toEqual([])

    // Settle also clears activeShellId.
    mapper.delta({ type: 'tool-call-started', callId: 'sh2', toolCall: { type: 'shell', args: { command: 'sleep 10' } } })
    mapper.settle('t1', 'interrupted')
    expect(mapper.delta({ type: 'shell-output-delta', event: { case: 'stdout', value: { data: 'after settle' } } })).toEqual([])
    expect(mapper.list().every((item) => parseChatItem(item))).toBe(true)
  })
  it('streams subagent tool-call-delta child items with parentToolUseId and settles them on task completion', () => {
    const mapper = new CursorItemMapper(() => 100)
    mapper.begin('turn-1')
    const [started] = mapper.delta({
      type: 'tool-call-started',
      callId: 'task-1',
      toolCall: { type: 'task', args: { description: 'Explore repo', prompt: 'Find files', model: 'auto' } },
    })
    expect(started).toMatchObject({ id: 'cursor:turn-1:tool:task-1', kind: 'subagent', state: 'running' })
    // Running subagents must never expose agentId (no stop/background controls in Cursor SDK).
    expect(started).not.toHaveProperty('agentId')

    mapper.delta({ type: 'tool-call-delta', callId: 'task-1', taskUpdate: { type: 'thinking-delta', text: 'Checking' } })
    mapper.delta({ type: 'tool-call-delta', callId: 'task-1', taskUpdate: { type: 'thinking-completed' } })
    mapper.delta({ type: 'tool-call-delta', callId: 'task-1', taskUpdate: { type: 'text-delta', text: 'Scanning...' } })
    mapper.delta({
      type: 'tool-call-delta',
      callId: 'task-1',
      taskUpdate: { type: 'tool-call-started', callId: 'nested-1', toolCall: { type: 'read', args: { path: 'README.md' } } },
    })
    mapper.delta({
      type: 'tool-call-delta',
      callId: 'task-1',
      taskUpdate: { type: 'tool-call-completed', callId: 'nested-1', toolCall: { type: 'read', args: { path: 'README.md' }, result: { status: 'success', value: { text: '# Hi' } } } },
    })
    mapper.delta({ type: 'tool-call-delta', callId: 'task-1', taskUpdate: { type: 'text-delta', text: 'Found it' } })

    const children = mapper.list().filter((item) => item.parentToolUseId === started!.id)
    expect(children).toMatchObject([
      { kind: 'reasoning', text: 'Checking', status: 'completed', parentToolUseId: started!.id },
      { kind: 'assistant_message', text: 'Scanning...', status: 'completed', parentToolUseId: started!.id },
      { kind: 'tool', toolName: 'read', title: 'Read file: README.md', status: 'completed', parentToolUseId: started!.id },
      { kind: 'assistant_message', text: 'Found it', status: 'running', parentToolUseId: started!.id },
    ])
    expect(children.every((item) => item.id.startsWith('cursor:turn-1:sub:task-1:'))).toBe(true)

    const completedBatch = mapper.delta({
      type: 'tool-call-completed',
      callId: 'task-1',
      toolCall: {
        type: 'task',
        args: { description: 'Explore repo', prompt: 'Find files' },
        result: {
          status: 'success',
          value: {
            agentId: 'sub-abc',
            isBackground: true,
            durationMs: 1234,
            resultSuffix: 'Saved report.',
            conversationSteps: [
              { type: 'thinkingMessage', message: { text: 'Plan' } },
              { type: 'toolCall', message: { type: 'read', args: { path: 'a.ts' }, result: { status: 'success', value: {} } } },
              { type: 'assistantMessage', message: { text: 'Final summary' } },
            ],
          },
        },
      },
    })
    const completedParent = completedBatch.at(-1)!
    expect(completedParent).toMatchObject({
      kind: 'subagent',
      state: 'completed',
      agentId: 'sub-abc',
      background: true,
      durationMs: 1234,
      output: 'Final summary\n\nSaved report.',
    })
    // Still-running child item was settled when the parent task completed.
    expect(mapper.list().filter((item) => item.parentToolUseId === started!.id).every((item) => item.status === 'completed')).toBe(true)
    expect(mapper.list().every((item) => parseChatItem(item))).toBe(true)

    // Subagent transcript replays stored conversationSteps.
    const transcript = mapper.subagentTranscript('sub-abc')
    expect(transcript?.items).toMatchObject([
      { kind: 'reasoning', text: 'Plan', status: 'completed' },
      { kind: 'tool', toolName: 'read', title: 'Read file: a.ts', status: 'completed' },
      { kind: 'assistant_message', text: 'Final summary', status: 'completed' },
    ])
    expect(transcript?.items.every((item) => parseChatItem(item))).toBe(true)

    // clear() resets items, active shell, and stored subagents.
    mapper.clear()
    expect(mapper.list()).toEqual([])
    expect(mapper.subagentTranscript('sub-abc')).toBeNull()
  })
  it('supports proto-JSON conversationSteps and transcriptPath-only subagents', () => {
    const mapper = new CursorItemMapper(() => 50)
    mapper.begin('turn-2')
    const protoTask = tool(mapper, 'task', { description: 'Proto', prompt: 'Check' }, {
      status: 'success',
      value: {
        agentId: 'proto-agent',
        conversationSteps: [
          { toolCall: { shellToolCall: { args: { command: 'echo hi' }, result: { success: { stdout: 'hi\n', stderr: '' } } } } },
          { assistantMessage: { text: 'Proto answer' } },
        ],
      },
    })
    expect(protoTask).toMatchObject({ kind: 'subagent', agentId: 'proto-agent', output: 'Proto answer' })
    expect(mapper.subagentTranscript('proto-agent')?.items).toMatchObject([
      { kind: 'command', command: 'echo hi', output: 'hi\n', status: 'completed' },
      { kind: 'assistant_message', text: 'Proto answer', status: 'completed' },
    ])

    const pathOnly = mapper.delta({
      type: 'tool-call-completed',
      callId: 'path-call',
      toolCall: {
        type: 'task',
        args: { description: 'File backed', prompt: 'Go' },
        result: { status: 'success', value: { transcriptPath: '/tmp/sub.jsonl' } },
      },
    }).at(-1)
    expect(pathOnly).toMatchObject({ kind: 'subagent', agentId: 'path-call' })
    expect(mapper.subagentTranscript('path-call')).toEqual({ items: [], transcriptPath: '/tmp/sub.jsonl' })
  })
  it('parses Cursor subagent JSONL transcripts cleanly', () => {
    const jsonl = [
      JSON.stringify({ role: 'user', message: { content: [{ type: 'text', text: 'Inspect files' }] } }),
      'not-valid-json',
      JSON.stringify({
        role: 'assistant',
        message: {
          content: [
            { type: 'thinking', thinking: 'Let me check' },
            { type: 'tool_use', id: 'tu-1', name: 'Shell', input: { command: 'ls' } },
            { type: 'text', text: 'Checked directory' },
          ],
        },
      }),
      JSON.stringify({
        role: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'tu-1', content: 'a.ts\nb.ts' }] },
      }),
    ].join('\n')
    const items = parseCursorTranscriptJsonl(jsonl, 'sub-1', () => 1)
    expect(items).toMatchObject([
      { kind: 'user_message', text: 'Inspect files' },
      { kind: 'reasoning', text: 'Let me check' },
      { kind: 'command', command: 'ls', output: 'a.ts\nb.ts', status: 'completed' },
      { kind: 'assistant_message', text: 'Checked directory' },
    ])
    expect(items.every((item) => parseChatItem(item))).toBe(true)
  })

  it('preserves workingDirectory as cwd on shell command items', () => {
    const mapper = new CursorItemMapper(() => 1)
    mapper.begin('turn-cwd')
    const completed = mapper.delta({
      type: 'tool-call-completed',
      callId: 'shell-cwd',
      toolCall: {
        type: 'shell',
        args: { command: 'git push origin feat', workingDirectory: '/repos/other' },
        result: { status: 'success', value: { stdout: 'ok\n', stderr: '' } },
      },
    }).at(-1)
    expect(completed).toMatchObject({ kind: 'command', command: 'git push origin feat', cwd: '/repos/other', status: 'completed' })
    expect(parseChatItem(completed)).toMatchObject({ kind: 'command', cwd: '/repos/other' })
  })
})
