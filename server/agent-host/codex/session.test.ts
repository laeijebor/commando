import { describe, expect, it, vi } from 'vitest'
import type { ClientMethods, RpcId, RpcNotification, RpcRequest } from './protocol.js'
import { requestKey } from './protocol.js'
import type { CodexTransport } from './client.js'
import { CodexChatSession, codexContextUsage, codexModels, codexPermissions, codexTuiSwitchCommand } from './session.js'
import type { AgentSessionSpec } from '../session.js'
import { MAX_CHAT_ITEMS, parseChatSessionInfo } from '../../../shared/agent-chat.js'

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
  rateLimits: unknown = { planType: 'plus', primary: { usedPercent: 40, windowDurationMins: 300, resetsAt: 1_800_000_000 }, secondary: { usedPercent: 12, windowDurationMins: 10_080, resetsAt: 1_800_500_000 } }
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
    if (method === 'account/rateLimits/read') return { rateLimits: this.rateLimits, rateLimitsByLimitId: null }
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
  it('reads the account rate limits at start and merges pushed updates', async () => {
    const { session, client } = harness()
    await session.start()
    await tick()
    expect(client.requests.some((request) => request.method === 'account/rateLimits/read')).toBe(true)
    expect(session.snapshot().session.planUsage).toMatchObject({ plan: 'plus', limits: [{ kind: 'session', percent: 40 }, { kind: 'weekly_all', percent: 12 }] })
    client.notifications.forEach((listener) => listener({ method: 'account/rateLimits/updated', params: { rateLimits: { primary: { usedPercent: 91, windowDurationMins: 300, resetsAt: null }, secondary: null } } }))
    expect(session.snapshot().session.planUsage?.limits.map((limit) => [limit.kind, limit.percent, limit.severity])).toEqual([['session', 91, 'critical'], ['weekly_all', 12, 'normal']])
    expect(parseChatSessionInfo(session.snapshot().session)?.planUsage).toEqual(session.snapshot().session.planUsage)
    session.close()
  })
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
  it('rejects a mid-turn permission change without applying it to settings or the next turn', async () => {
    const { session, client } = await running({ bypassAllowed: true })
    const before = session.snapshot().session
    session.send('Change permissions', [], { permissionMode: 'bypassPermissions' })
    await tick()
    expect(session.snapshot().session).toEqual(before)
    expect(session.snapshot().items.at(-1)).toMatchObject({ kind: 'notice', text: expect.stringContaining('Permission changes apply to the next turn') })
    expect(client.requests.filter(({ method }) => method === 'turn/steer')).toEqual([])
    client.notify('turn/completed', { turn: turn('turn-1', 'completed') })
    session.send('Next')
    await tick()
    expect(client.requests.at(-1)).toMatchObject({ method: 'turn/start', params: {
      approvalPolicy: 'on-request', sandboxPolicy: { type: 'workspaceWrite' },
    } })
    session.close()
  })

  it.each(['completed', 'changed'] as const)('retries a rejected steer as a new turn when the active turn is %s, preserving text and images', async (race) => {
    const images = {
      stage: vi.fn(async () => '/tmp/staged.png'),
      stagedImage: () => ({ id: 'image', sessionId: thread.id }),
    } as unknown as NonNullable<AgentSessionSpec['images']>
    const { session, client } = await running({ images })
    const original = client.request.getMockImplementation()!
    client.request.mockImplementation(async (method, params) => {
      if (method === 'turn/steer') {
        client.requests.push({ method, params })
        client.notify('turn/completed', { turn: turn('turn-1', 'completed') })
        if (race === 'changed') client.notify('turn/started', { turn: turn('other-turn') })
        throw new Error('Turn is no longer active')
      }
      return original(method, params)
    })
    session.send('Keep this text', [{ id: 'image' }], { delivery: 'steer' })
    await tick()
    expect(client.requests.slice(-2)).toMatchObject([
      { method: 'turn/steer', params: { expectedTurnId: 'turn-1' } },
      { method: 'turn/start', params: { input: [
        { type: 'text', text: 'Keep this text', text_elements: [] },
        { type: 'localImage', path: '/tmp/staged.png' },
      ] } },
    ])
    expect(images.stage).toHaveBeenCalledOnce()
    expect(session.snapshot().items.at(-1)).toMatchObject({ kind: 'user_message', text: 'Keep this text', images: [{ id: 'image' }] })
    expect(session.snapshot().items.at(-1)).not.toHaveProperty('steered')
    expect(session.snapshot().session.status).toBe('running')
    session.close()
  })

  it('reports a steer failure without starting another turn when the active turn has not changed', async () => {
    const { session, client } = await running()
    client.request.mockRejectedValueOnce(new Error('Transport failed'))
    session.send('Steer')
    await tick()
    expect(client.requests.filter(({ method }) => method === 'turn/start')).toHaveLength(1)
    expect(session.snapshot().items.at(-1)).toMatchObject({ kind: 'notice', text: 'Message not sent: Transport failed' })
    expect(session.snapshot().session.status).toBe('running')
    session.close()
  })

  it('renders and answers child-thread approvals and questions independently of main-thread requests', async () => {
    const { session, client } = await running()
    client.server('item/fileChange/requestApproval', 'main')
    client.server('item/fileChange/requestApproval', 'child', { threadId: 'child-thread', turnId: 'child-turn' })
    client.server('item/tool/requestUserInput', 'child-question', {
      threadId: 'child-thread', turnId: 'child-turn',
      questions: [{ id: 'choice', question: 'Which?', options: [{ label: 'A' }] }],
    })
    expect(client.errors).toEqual([])
    expect(session.snapshot().items.filter((item) => item.kind === 'request')).toMatchObject([
      { requestId: requestKey('main'), requestKind: 'approval' },
      { requestId: requestKey('child'), requestKind: 'approval', turnId: 'child-turn' },
      { requestId: requestKey('child-question'), requestKind: 'question', turnId: 'child-turn' },
    ])
    expect(session.answer(requestKey('child'), { kind: 'approval', decision: 'allow' })).toBe(true)
    expect(session.answer(requestKey('child-question'), { kind: 'question', answers: { 'Which?': 'A' } })).toBe(true)
    expect(client.replies).toEqual([
      { id: 'child', result: { decision: 'accept' } },
      { id: 'child-question', result: { answers: { choice: { answers: ['A'] } } } },
    ])
    expect(session.snapshot().session.status).toBe('waiting')
    expect(session.answer(requestKey('main'), { kind: 'approval', decision: 'deny' })).toBe(true)
    expect(session.snapshot().session.status).toBe('running')
    client.server('item/fileChange/requestApproval', 'resolved-child', { threadId: 'child-thread' })
    client.notify('serverRequest/resolved', { threadId: 'child-thread', requestId: 'resolved-child' })
    expect(session.answer(requestKey('resolved-child'), { kind: 'approval', decision: 'allow' })).toBe(false)
    expect(session.snapshot().items.at(-1)).toMatchObject({ kind: 'request', answer: { kind: 'cancelled', reason: 'Resolved by Codex' } })
    expect(session.snapshot().session.status).toBe('running')
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
  it('loads a short paginated thread fully and replays turns chronologically with unchanged ids', async () => {
    const { session, client } = harness({ resume: thread.id })
    const original = client.request.getMockImplementation()!
    client.request.mockImplementation(async (method, params) => {
      if (method === 'thread/resume') return { thread: { ...thread, historyMode: 'paginated' }, model: 'test-model', reasoningEffort: 'medium' }
      if (method === 'thread/turns/list') {
        client.requests.push({ method, params })
        const second = 'cursor' in params && params.cursor === 'second'
        const ids = second ? ['older'] : ['newest', 'newer']
        return { data: ids.map((id) => turn(id, 'completed', [{ type: 'agentMessage', id, text: id, phase: null, memoryCitation: null, delivery: null, questions: null }])), nextCursor: second ? null : 'second', backwardsCursor: null }
      }
      return original(method, params)
    })
    await session.start()
    expect(session.snapshot().items.map((item) => 'text' in item ? item.text : '')).toEqual(['older', 'newer', 'newest'])
    expect(session.snapshot().items.map((item) => item.id)).toEqual(['codex:older:older', 'codex:newer:newer', 'codex:newest:newest'])
    expect(client.requests.filter((request) => request.method === 'thread/turns/list')).toMatchObject([{ params: { itemsView: 'full', sortDirection: 'desc' } }, { params: { cursor: 'second' } }])
    expect(client.requests.some((request) => request.method === 'thread/read')).toBe(false)
    session.close()
  })
  it('stops fetching a long paginated thread at the mapped chat item limit', async () => {
    const { session, client } = harness({ resume: thread.id })
    const original = client.request.getMockImplementation()!
    const pageSize = 100
    const itemsPerTurn = 10
    const totalTurns = MAX_CHAT_ITEMS / itemsPerTurn + pageSize
    client.request.mockImplementation(async (method, params) => {
      if (method === 'thread/resume') return { thread: { ...thread, historyMode: 'paginated' }, model: 'test-model' }
      if (method === 'thread/turns/list') {
        client.requests.push({ method, params })
        const offset = 'cursor' in params ? Number(params.cursor) : 0
        return {
          data: Array.from({ length: pageSize }, (_, index) => {
            const id = String(totalTurns - offset - index)
            return turn(id, 'completed', [
              { type: 'fileChange', id: 'empty-change', changes: [] },
              ...Array.from({ length: itemsPerTurn }, (_, item) => ({ type: 'agentMessage', id: String(item), text: `${id}:${item}` })),
            ])
          }),
          nextCursor: String(offset + pageSize),
        }
      }
      return original(method, params)
    })
    await session.start()
    const requests = client.requests.filter((request) => request.method === 'thread/turns/list')
    expect(requests).toHaveLength(2)
    expect(requests).toMatchObject([
      { params: { sortDirection: 'desc', itemsView: 'full' } },
      { params: { cursor: '100', sortDirection: 'desc', itemsView: 'full' } },
    ])
    expect(requests.some(({ params }) => 'cursor' in params && params.cursor === '200')).toBe(false)
    expect(session.snapshot().session.status).toBe('idle')
    expect(session.snapshot().items).toHaveLength(MAX_CHAT_ITEMS)
    const expected = Array.from({ length: MAX_CHAT_ITEMS }, (_, index) => `${pageSize + 1 + Math.floor(index / itemsPerTurn)}:${index % itemsPerTurn}`)
    expect(session.snapshot().items.map((item) => 'text' in item ? item.text : '')).toEqual(expected)
    session.close()
  })
  it('rejects repeated history cursors', async () => {
    const { session, client } = harness({ resume: thread.id })
    const original = client.request.getMockImplementation()!
    client.request.mockImplementation(async (method, params) => {
      if (method === 'thread/resume') return { thread: { ...thread, historyMode: 'paginated' } }
      if (method === 'thread/turns/list') {
        client.requests.push({ method, params })
        return { data: [], nextCursor: 'repeated' }
      }
      return original(method, params)
    })
    await session.start()
    expect(client.requests.filter(({ method }) => method === 'thread/turns/list')).toHaveLength(2)
    expect(session.snapshot().items.at(-1)).toMatchObject({ kind: 'notice', text: expect.stringContaining('Codex repeated a history cursor') })
    session.close()
  })
  it('stops hydration when closed during a history request', async () => {
    const { session, client } = harness({ resume: thread.id })
    const original = client.request.getMockImplementation()!
    client.request.mockImplementation(async (method, params) => {
      if (method === 'thread/resume') return { thread: { ...thread, historyMode: 'paginated' } }
      if (method === 'thread/turns/list') {
        client.requests.push({ method, params })
        session.close()
        return { data: [turn('late', 'completed', [{ type: 'agentMessage', id: 'late', text: 'late' }])], nextCursor: 'older' }
      }
      return original(method, params)
    })
    await session.start()
    expect(client.requests.filter(({ method }) => method === 'thread/turns/list')).toHaveLength(1)
    expect(session.snapshot().items).toEqual([])
    expect(session.snapshot().session.status).toBe('closed')
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
