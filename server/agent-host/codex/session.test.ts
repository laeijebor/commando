import { describe, expect, it, vi } from 'vitest'
import type { ClientMethods, RpcId, RpcNotification, RpcRequest } from './protocol.js'
import { requestKey } from './protocol.js'
import type { CodexTransport } from './client.js'
import { CodexChatSession, codexContextUsage, codexModels, codexPermissions, codexTuiSwitchCommand } from './session.js'
import type { AgentSessionSpec } from '../session.js'
import { parseChatSessionInfo } from '../../../shared/agent-chat.js'

const model = (id: string, efforts = ['low', 'medium', 'high']) => ({ id, model: id, upgrade: null, upgradeInfo: null, availabilityNux: null, displayName: id, description: 'Test model', modelSpecialty: null, hidden: false, supportedReasoningEfforts: efforts.map((reasoningEffort) => ({ reasoningEffort, description: reasoningEffort })), defaultReasoningEffort: 'medium', inputModalities: ['text', 'image'], supportsPersonality: false, multiAgentVersion: null, additionalSpeedTiers: [], serviceTiers: [], defaultServiceTier: null, availableAccessPrograms: null, isDefault: id === 'test-model' })
const thread = { id: 'thread-123', sessionId: 'thread-123', forkedFromId: null, parentThreadId: null, preview: '', ephemeral: false, section: null, sectionEnteredAt: null, projectId: null, historyMode: 'legacy', modelProvider: 'openai', model: 'test-model', reasoningEffort: 'medium', createdAt: 1, updatedAt: 1, recencyAt: null, status: { type: 'idle' }, path: null, cwd: '/tmp', cliVersion: '0.159.3', originator: 'commando', source: 'appServer', threadSource: null, agentNickname: null, agentRole: null, gitInfo: null, name: null, turns: [] }
const turn = (id: string, status = 'inProgress', items: unknown[] = []) => ({ id, items, itemsView: 'full', status, error: null, startedAt: 1, completedAt: status === 'inProgress' ? null : 2, durationMs: null })
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
class FakeClient implements CodexTransport {
  requests: { method: keyof ClientMethods; params: ClientMethods[keyof ClientMethods] }[] = []
  replies: { id: RpcId; result: unknown }[] = []
  errors: { id: RpcId; code: number; message: string }[] = []
  notifications: ((message: RpcNotification) => void)[] = []
  handlers: ((message: RpcRequest) => boolean)[] = []
  closes: ((error?: Error) => void)[] = []
  count = 0
  start = vi.fn(async () => {})
  onNotification(listener: (message: RpcNotification) => void) { this.notifications.push(listener) }
  onRequest(listener: (message: RpcRequest) => boolean) { this.handlers.push(listener) }
  onClose(listener: (error?: Error) => void) { this.closes.push(listener) }
  request = vi.fn(async <M extends keyof ClientMethods>(method: M, params: ClientMethods[M]): Promise<unknown> => {
    this.requests.push({ method, params })
    if (method === 'model/list') return { data: [model('test-model'), model('other-model', ['low'])], nextCursor: null }
    if (method === 'thread/start' || method === 'thread/resume') return { thread, model: 'test-model', modelProvider: 'openai', serviceTier: null, disabledPluginIds: [], cwd: '/tmp', instructionSources: [], approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: codexPermissions('default', '/tmp').sandboxPolicy, reasoningEffort: 'medium' }
    if (method === 'thread/read') return { thread: { ...thread, name: 'Old chat', turns: [turn('history', 'completed', [{ type: 'agentMessage', id: 'h', text: 'Earlier', phase: null, memoryCitation: null, delivery: null, questions: null }])] } }
    if (method === 'turn/start') {
      const id = `turn-${++this.count}`
      this.notify('turn/started', { turn: turn(id) })
      const input = (params as ClientMethods['turn/start']).input
      this.notify('item/completed', { turnId: id, item: { type: 'userMessage', id: `u-${id}`, clientId: null, content: input } })
      return { turn: turn(id) }
    }
    if (method === 'turn/steer') return { turnId: (params as ClientMethods['turn/steer']).expectedTurnId }
    return {}
  })
  respond(id: RpcId, result: unknown) { this.replies.push({ id, result }) }
  reject(id: RpcId, code: number, message: string) { this.errors.push({ id, code, message }) }
  close() { this.closes.forEach((listener) => listener()) }
  notify(method: string, params: Record<string, unknown>) { this.notifications.forEach((listener) => listener({ method, params: { threadId: thread.id, ...params } })) }
  server(method: string, id: RpcId = 4, params: Record<string, unknown> = {}) { return this.handlers.some((listener) => listener({ method, id, params: { threadId: thread.id, turnId: 'turn-1', itemId: 'tool-1', startedAtMs: 1, ...params } })) }
}
function harness(spec: Partial<AgentSessionSpec> = {}) {
  const client = new FakeClient()
  const session = new CodexChatSession({ paneId: '%3', cwd: '/tmp', permissionMode: 'default', env: {}, ...spec }, client)
  return { session, client }
}
async function running(spec: Partial<AgentSessionSpec> = {}) {
  const result = harness(spec)
  await result.session.start()
  result.session.send('Hello')
  await tick()
  return result
}

describe('CodexChatSession', () => {
  it('starts a thread in pane cwd, sends input and replays resumed history', async () => {
    const { session, client } = harness({ resume: thread.id })
    expect(session.snapshot().session.sessionId).toBe(thread.id)
    await session.start()
    expect(client.requests.find((request) => request.method === 'thread/resume')).toMatchObject({ params: { threadId: thread.id, cwd: '/tmp', sandbox: 'workspace-write', approvalPolicy: 'on-request' } })
    expect(client.requests.some((request) => request.method === 'thread/read')).toBe(true)
    expect(session.snapshot()).toMatchObject({ session: { provider: 'codex', sessionId: thread.id, status: 'idle', title: 'Old chat' }, items: [{ kind: 'assistant_message', text: 'Earlier' }] })
    expect(parseChatSessionInfo(session.snapshot().session)).not.toBeNull()
    session.close()
  })
  it.each([['allow', 'accept'], ['allow_always', 'acceptForSession'], ['deny', 'decline']] as const)('answers command/file approval %s as %s', async (decision, expected) => {
    const { session, client } = await running()
    for (const method of ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval']) {
      client.server(method, method, { kind: 'command', command: 'pwd', cwd: '/tmp', environmentId: null })
      expect(session.snapshot().session.status).toBe('waiting')
      expect(session.answer(requestKey(method), { kind: 'approval', decision })).toBe(true)
      expect(client.replies.at(-1)).toEqual({ id: method, result: { decision: expected } })
      client.notify('serverRequest/resolved', { requestId: method })
      expect(session.answer(requestKey(method), { kind: 'approval', decision })).toBe(false)
    }
    session.close()
  })
  it('maps permission grants to turn/session scope, questions to question ids, and declines safely', async () => {
    const { session, client } = await running()
    const permissions = { network: { enabled: true }, fileSystem: { read: null, write: ['/tmp/extra'] } }
    client.server('item/permissions/requestApproval', 'p', { permissions, environmentId: null, cwd: '/tmp', reason: 'Extra access' })
    session.answer(requestKey('p'), { kind: 'approval', decision: 'allow_always' })
    expect(client.replies.at(-1)).toEqual({ id: 'p', result: { permissions, scope: 'session' } })
    client.server('item/permissions/requestApproval', 'denied', { permissions })
    session.answer(requestKey('denied'), { kind: 'approval', decision: 'deny' })
    expect(client.replies.at(-1)).toEqual({ id: 'denied', result: { permissions: {}, scope: 'turn' } })
    client.server('item/tool/requestUserInput', 'q', { questions: [{ id: 'choice', header: 'Choice', question: 'Choose?', isOther: true, isSecret: false, options: [{ label: 'A', description: 'First' }] }], isBlocking: true, autoResolutionMs: null })
    expect(session.answer(requestKey('q'), { kind: 'approval', decision: 'allow' })).toBe(false)
    expect(session.answer(requestKey('q'), { kind: 'question', answers: {} })).toBe(false)
    session.answer(requestKey('q'), { kind: 'question', answers: { 'Choose?': 'A' } })
    expect(client.replies.at(-1)).toEqual({ id: 'q', result: { answers: { choice: { answers: ['A'] } } } })
    expect(client.server('mcpServer/elicitation/request')).toBe(false)
    session.close()
  })
  it('applies sticky model/effort/settings per turn, never mutating a running turn', async () => {
    const { session, client } = await running()
    await session.configure({ model: 'other-model', effort: 'low', permissionMode: 'plan' })
    expect(client.requests.filter((request) => request.method === 'turn/start')).toHaveLength(1)
    session.send('steer', [], { delivery: 'steer' })
    await tick()
    expect(client.requests.at(-1)).toMatchObject({ method: 'turn/steer', params: { expectedTurnId: 'turn-1' } })
    client.notify('turn/completed', { turn: turn('turn-1', 'completed') })
    session.send('Next')
    await tick()
    expect(client.requests.at(-1)).toMatchObject({ method: 'turn/start', params: { model: 'other-model', effort: 'low', approvalPolicy: 'on-request', sandboxPolicy: { type: 'readOnly', networkAccess: false } } })
    expect(session.snapshot().session.model).toBe('other-model')
    await session.configure({ effort: 'high' })
    expect(session.snapshot().session.effort).toBe('low')
    expect(session.snapshot().items.at(-1)).toMatchObject({ kind: 'notice', level: 'error' })
    session.close()
  })
  it('cancels requests on interrupt and waits for turn/completed before sending the queue', async () => {
    const { session, client } = await running()
    client.server('item/commandExecution/requestApproval', 4, { command: 'pwd' })
    session.send('Queued', [], { delivery: 'queue' })
    await session.interrupt()
    expect(client.replies.at(-1)).toEqual({ id: 4, result: { decision: 'cancel' } })
    expect(client.requests.at(-1)).toMatchObject({ method: 'turn/interrupt', params: { threadId: thread.id, turnId: 'turn-1' } })
    expect(session.queued).toHaveLength(1)
    expect(session.snapshot().items.at(-1)).toMatchObject({ kind: 'request', status: 'interrupted', answer: { kind: 'cancelled' } })
    client.notify('turn/completed', { turn: turn('turn-1', 'interrupted') })
    await tick()
    expect(session.queued).toEqual([])
    expect(client.requests.at(-1)).toMatchObject({ method: 'turn/start', params: { input: [{ type: 'text', text: 'Queued' }] } })
    session.close()
  })
  it('drops selected queued messages on stop, and cancels questions on close', async () => {
    const { session, client } = await running()
    session.send('Queued', [], { delivery: 'queue' })
    const id = session.queued[0]!.id
    client.server('item/tool/requestUserInput', 'q', { questions: [{ id: 'q', question: 'Name?', header: '', isSecret: false, isOther: true, options: null }] })
    await session.interrupt([id])
    expect(session.queued).toEqual([])
    expect(client.replies.at(-1)).toEqual({ id: 'q', result: { answers: {} } })
    client.server('item/fileChange/requestApproval', 'f')
    session.close()
    expect(client.replies.at(-1)).toEqual({ id: 'f', result: { decision: 'cancel' } })
    expect(session.snapshot().session.status).toBe('closed')
  })
  it('stages images as localImage inputs and keeps their refs in the chat', async () => {
    const images = { stage: vi.fn(async () => '/tmp/staged.png'), stagedImage: () => ({ id: 'image', sessionId: thread.id }) } as unknown as NonNullable<AgentSessionSpec['images']>
    const { session, client } = harness({ images })
    await session.start()
    session.send('Look', [{ id: 'image' }])
    await tick()
    expect(images.stage).toHaveBeenCalledWith('image', thread.id)
    expect(client.requests.at(-1)).toMatchObject({ params: { input: [{ type: 'text', text: 'Look', text_elements: [] }, { type: 'localImage', path: '/tmp/staged.png' }] } })
    expect(session.snapshot().items[0]).toMatchObject({ images: [{ id: 'image' }] })
    session.close()
  })
  it('ignores foreign thread events, clears externally resolved requests, and reports child failure', async () => {
    const { session, client } = await running()
    client.notify('thread/name/updated', { threadId: 'child', threadName: 'Wrong' })
    client.notify('thread/name/updated', { threadName: 'Right' })
    expect(session.snapshot().session.title).toBe('Right')
    client.server('item/fileChange/requestApproval', 4)
    client.notify('serverRequest/resolved', { requestId: 4 })
    expect(session.answer(requestKey(4), { kind: 'approval', decision: 'allow' })).toBe(false)
    expect(session.snapshot().session.status).toBe('running')
    client.closes.forEach((listener) => listener(new Error('Child failed')))
    expect(session.snapshot().session).toMatchObject({ status: 'error', error: 'Child failed' })
  })
  it('waits for idle before TUI handoff and preserves the queued messages for the daemon', async () => {
    const { session, client } = await running({ bypassAllowed: true })
    const ready = vi.fn()
    session.tui.onReady(ready)
    session.send('Later', [], { delivery: 'queue' })
    await session.tui.requestSwitch('after_turn')
    expect(ready).not.toHaveBeenCalled()
    client.notify('turn/completed', { turn: turn('turn-1', 'completed') })
    expect(ready).toHaveBeenCalledOnce()
    expect(session.queued).toHaveLength(1)
    expect(session.tui.command('/c/commando-agent', ['--permission-mode', 'default'], thread.id)).toContain('codex resume --no-daemon')
    session.tui.handOver()
    expect(session.snapshot().session.status).toBe('closed')
    expect(session.snapshot().items.some((item) => item.kind === 'notice' && item.text.includes('unsent'))).toBe(false)
  })
  it('reports initialization failure without leaking the client', async () => {
    const { session, client } = harness()
    client.start.mockRejectedValueOnce(new Error('Unavailable'))
    await session.start()
    expect(session.snapshot().session).toMatchObject({ status: 'error', error: 'Unavailable' })
  })
})
describe('Codex controls', () => {
  it('maps only supported modes and does not confuse billing totals with context size', () => {
    expect(codexPermissions('default', '/tmp')).toMatchObject({ approvalPolicy: 'on-request', sandbox: 'workspace-write' })
    expect(codexPermissions('acceptEdits', '/tmp')).toEqual(codexPermissions('default', '/tmp'))
    expect(codexPermissions('bypassPermissions', '/tmp')).toMatchObject({ approvalPolicy: 'never', sandbox: 'danger-full-access' })
    expect(() => codexPermissions('auto', '/tmp')).toThrow('does not support')
    expect(codexContextUsage({ modelContextWindow: 10000, total: { totalTokens: 999999 }, last: { inputTokens: 200, outputTokens: 50 } })).toMatchObject({ usedTokens: 250, maxTokens: 10000 })
    expect(codexContextUsage({ modelContextWindow: null })).toBeUndefined()
    expect(codexModels([model('a', ['none', 'high', 'xhigh', 'unrecognized']), { id: 'bad' }])[0]?.efforts).toEqual(['high', 'xhigh'])
  })
  it('quotes TUI commands and returns to Codex chat on the exact thread', () => {
    const command = codexTuiSwitchCommand({ cwd: '/tmp', model: 'test-model', effort: 'high', permissionMode: 'plan' }, '/bin/codex', '/c/commando-agent', 'thread-123', ['--permission-mode', 'plan'])
    expect(command).toContain('resume --no-daemon --model test-model')
    expect(command).toContain('--sandbox read-only')
    expect(command).toContain('commando-agent codex --permission-mode plan --resume thread-123 --from-claude-code')
  })
})

describe('Codex paginated history and request validation', () => {
  it('hydrates paginated threads in order with full items and cursors', async () => {
    const { session, client } = harness({ resume: thread.id })
    const original = client.request.getMockImplementation()!
    client.request.mockImplementation(async (method, params) => {
      if (method === 'thread/resume') return { thread: { ...thread, historyMode: 'paginated' }, model: 'test-model', reasoningEffort: 'medium' }
      if (method === 'thread/turns/list') {
        client.requests.push({ method, params })
        const second = 'cursor' in params && params.cursor === 'second'
        const id = second ? 'newer' : 'older'
        return { data: [turn(id, 'completed', [{ type: 'agentMessage', id, text: id, phase: null, memoryCitation: null, delivery: null, questions: null }])], nextCursor: second ? null : 'second', backwardsCursor: null }
      }
      return original(method, params)
    })
    await session.start()
    expect(session.snapshot().items.map((item) => 'text' in item ? item.text : '')).toEqual(['older', 'newer'])
    expect(client.requests.filter((request) => request.method === 'thread/turns/list')).toMatchObject([{ params: { itemsView: 'full', sortDirection: 'asc' } }, { params: { cursor: 'second' } }])
    expect(client.requests.some((request) => request.method === 'thread/read')).toBe(false)
    session.close()
  })
  it('rejects malformed permission profiles and secret questions instead of hanging', async () => {
    const { session, client } = await running()
    client.server('item/permissions/requestApproval', 'bad', { permissions: { network: { enabled: 'yes' } } })
    expect(client.errors.at(-1)).toMatchObject({ id: 'bad', code: -32602 })
    client.server('item/tool/requestUserInput', 'secret', { questions: [{ id: 'secret', question: 'Password?', header: '', isSecret: true, isOther: true, options: null }], isBlocking: true, autoResolutionMs: null })
    expect(client.errors.at(-1)).toMatchObject({ id: 'secret', code: -32602 })
    expect(session.snapshot().session.status).toBe('running')
    session.close()
  })
})
