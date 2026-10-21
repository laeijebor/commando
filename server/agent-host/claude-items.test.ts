import { readFileSync } from 'node:fs'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { describe, expect, it } from 'vitest'
import { ClaudeItemMapper, agentIdFromResult, parseRelayPrompt, planFromInput, questionsFromInput, relayPrompt, subagentReport, taskNotificationFromText, todosFromInput, toolTitle } from './claude-items.js'

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
    mapper.request('r1', undefined, { requestKind: 'approval', toolName: 'Bash', title: 'Allow Bash?', detail: 'git push' })
    mapper.request('r2', undefined, { requestKind: 'approval', toolName: 'Bash', title: 'Allow Bash?', detail: 'rm -rf build' })
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

describe('ClaudeItemMapper ordering', () => {
  const stream = (event: Record<string, unknown>, parent: string | null = null) => ({ type: 'stream_event', event, parent_tool_use_id: parent, uuid: 'u', session_id: 's' }) as unknown as SDKMessage
  const assistant = (id: string, content: unknown[], parent: string | null = null) => ({ type: 'assistant', message: { id, content }, parent_tool_use_id: parent, uuid: 'a', session_id: 's' }) as unknown as SDKMessage

  it('keeps a subagent stream from stealing the main stream deltas', () => {
    const mapper = new ClaudeItemMapper(() => 1)
    mapper.startTurn('go')
    mapper.handle(stream({ type: 'message_start', message: { id: 'main' } }))
    mapper.handle(stream({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }))
    mapper.handle(stream({ type: 'message_start', message: { id: 'sub' } }, 'task-1'))
    mapper.handle(stream({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, 'task-1'))
    mapper.handle(stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'main text' } }))
    mapper.handle(stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'sub text' } }, 'task-1'))
    const texts = Object.fromEntries(mapper.list().filter((item) => item.kind === 'assistant_message').map((item) => [item.id, item.kind === 'assistant_message' && item.text]))
    expect(texts).toEqual({ 'main:0': 'main text', 'sub:0': 'sub text' })
  })

  it('keys blocks by order when there are no stream events, so text never overwrites thinking', () => {
    const mapper = new ClaudeItemMapper(() => 1)
    mapper.startTurn('go')
    mapper.handle(assistant('m1', [{ type: 'thinking', thinking: 'plan' }]))
    mapper.handle(assistant('m1', [{ type: 'text', text: 'answer' }]))
    expect(mapper.list().map((item) => [item.id, item.kind])).toEqual([
      ['user-' + mapper.currentTurnId, 'user_message'],
      ['m1:0', 'reasoning'],
      ['m1:1', 'assistant_message'],
    ])
  })

  it('keeps one todo list per turn', () => {
    let clock = 1
    const mapper = new ClaudeItemMapper(() => clock++)
    mapper.startTurn('first')
    mapper.handle(assistant('a', [{ type: 'tool_use', id: 't1', name: 'TodoWrite', input: { todos: [{ content: 'A', status: 'pending' }] } }]))
    mapper.startTurn('second')
    mapper.handle(assistant('b', [{ type: 'tool_use', id: 't2', name: 'TodoWrite', input: { todos: [{ content: 'B', status: 'pending' }] } }]))
    expect(mapper.list().filter((item) => item.kind === 'todo_list')).toHaveLength(2)
  })

  it('keeps only the newest items', () => {
    const mapper = new ClaudeItemMapper(() => 1)
    for (let index = 0; index < 2100; index += 1) mapper.notice('info', `n${index}`)
    expect(mapper.list()).toHaveLength(2000)
    expect(mapper.list()[0]).toMatchObject({ text: 'n100' })
  })
})

describe('ClaudeItemMapper replay', () => {
  it('skips transcript entries Claude Code wrote itself and marks unfinished tools interrupted', () => {
    const mapper = new ClaudeItemMapper(() => 1)
    const items = mapper.replay([
      { type: 'user', message: { content: 'Fix it' }, parent_tool_use_id: null },
      { type: 'assistant', message: { id: 'm1', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'sleep 100' } }] }, parent_tool_use_id: null },
      { type: 'user', message: { content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] }, parent_tool_use_id: null },
      { type: 'user', message: { content: 'This session is being continued from a previous conversation that ran out of context.' }, parent_tool_use_id: null },
      { type: 'user', message: { content: 'Next step' }, parent_tool_use_id: null },
    ])
    expect(items.map((item) => [item.kind, item.status])).toEqual([
      ['user_message', 'completed'], ['command', 'interrupted'], ['user_message', 'completed'],
    ])
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

describe('ClaudeItemMapper images', () => {
  const sink = { saveBase64: (data: string) => (data === 'cGln' ? { id: `${'e'.repeat(64)}.png` } : undefined) }
  const image = (data: string) => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data } })

  it('shows images from tool results instead of an [image] placeholder', () => {
    const mapper = new ClaudeItemMapper(() => 1, sink)
    mapper.startTurn('read the screenshot')
    mapper.handle({ type: 'assistant', message: { id: 'm1', content: [{ type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: '/w/shot.png' } }] }, parent_tool_use_id: null } as unknown as SDKMessage)
    const [item] = mapper.handle({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: [image('cGln'), image('bad'), { type: 'text', text: 'done' }] }] }, parent_tool_use_id: null } as unknown as SDKMessage)
    expect(item).toMatchObject({ kind: 'tool', images: [{ id: `${'e'.repeat(64)}.png` }], output: '[image]\ndone' })
  })

  it('replays sent images and hides the saved-path notes the host added', () => {
    const mapper = new ClaudeItemMapper(() => 1, sink)
    const items = mapper.replay([{
      type: 'user',
      parent_tool_use_id: null,
      message: { role: 'user', content: [image('cGln'), { type: 'text', text: 'what is this?\n\n[Attached image "pane.png" is saved at: /images/x.png]' }] },
    }])
    expect(items).toEqual([expect.objectContaining({ kind: 'user_message', text: 'what is this?', images: [{ id: `${'e'.repeat(64)}.png` }] })])
  })

  it('marks /clear with a notice', () => {
    const mapper = new ClaudeItemMapper(() => 1)
    expect(mapper.handle({ type: 'conversation_reset', new_conversation_id: 'n', uuid: 'n', session_id: 's' } as unknown as SDKMessage))
      .toEqual([expect.objectContaining({ kind: 'notice', level: 'info' })])
  })

  it('forgets the timeline on clear', () => {
    const mapper = new ClaudeItemMapper(() => 1)
    mapper.startTurn('first question')
    mapper.clear()
    expect(mapper.list()).toEqual([])
  })
})

describe('ClaudeItemMapper replay of unstorable images', () => {
  it('keeps an image-only turn whose image could not be stored', () => {
    const mapper = new ClaudeItemMapper(() => 1, { saveBase64: () => undefined })
    const items = mapper.replay([{ type: 'user', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'eA==' } }] } }])
    expect(items).toEqual([expect.objectContaining({ kind: 'user_message', text: '[image]' })])
  })
})

// Recorded from Claude Code 2.1.296 via Agent SDK 0.3.295 (Haiku, plan mode):
// the canUseTool call for ExitPlanMode, which the host denies after capturing
// the plan, and the stream around it. Paths rewritten to /work and /home/me.
const planFixture = JSON.parse(readFileSync(new URL('./fixtures/claude-exit-plan-mode.json', import.meta.url), 'utf8')) as {
  canUseTool: { toolName: string; input: Record<string, unknown>; options: { toolUseID: string } }[]
  messages: SDKMessage[]
}

// Recorded the same way (bypass mode): two Agent calls in one turn, each
// running one Bash command, with forwardSubagentText on.
const subagentFixture = JSON.parse(readFileSync(new URL('./fixtures/claude-subagents.json', import.meta.url), 'utf8')) as SDKMessage[]

describe('ClaudeItemMapper plans', () => {
  it('pins the ExitPlanMode input shape: the plan is an untyped `plan` string', () => {
    const call = planFixture.canUseTool.find((entry) => entry.toolName === 'ExitPlanMode')!
    expect(Object.keys(call.input).sort()).toEqual(['plan', 'planFilePath'])
    expect(planFromInput(call.input)).toMatch(/^# Add greeting\.txt\n/)
    expect(planFromInput({ allowedPrompts: [] })).toBeNull()
    expect(planFromInput({ plan: '   ' })).toBeNull()
  })

  it('turns the recorded ExitPlanMode call into one plan item, not a tool row', () => {
    const mapper = new ClaudeItemMapper(() => 1)
    mapper.startTurn('plan it')
    const items = replay(mapper, planFixture.messages)
    const call = planFixture.canUseTool[0]!
    expect(items.filter((item) => item.kind === 'plan')).toEqual([
      expect.objectContaining({ id: `plan-${call.options.toolUseID}`, toolUseId: call.options.toolUseID, text: planFromInput(call.input), status: 'completed' }),
    ])
    expect(items.some((item) => item.kind === 'tool' && item.toolName === 'ExitPlanMode')).toBe(false)
    // canUseTool emits the same item first; the assistant message only upserts it.
    expect(mapper.plan(call.options.toolUseID, 'x')).toHaveLength(1)
    expect(mapper.list().filter((item) => item.kind === 'plan')).toHaveLength(1)
  })
})

describe('ClaudeItemMapper subagents', () => {
  it('maps the recorded parallel Agent calls and their task events to subagent rows', () => {
    let clock = 1_000
    const mapper = new ClaudeItemMapper(() => clock++)
    mapper.startTurn('two subagents')
    const items = replay(mapper, subagentFixture)
    const subagents = items.filter((item) => item.kind === 'subagent')
    expect(subagents).toEqual([
      expect.objectContaining({ description: 'count files', subagentType: 'general-purpose', agentId: 'ab05457106921d1bd', state: 'completed', status: 'completed', toolUses: 1, prompt: 'Run `ls` with Bash and reply with how many entries you saw.' }),
      expect.objectContaining({ description: 'print date', subagentType: 'general-purpose', agentId: 'a04229816544e4527', state: 'completed', status: 'completed', toolUses: 1 }),
    ])
    // The report without Claude Code's hand-back frame and trailer.
    expect(subagents[1]).toMatchObject({ output: 'The output of `date` is:\n\n```\nSun 11 Oct 2026 11:14:18 BST\n```' })
    // Each subagent's own work and text carry its Agent call as their parent.
    const own = items.filter((item) => item.parentToolUseId === subagents[1]!.id)
    expect(own.map((item) => item.kind)).toEqual(['command', 'assistant_message'])
    expect(items.filter((item) => item.kind === 'tool' && (item.toolName === 'Agent' || item.toolName === 'Task'))).toEqual([])
  })

  const system = (fields: Record<string, unknown>) => ({ type: 'system', uuid: 'u', session_id: 's', ...fields }) as unknown as SDKMessage
  const agentCall = (id: string, input: Record<string, unknown>) => ({ type: 'assistant', message: { id: `m-${id}`, content: [{ type: 'tool_use', id, name: 'Agent', input }] }, parent_tool_use_id: null }) as unknown as SDKMessage
  const result = (id: string, text: string) => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text }] }] }, parent_tool_use_id: null }) as unknown as SDKMessage

  it('keeps a background subagent running past the turn until its notification', () => {
    const mapper = new ClaudeItemMapper(() => 1)
    mapper.startTurn('go')
    mapper.handle(agentCall('tu1', { description: 'fruit waiter', subagent_type: 'general-purpose', run_in_background: true, prompt: 'wait' }))
    mapper.handle(system({ subtype: 'task_started', task_id: 'a711', tool_use_id: 'tu1', description: 'fruit waiter', subagent_type: 'general-purpose', task_type: 'local_agent', is_backgrounded: true }))
    mapper.handle(result('tu1', 'Async agent launched successfully.\nagentId: a711 (internal ID)'))
    mapper.handle({ type: 'assistant', message: { id: 'm-sub', content: [{ type: 'tool_use', id: 'tu-bash', name: 'Bash', input: { command: 'sleep 1' } }] }, parent_tool_use_id: 'tu1' } as unknown as SDKMessage)
    mapper.handle({ type: 'result', subtype: 'success' } as unknown as SDKMessage)
    expect(mapper.list().find((item) => item.id === 'tu1')).toMatchObject({ state: 'running', status: 'running', background: true, agentId: 'a711' })
    expect(mapper.list().find((item) => item.id === 'tu-bash')).toMatchObject({ status: 'running' })
    mapper.handle(system({ subtype: 'task_progress', task_id: 'a711', tool_use_id: 'tu1', description: 'Running Sleep', usage: { total_tokens: 10, tool_uses: 2, duration_ms: 3000 }, last_tool_name: 'Bash' }))
    expect(mapper.list().find((item) => item.id === 'tu1')).toMatchObject({ toolUses: 2, durationMs: 3000, lastToolName: 'Bash', summary: 'Running Sleep' })
    mapper.handle(system({ subtype: 'task_notification', task_id: 'a711', tool_use_id: 'tu1', status: 'stopped', summary: 'Stopped by the user', output_file: '' }))
    expect(mapper.list().find((item) => item.id === 'tu1')).toMatchObject({ state: 'stopped', status: 'interrupted', summary: 'Stopped by the user' })
  })

  it('runs a subagent again when SendMessage resumes it under another tool_use id', () => {
    const mapper = new ClaudeItemMapper(() => 1)
    mapper.startTurn('go')
    mapper.handle(agentCall('tu1', { description: 'waiter', run_in_background: true }))
    mapper.handle(system({ subtype: 'task_started', task_id: 'a711', tool_use_id: 'tu1', description: 'waiter', subagent_type: 'general-purpose' }))
    mapper.handle(system({ subtype: 'task_notification', task_id: 'a711', tool_use_id: 'tu1', status: 'completed', summary: 'NONE', output_file: '' }))
    mapper.handle(system({ subtype: 'task_started', task_id: 'a711', tool_use_id: 'tu-send', description: 'waiter', subagent_type: 'general-purpose' }))
    expect(mapper.list().filter((item) => item.kind === 'subagent')).toEqual([expect.objectContaining({ id: 'tu1', state: 'running', status: 'running' })])
    mapper.handle(system({ subtype: 'task_notification', task_id: 'a711', tool_use_id: 'tu-send', status: 'completed', summary: 'MANGO', output_file: '' }))
    expect(mapper.list().find((item) => item.id === 'tu1')).toMatchObject({ state: 'completed', summary: 'MANGO' })
  })

  it('ignores shell tasks and marks a foreground subagent stopped when the session ends', () => {
    const mapper = new ClaudeItemMapper(() => 1)
    mapper.startTurn('go')
    expect(mapper.handle(system({ subtype: 'task_started', task_id: 'b1', tool_use_id: 'tu-bash', description: 'Sleep', task_type: 'local_bash' }))).toEqual([])
    mapper.handle(agentCall('tu1', { description: 'reviewer' }))
    expect(mapper.settleRunning('interrupted')).toEqual([expect.objectContaining({ id: 'tu1', state: 'stopped', status: 'interrupted' })])
  })

  it('rebuilds subagent ids and endings from a saved transcript', () => {
    const mapper = new ClaudeItemMapper(() => 1)
    const items = mapper.replay([
      { type: 'user', parent_tool_use_id: null, message: { role: 'user', content: 'start a waiter' } },
      { type: 'assistant', parent_tool_use_id: null, message: { id: 'm1', content: [{ type: 'tool_use', id: 'tu1', name: 'Agent', input: { description: 'waiter', run_in_background: true } }] } },
      { type: 'user', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: [{ type: 'text', text: 'Async agent launched successfully.\nagentId: a8b6 (internal ID)' }] }] } },
      { type: 'user', parent_tool_use_id: null, message: { role: 'user', content: '<task-notification>\n<task-id>a8b6</task-id>\n<tool-use-id>tu1</tool-use-id>\n<status>completed</status>\n<summary>Agent "waiter" finished</summary>\n</task-notification>' } },
    ])
    expect(items.map((item) => item.kind)).toEqual(['user_message', 'subagent'])
    expect(items[1]).toMatchObject({ agentId: 'a8b6', state: 'completed', status: 'completed', summary: 'Agent "waiter" finished' })
    const stopped = new ClaudeItemMapper(() => 1).replay([
      { type: 'assistant', parent_tool_use_id: null, message: { id: 'm2', content: [{ type: 'tool_use', id: 'tu2', name: 'Agent', input: { description: 'slow one' } }] } },
      { type: 'user', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu2', is_error: true, content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] }] } },
    ])
    expect(stopped[0]).toMatchObject({ state: 'stopped', status: 'interrupted' })
  })

  it('shows a relayed message as the user typed it, with its target', () => {
    const prompt = relayPrompt('The fruit is MANGO.', { agentId: 'a711', label: 'fruit waiter' })
    expect(parseRelayPrompt(prompt)).toEqual({ text: 'The fruit is MANGO.', relayTo: { agentId: 'a711', label: 'fruit waiter' } })
    const items = new ClaudeItemMapper(() => 1).replay([{ type: 'user', parent_tool_use_id: null, message: { role: 'user', content: prompt } }])
    expect(items).toEqual([expect.objectContaining({ kind: 'user_message', text: 'The fruit is MANGO.', relayTo: { agentId: 'a711', label: 'fruit waiter' } })])
  })

  it('reads ids and reports from Agent results', () => {
    expect(agentIdFromResult('done\nagentId: a04229816544e4527 (use SendMessage…)')).toBe('a04229816544e4527')
    expect(agentIdFromResult('no id here')).toBeUndefined()
    expect(subagentReport('plain text')).toBe('plain text')
    const mapper = new ClaudeItemMapper(() => 1)
    mapper.replay([
      { type: 'assistant', parent_tool_use_id: null, message: { id: 'm', content: [{ type: 'tool_use', id: 'tu', name: 'Agent', input: { description: 'd' } }] } },
      { type: 'user', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu', content: [{ type: 'text', text: 'done\nagentId: a1 (x)\n<usage>subagent_tokens: 9\ntool_uses: 3\nduration_ms: 5373</usage>' }] }] } },
    ])
    expect(mapper.list()[0]).toMatchObject({ toolUses: 3, durationMs: 5373, output: 'done\nagentId: a1 (x)\n<usage>subagent_tokens: 9\ntool_uses: 3\nduration_ms: 5373</usage>' })
    expect(taskNotificationFromText('hello')).toBeNull()
  })
})
