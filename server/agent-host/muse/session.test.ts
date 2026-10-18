import { describe, expect, it, vi } from 'vitest'
import { RpcError, type RpcId, type RpcNotification, type RpcRequest } from '../rpc-client.js'
import type { AgentSessionSpec } from '../session.js'
import { uuidv7, type MuseMethods, type MuseTransport } from './client.js'
import { MuseItemMapper } from './items.js'
import { MuseChatSession, imageMediaType, museAnswers, museApprovalMode, museChoice, museModels, museTuiSwitchCommand } from './session.js'

const SESSION = '01a14dc2-082e-7781-9892-8b5bc1fea332'
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
const V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

class FakeMuse implements MuseTransport {
  requests: { method: keyof MuseMethods; params: Record<string, unknown> }[] = []
  replies: { id: RpcId; result: unknown }[] = []
  notifications: ((message: RpcNotification) => void)[] = []
  handlers: ((message: RpcRequest) => boolean)[] = []
  closes: ((error?: Error) => void)[] = []
  history: unknown = { mode: 'inline', items: [] }
  failResume?: Error
  start = vi.fn(async () => ({}))
  onNotification(listener: (message: RpcNotification) => void) { this.notifications.push(listener) }
  onRequest(listener: (message: RpcRequest) => boolean) { this.handlers.push(listener) }
  onClose(listener: (error?: Error) => void) { this.closes.push(listener) }
  request = vi.fn(async <M extends keyof MuseMethods & string>(method: M, params: MuseMethods[M]): Promise<unknown> => {
    const values = params as Record<string, unknown>
    this.requests.push({ method, params: values })
    if (method === 'model/list') return { models: [{ modelId: 'muse-wonder-1.0', displayLabel: 'Wonder', variants: ['low', 'high', 'ultra'] }, { modelId: 'muse-spark-1.3', displayLabel: 'Spark', variants: 'unknown' }] }
    if (method === 'session/start') return { session: { sessionId: SESSION, modelId: 'muse-wonder-1.0', approvalMode: { mode: values.approvalMode } } }
    if (method === 'session/resume') {
      if (this.failResume) throw this.failResume
      return { session: { sessionId: SESSION, modelId: 'muse-wonder-1.0', name: 'wheat-horologium', nameOrigin: 'automatic', title: 'Old chat', approvalMode: { mode: 'onRequest' } }, history: this.history }
    }
    if (method === 'skill/list') return { skills: [{ selector: 'ab-testing', description: 'Plan an A/B test', source: 'user' }, { selector: 'bundled:git', displayName: 'git', source: 'bundled' }] }
    if (method === 'turn/start') {
      const turnId = values.commandId as string
      return { commandId: turnId, status: 'accepted', turnId, disposition: values.ifBusy === 'steer' && this.active ? 'steered' : 'started' }
    }
    return { commandId: values.commandId, status: 'accepted' }
  })
  active = false
  respond(id: RpcId, result: unknown) { this.replies.push({ id, result }) }
  notified: { method: string; params: unknown }[] = []
  notify(method: string, params: unknown) { this.notified.push({ method, params }) }
  reject() {}
  close() { this.closes.forEach((listener) => listener()) }
  emit(method: string, params: Record<string, unknown>) { this.notifications.forEach((listener) => listener({ method, params: { sessionId: SESSION, ...params } })) }
  server(method: string, params: Record<string, unknown>, id: RpcId = 'req-1') { return this.handlers.some((listener) => listener({ id, method, params: { sessionId: SESSION, ...params } })) }
  sent(method: keyof MuseMethods) { return this.requests.filter((request) => request.method === method).map((request) => request.params) }
}

function harness(spec: Partial<AgentSessionSpec> = {}) {
  const client = new FakeMuse()
  const session = new MuseChatSession({ paneId: '%3', cwd: '/repo', permissionMode: 'default', env: {}, ...spec }, client)
  return { session, client }
}

/** A started chat with one turn under way. */
async function running() {
  const result = harness()
  await result.session.start()
  result.session.send('Hello')
  await tick()
  const turnId = result.client.sent('turn/start')[0]!.commandId as string
  result.client.active = true
  result.client.emit('turn/started', { turnId })
  return { ...result, turnId }
}

describe('MuseChatSession', () => {
  it('starts a session in the pane folder with the chat\'s approval mode, then lists models and skills', async () => {
    const { session, client } = harness({ permissionMode: 'bypassPermissions' })
    await session.start()
    await tick()
    expect(client.sent('session/start')).toEqual([{ commandId: expect.stringMatching(V7), workspaceRoot: '/repo', approvalMode: 'allowAll' }])
    const info = session.snapshot().session
    expect(info).toMatchObject({ provider: 'muse', status: 'idle', sessionId: SESSION, model: 'muse-wonder-1.0', permissionMode: 'bypassPermissions' })
    expect(info.models).toEqual([
      { value: 'muse-wonder-1.0', resolvedModel: 'muse-wonder-1.0', displayName: 'Wonder', efforts: ['low', 'high'] },
      { value: 'muse-spark-1.3', resolvedModel: 'muse-spark-1.3', displayName: 'Spark' },
    ])
    expect(session.commands?.map((command) => command.name)).toEqual(['ab-testing', 'bundled:git'])
  })

  it('streams a turn and goes idle when it completes', async () => {
    const { session, client, turnId } = await running()
    expect(client.sent('turn/start')[0]).toMatchObject({ sessionId: SESSION, input: [{ type: 'text', text: 'Hello' }], ifBusy: 'steer' })
    expect(session.snapshot().session.status).toBe('running')
    client.emit('item/completed', { item: { itemId: 'u1', kind: 'userMessage', turnId, revision: 1, status: 'completed', text: 'Hello' } })
    client.emit('item/started', { item: { itemId: 'a1', kind: 'agentMessage', turnId, revision: 1, status: 'inProgress', text: '' } })
    client.emit('item/delta', { itemId: 'a1', field: 'text', delta: 'Hi ' })
    client.emit('item/delta', { itemId: 'a1', field: 'text', delta: 'there' })
    client.emit('item/started', { item: { itemId: 'r1', kind: 'reminderChild', turnId, revision: 1, status: 'inProgress' } })
    expect(session.snapshot().items.map((item) => [item.kind, 'text' in item ? item.text : ''])).toEqual([['user_message', 'Hello'], ['assistant_message', 'Hi there']])
    expect(session.busy).toBe(true)
    client.emit('turn/completed', { turnId, terminal: 'completed' })
    expect(session.snapshot().session.status).toBe('idle')
    expect(session.snapshot().items.every((item) => item.status === 'completed')).toBe(true)
  })

  it('steers a running turn, and queues for after it when asked', async () => {
    const { session, client, turnId } = await running()
    session.send('Also this')
    await tick()
    expect(client.sent('turn/start')).toHaveLength(2)
    session.send('Later', [], { delivery: 'queue' })
    expect(session.queued.map((entry) => entry.text)).toEqual(['Later'])
    client.active = false
    client.emit('turn/completed', { turnId, terminal: 'completed' })
    await tick()
    expect(client.sent('turn/start').map((params) => (params.input as { text: string }[])[0]!.text)).toEqual(['Hello', 'Also this', 'Later'])
  })

  it('runs a leading /skill as that skill with the rest as its arguments', async () => {
    const { session, client } = harness()
    await session.start()
    await tick()
    session.send('/ab-testing checkout button')
    session.send('/not-a-skill hi')
    await tick()
    expect(client.sent('turn/start').map((params) => params.input)).toEqual([
      [{ type: 'skill', selector: 'ab-testing', arguments: 'checkout button' }],
      [{ type: 'text', text: '/not-a-skill hi' }],
    ])
  })

  it('sends images inline with their media type and keeps the typed text for the transcript', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2])
    const { session, client } = harness({ images: { read: vi.fn(async () => png) } as never })
    await session.start()
    session.send('Look', [{ id: 'img-1' }])
    await tick()
    expect(client.sent('turn/start')[0]).toMatchObject({ input: [{ type: 'text', text: 'Look' }, { type: 'image', mediaType: 'image/png', base64Data: png.toString('base64') }], displayText: 'Look' })
  })

  it('interrupts the running turn and treats an already-finished turn as done', async () => {
    const { session, client, turnId } = await running()
    await session.interrupt()
    expect(client.sent('turn/interrupt')).toEqual([{ sessionId: SESSION, commandId: expect.stringMatching(V7), turnId }])
    client.request.mockRejectedValueOnce(new RpcError('rejected', -32030, { kind: 'commandRejected', reason: 'already_terminal' }))
    await session.interrupt()
    expect(session.snapshot().items.some((item) => item.kind === 'notice')).toBe(false)
  })

  it('acknowledges an approval at once and decides it with the matching offered choice', async () => {
    const { session, client, turnId } = await running()
    const approval = { turnId, itemId: 'tool-1', approvalId: 'ap-1', toolName: 'bash', currentRequirementId: { approvalId: 'ap-1', sourceIndex: 0 },
      subject: { kind: 'shell', command: 'rm -rf build' },
      availableChoices: [{ choiceId: 'c-once', decision: 'approved' }, { choiceId: 'c-session', decision: 'approvedForSession' }, { choiceId: 'c-deny', decision: 'denied' }] }
    expect(client.server('approval/request', approval)).toBe(true)
    // The same prompt also arrives as a notification.
    client.emit('approval/requested', approval)
    expect(client.replies).toEqual([{ id: 'req-1', result: {} }])
    const requests = session.snapshot().items.filter((item) => item.kind === 'request')
    expect(requests).toMatchObject([{ requestId: 'approval:ap-1', requestKind: 'approval', title: 'Allow bash?', detail: 'rm -rf build' }])
    expect(session.snapshot().session.status).toBe('waiting')
    expect(session.answer('approval:ap-1', { kind: 'approval', decision: 'allow_always' })).toBe(true)
    await tick()
    expect(client.sent('approval/decide')).toEqual([{ sessionId: SESSION, commandId: expect.stringMatching(V7), approvalId: 'ap-1', choiceId: 'c-session', requirementId: { approvalId: 'ap-1', sourceIndex: 0 } }])
    expect(session.snapshot().session.status).toBe('running')
  })

  it('decides with the choices an update brought, and asks again when Muse refuses the answer', async () => {
    const { session, client, turnId } = await running()
    client.server('approval/request', { turnId, approvalId: 'ap-2', toolName: 'bash', currentRequirementId: { approvalId: 'ap-2', sourceIndex: 0 }, subject: { kind: 'shell', command: 'ls' },
      availableChoices: [{ choiceId: 'old', decision: 'approved' }] })
    client.emit('approval/updated', { approvalId: 'ap-2', currentRequirementId: { approvalId: 'ap-2', sourceIndex: 1 }, availableChoices: [{ choiceId: 'new', decision: 'approved' }] })
    client.request.mockRejectedValueOnce(new RpcError('stale requirement', -32053, { kind: 'staleRequirement' }))
    expect(session.answer('approval:ap-2', { kind: 'approval', decision: 'allow' })).toBe(true)
    await tick()
    expect(client.request.mock.calls.find(([method]) => method === 'approval/decide')?.[1]).toMatchObject({ choiceId: 'new', requirementId: { approvalId: 'ap-2', sourceIndex: 1 } })
    // The prompt is back, so the turn is not left waiting on nothing.
    expect(session.snapshot().items.find((item) => item.kind === 'request')).toMatchObject({ requestId: 'approval:ap-2', status: 'running' })
    expect(session.snapshot().session.status).toBe('waiting')
    expect(session.answer('approval:ap-2', { kind: 'approval', decision: 'allow' })).toBe(true)
  })

  it('stops Muse\'s countdown on a question shown here and says when Muse gave up waiting', async () => {
    const { session, client, turnId } = await running()
    client.server('userInput/request', { turnId, userInputId: 'in-9', autoResolutionMs: 60_000, questions: [{ id: 'q', question: 'Go?', selection: { mode: 'single' }, options: [{ label: 'Yes' }] }] })
    expect(client.notified).toEqual([{ method: 'userInput/engaged', params: { sessionId: SESSION, userInputId: 'in-9' } }])
    client.emit('userInput/settled', { userInputId: 'in-9', outcome: 'timedOut' })
    expect(session.snapshot().items.find((item) => item.kind === 'request')).toMatchObject({ answer: { kind: 'cancelled', reason: 'Muse stopped waiting for an answer' } })
  })

  it('shows why a turn failed', async () => {
    const { session, client, turnId } = await running()
    client.emit('turn/completed', { turnId, terminal: 'failed', error: { message: 'Quota exceeded' } })
    expect(session.snapshot().items.at(-1)).toMatchObject({ kind: 'notice', level: 'error', text: 'Muse stopped: Quota exceeded' })
  })

  it('answers a question by option label, and cancels it when dismissed', async () => {
    const { session, client, turnId } = await running()
    const questions = [{ id: 'q1', header: 'Pick', question: 'Which DB?', selection: { mode: 'single' }, options: [{ label: 'Postgres' }, { label: 'SQLite' }] }]
    client.server('userInput/request', { turnId, itemId: 'tool-2', userInputId: 'in-1', toolName: 'request_user_input', questions })
    expect(session.snapshot().items.find((item) => item.kind === 'request')).toMatchObject({ requestKind: 'question', questions: [{ question: 'Which DB?', options: [{ label: 'Postgres' }, { label: 'SQLite' }], multiSelect: false }] })
    expect(session.answer('question:in-1', { kind: 'question', answers: { 'Which DB?': 'SQLite' } })).toBe(true)
    client.server('userInput/request', { turnId, itemId: 'tool-3', userInputId: 'in-2', questions }, 'req-2')
    expect(session.answer('question:in-2', { kind: 'approval', decision: 'deny' })).toBe(true)
    await tick()
    expect(client.sent('userInput/answer')).toEqual([{ sessionId: SESSION, commandId: expect.stringMatching(V7), userInputId: 'in-1', answers: [{ questionId: 'q1', selectedLabel: 'SQLite' }] }])
    expect(client.sent('userInput/cancel')).toEqual([{ sessionId: SESSION, commandId: expect.stringMatching(V7), userInputId: 'in-2' }])
  })

  it('resumes a conversation, replays its history and re-applies the chat\'s picks', async () => {
    const { session, client } = harness({ resume: SESSION, permissionMode: 'bypassPermissions', model: 'muse-spark-1.3', effort: 'high' })
    client.history = { mode: 'snapshot', items: null, snapshot: { state: {
      items: [
        { itemId: 'u0', kind: 'userMessage', turnId: 't0', revision: 1, status: 'completed', text: 'Earlier' },
        { itemId: 'a0', kind: 'agentMessage', turnId: 't0', revision: 2, status: 'completed', text: 'Earlier reply' },
        { itemId: 'b0', kind: 'toolCall', turnId: 't0', revision: 1, status: 'inProgress', tool: 'bash', args: '{"command":"npm test"}' },
      ],
      todoList: { items: [{ text: 'Write tests', status: 'inProgress' }] },
    } } }
    await session.start()
    expect(client.sent('session/resume')).toEqual([{ commandId: expect.stringMatching(V7), sessionId: SESSION, history: 'auto' }])
    expect(client.sent('session/setApprovalMode')).toMatchObject([{ mode: 'allowAll' }])
    expect(client.sent('session/setModel')).toMatchObject([{ model: { modelId: 'muse-spark-1.3' } }])
    expect(client.sent('session/setReasoningEffort')).toMatchObject([{ reasoningEffort: 'high' }])
    expect(session.snapshot().session.title).toBe('Old chat')
    expect(session.snapshot().items.map((item) => [item.kind, item.status])).toEqual([
      ['user_message', 'completed'], ['assistant_message', 'completed'], ['command', 'interrupted'], ['todo_list', 'completed'],
    ])
  })

  it('explains a conversation that is open somewhere else', async () => {
    const { session, client } = harness({ resume: SESSION })
    client.failResume = new RpcError('session in use', -32021, { kind: 'sessionInUse' })
    await session.start()
    expect(session.snapshot().session).toMatchObject({ status: 'error', error: expect.stringContaining('open somewhere else') })
  })

  it('resumes a session Muse unloaded while idle before the next message', async () => {
    const { session, client } = harness()
    await session.start()
    client.emit('session/closed', { reason: 'idle' })
    session.send('Still there?')
    await tick()
    expect(client.requests.map((request) => request.method).filter((method) => method.startsWith('session/') || method === 'turn/start'))
      .toEqual(['session/start', 'session/resume', 'turn/start'])
  })

  it('changes model, effort and approval mode on the live session', async () => {
    const { session, client } = harness({ bypassAllowed: true })
    await session.start()
    await session.configure({ model: 'muse-spark-1.3' })
    await session.configure({ effort: 'low' })
    await session.configure({ permissionMode: 'bypassPermissions' })
    await session.configure({ permissionMode: 'plan' })
    expect(client.sent('session/setModel')).toMatchObject([{ model: { modelId: 'muse-spark-1.3' } }])
    expect(client.sent('session/setReasoningEffort')).toMatchObject([{ reasoningEffort: 'low' }])
    expect(client.sent('session/setApprovalMode')).toMatchObject([{ mode: 'allowAll' }])
    expect(session.snapshot().session).toMatchObject({ selectedModel: 'muse-spark-1.3', effort: 'low', permissionMode: 'bypassPermissions' })
    expect(session.snapshot().items.at(-1)).toMatchObject({ kind: 'notice', text: expect.stringContaining('permission mode plan') })
  })

  it('reports a host that exits underneath it', async () => {
    const { session, client } = await running()
    const closed = vi.fn()
    session.on('closed', closed)
    client.closes.forEach((listener) => listener(new Error('Muse exited (1)')))
    expect(session.snapshot().session).toMatchObject({ status: 'error', error: 'Muse exited (1)' })
    expect(closed).toHaveBeenCalled()
  })
})

describe('Muse helpers', () => {
  it('maps permission modes and has no plan mode', () => {
    expect(museApprovalMode('default')).toBe('onRequest')
    expect(museApprovalMode('acceptEdits')).toBe('onRequest')
    expect(museApprovalMode('bypassPermissions')).toBe('allowAll')
    expect(() => museApprovalMode('plan')).toThrow(/plan/)
  })

  it('picks only choices Muse offered', () => {
    const choices = [{ choiceId: 'once', decision: 'approved' }, { choiceId: 'rule', decision: 'approvedPolicyAmendment' }, { choiceId: 'stop', decision: 'abort' }]
    expect(museChoice(choices, 'allow')).toBe('once')
    expect(museChoice(choices, 'allow_always')).toBe('rule')
    expect(museChoice(choices, 'deny')).toBe('stop')
    expect(museChoice([], 'allow')).toBeUndefined()
  })

  it('turns chat answers into labels, several labels, or free text', () => {
    const questions = [
      { id: 'a', question: 'One?', selection: { mode: 'single' }, options: [{ label: 'Yes' }, { label: 'No' }] },
      { id: 'b', question: 'Many?', selection: { mode: 'multiple' }, options: [{ label: 'Red' }, { label: 'Blue' }] },
      { id: 'c', question: 'Other?', selection: { mode: 'single' }, options: [{ label: 'X' }] },
    ]
    expect(museAnswers(questions, { 'One?': 'Yes', 'Many?': 'Red, Blue', 'Other?': 'Something else' })).toEqual([
      { questionId: 'a', selectedLabel: 'Yes' }, { questionId: 'b', selectedLabels: ['Red', 'Blue'] }, { questionId: 'c', freeText: 'Something else' },
    ])
    expect(museAnswers(questions, { 'One?': 'Yes' })).toBeUndefined()
  })

  it('reads models without inventing effort levels', () => {
    expect(museModels({ models: [{ modelId: 'm', variants: 'unknown', reasoningEffortVariants: [{ tier: 'medium' }, { tier: 'ultra' }] }, { modelId: 'bad id' }] }))
      .toEqual([{ value: 'm', resolvedModel: 'm', displayName: 'm', efforts: ['medium'] }])
  })

  it('switches to the Muse TUI on the same session and comes back to the chat', () => {
    const command = museTuiSwitchCommand({ model: 'muse-spark-1.3', effort: 'high', permissionMode: 'bypassPermissions' }, '/bin/muse', '/c/commando-agent', SESSION, ['--permission-mode', 'bypassPermissions'])
    expect(command).toBe(`exec /bin/bash -c 'set -m; /bin/muse --model muse-spark-1.3 --reasoning-effort high --approval-mode never --trust-workspace resume ${SESSION}; exec /c/commando-agent muse --permission-mode bypassPermissions --resume ${SESSION} --from-claude-code'`)
  })

  it('recognises image types and mints UUIDv7 command ids', () => {
    expect(imageMediaType(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg')
    expect(imageMediaType(Buffer.from('GIF89a'))).toBe('image/gif')
    expect(imageMediaType(Buffer.from('RIFF\0\0\0\0WEBPVP8 '))).toBe('image/webp')
    expect(imageMediaType(Buffer.from('<svg'))).toBeUndefined()
    const id = uuidv7(1_800_000_000_000)
    expect(id).toMatch(V7)
    expect(parseInt(id.replaceAll('-', '').slice(0, 12), 16)).toBe(1_800_000_000_000)
  })
})

describe('MuseItemMapper', () => {
  it('maps tool calls to commands, file changes and generic tools', () => {
    const mapper = new MuseItemMapper(() => 1)
    expect(mapper.item({ itemId: 'b', kind: 'toolCall', revision: 1, status: 'failed', tool: 'bash', args: '{"command":"npm test"}', visibleOutput: 'FAIL' }))
      .toMatchObject([{ kind: 'command', command: 'npm test', output: 'FAIL', isError: true, status: 'failed' }])
    expect(mapper.item({ itemId: 'e', kind: 'toolCall', revision: 1, status: 'completed', tool: 'edit_file', args: '{"path":"src/a.ts"}', patchSummary: { files: 1, added: 3, removed: 1 } }))
      .toMatchObject([{ kind: 'file_change', path: 'src/a.ts', additions: 3, deletions: 1 }])
    expect(mapper.item({ itemId: 's', kind: 'toolCall', revision: 1, status: 'inProgress', tool: 'search', args: '{"query":"x"}', displayLabel: { active: 'Searching for x', done: 'Searched for x', neutral: 'Search' } }))
      .toMatchObject([{ kind: 'tool', title: 'Searching for x', status: 'running' }])
    expect(mapper.item({ itemId: 'w', kind: 'workflow', revision: 1, status: 'completed', fallbackText: 'Workflow: redesign' })).toMatchObject([{ kind: 'tool', title: 'Workflow: redesign' }])
  })

  it('ignores older revisions and hidden kinds, and streams reasoning summaries and tool output', () => {
    const mapper = new MuseItemMapper(() => 1)
    mapper.item({ itemId: 'a', kind: 'agentMessage', revision: 3, status: 'completed', text: 'Final' })
    expect(mapper.item({ itemId: 'a', kind: 'agentMessage', revision: 2, status: 'inProgress', text: 'Draft' })).toEqual([])
    expect(mapper.item({ itemId: 'h', kind: 'hookRun', revision: 1, status: 'completed' })).toEqual([])
    expect(mapper.delta({ itemId: 'h', field: 'text', delta: 'x' })).toEqual([])
    mapper.item({ itemId: 'r', kind: 'reasoning', revision: 1, status: 'inProgress', summary: [] })
    mapper.delta({ itemId: 'r', field: 'summary.0', delta: 'First' })
    expect(mapper.delta({ itemId: 'r', field: 'summary.1', delta: 'Second' })).toMatchObject([{ kind: 'reasoning', text: 'First\n\nSecond' }])
    mapper.item({ itemId: 'c', kind: 'toolCall', revision: 1, status: 'inProgress', tool: 'bash', args: '{"command":"ls"}' })
    expect(mapper.delta({ itemId: 'c', field: 'output', delta: 'a.txt' })).toMatchObject([{ kind: 'command', output: 'a.txt' }])
  })
})
