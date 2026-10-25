import { describe, expect, it, vi } from 'vitest'
import type { AgentOptions, ModelListItem, RunResult, SDKUserMessage, SendOptions, SteerAckOutcome } from '@cursor/sdk'
import { MAX_CHAT_IMAGES, MAX_CHAT_ITEMS, MAX_QUEUED_MESSAGES, parseChatSessionInfo } from '../../../shared/agent-chat.js'
import type { AgentSessionSpec } from '../session.js'
import { CursorChatSession, cursorImageMime, cursorModels, cursorModelSelection, cursorPermissions, isCursorAuthError } from './session.js'
import type { CursorAgent, CursorHistory, CursorRun, CursorSdk } from './sdk.js'

const models: ModelListItem[] = [
  { id: 'auto', displayName: 'Auto', description: 'Automatic' },
  { id: 'test-model', displayName: 'Test', parameters: [
    { id: 'reasoning_effort', values: [{ value: 'low' }, { value: 'high' }, { value: 'extreme' }] },
    { id: 'fast', values: [{ value: 'true' }, { value: 'false' }] },
  ] },
]
const liveModels: ModelListItem[] = [
  { id: 'auto-smart', displayName: 'Auto', parameters: [{ id: 'optimize_for', values: [{ value: 'intelligence' }, { value: 'balanced' }, { value: 'cost' }] }] },
  { id: 'default', displayName: 'Auto' },
  { id: 'gpt-5.5', displayName: 'GPT-5.5', parameters: [
    { id: 'reasoning', values: ['none', 'low', 'medium', 'high', 'extra-high'].map((value) => ({ value })) },
    { id: 'fast', values: [{ value: 'false' }, { value: 'true' }] },
  ] },
]
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
class FakeRun implements CursorRun {
  readonly done = deferred<RunResult>()
  wait = vi.fn(() => this.done.promise)
  cancel = vi.fn(async () => { this.finish('cancelled') })
  steer = vi.fn(async (_text: string): Promise<SteerAckOutcome> => 'complete_delivered')
  finish(status: RunResult['status'] = 'finished', error?: RunResult['error']) { this.done.resolve({ id: 'run', status, error }) }
}
class FakeSdk implements CursorSdk {
  readonly runs: FakeRun[] = []
  readonly sends: { message: SDKUserMessage; options: SendOptions }[] = []
  readonly loginResult = deferred<{ email?: string }>()
  loginOptions?: Parameters<CursorSdk['login']>[0]
  agent: CursorAgent = {
    agentId: 'agent-123',
    send: async (message, options) => {
      this.sends.push({ message, options })
      const run = new FakeRun()
      this.runs.push(run)
      return run
    },
    close: vi.fn(),
  }
  authStatus = vi.fn(async (): ReturnType<CursorSdk['authStatus']> => ({ status: 'logged-in' }))
  login = vi.fn((options: Parameters<CursorSdk['login']>[0]) => {
    this.loginOptions = options
    options.signal.addEventListener('abort', () => this.loginResult.reject(new Error('aborted')), { once: true })
    return this.loginResult.promise
  })
  listModels = vi.fn(async () => models)
  create = vi.fn(async (_options: AgentOptions) => this.agent)
  resume = vi.fn(async (_id: string, _options: AgentOptions) => this.agent)
  history = vi.fn(async (_id: string, _cwd: string): Promise<CursorHistory> => ({ turns: [], skipped: 0 }))
  delta(update: unknown, index = this.sends.length - 1) { this.sends[index].options.onDelta?.({ update: update as Parameters<NonNullable<SendOptions['onDelta']>>[0]['update'] }) }
}
function harness(spec: Partial<AgentSessionSpec> = {}) {
  const sdk = new FakeSdk()
  const session = new CursorChatSession({ paneId: '%3', cwd: '/tmp', permissionMode: 'bypassPermissions', env: {}, ...spec }, sdk)
  return { session, sdk }
}
async function running(spec: Partial<AgentSessionSpec> = {}) {
  const result = harness(spec)
  await result.session.start()
  result.session.send('Hello')
  await tick()
  return result
}

describe('Cursor helpers', () => {
  it('always declares sandbox policy and rejects unsupported modes', () => {
    expect(cursorPermissions('bypassPermissions')).toEqual({ sandboxOptions: { enabled: false } })
    expect(cursorPermissions('default')).toEqual({ sandboxOptions: { enabled: true } })
    expect(cursorPermissions('auto')).toEqual({ sandboxOptions: { enabled: false }, autoReview: true })
    expect(cursorPermissions('plan')).toEqual(cursorPermissions('default'))
    expect(cursorPermissions('plan', 'default')).toEqual(cursorPermissions('default'))
    expect(cursorPermissions('plan', 'auto')).toEqual(cursorPermissions('auto'))
    expect(cursorPermissions('plan', 'bypassPermissions')).toEqual(cursorPermissions('bypassPermissions'))
    for (const mode of ['acceptEdits', 'dontAsk'] as const) expect(() => cursorPermissions(mode)).toThrow('does not support')
    expect(cursorPermissions('plan', 'plan')).toEqual(cursorPermissions('default'))
  })
  it('maps model capabilities and emits only declared parameter values', () => {
    expect(cursorModels([...models, { id: 'bad id', displayName: 'Bad' }])).toEqual([
      { value: 'auto', resolvedModel: 'auto', displayName: 'Auto', description: 'Automatic', efforts: [] },
      { value: 'test-model', resolvedModel: 'test-model', displayName: 'Test', efforts: ['low', 'high'], supportsFast: true },
    ])
    expect(cursorModelSelection(models[1], 'high', true)).toEqual({ id: 'test-model', params: [{ id: 'reasoning_effort', value: 'high' }, { id: 'fast', value: 'true' }] })
    expect(cursorModelSelection(models[1], 'medium', false)).toEqual({ id: 'test-model', params: [{ id: 'fast', value: 'false' }] })
    expect(cursorModelSelection(models[0], 'high', true)).toEqual({ id: 'auto' })
    for (const id of ['effort', 'reasoning']) expect(cursorModels([{ id: 'm', displayName: 'M', parameters: [{ id, values: [{ value: 'max' }] }] }])[0].efforts).toEqual(['max'])
  })
  it('maps live model names and extra-high effort without forwarding unrelated parameters', () => {
    expect(cursorModels(liveModels)).toMatchObject([
      { value: 'auto-smart', displayName: 'Auto (auto-smart)', efforts: [] },
      { value: 'default', displayName: 'Auto', efforts: [] },
      { value: 'gpt-5.5', efforts: ['low', 'medium', 'high', 'xhigh'], supportsFast: true },
    ])
    expect(cursorModelSelection(liveModels[0], 'high', true)).toEqual({ id: 'auto-smart' })
    expect(cursorModelSelection(liveModels[2], 'xhigh', true)).toEqual({ id: 'gpt-5.5', params: [{ id: 'reasoning', value: 'extra-high' }, { id: 'fast', value: 'true' }] })
    for (const id of ['effort', 'reasoning_effort', 'reasoning']) {
      const option = { id: 'm', displayName: 'M', parameters: [{ id, values: ['minimal', 'none', 'extra-high', 'xhigh'].map((value) => ({ value })) },
        ...['context', 'thinking', 'optimize_for'].map((id) => ({ id, values: [{ value: 'high' }] }))] }
      expect(cursorModels([option])[0].efforts).toEqual(['xhigh'])
      expect(cursorModelSelection(option, 'xhigh')).toEqual({ id: 'm', params: [{ id, value: 'xhigh' }] })
    }
  })
  it.each([{ name: 'AuthenticationError' }, { code: 'unauthenticated' }, new Error('[unknown] Invalid User API Key'), new Error('Invalid API key'), new Error('API key is required'), { status: 'error', error: { code: 'unauthenticated' } }])('recognizes auth rejection %j', (error) => {
    expect(isCursorAuthError(error)).toBe(true)
    expect(isCursorAuthError(new Error('Rate limit'))).toBe(false)
  })
  it.each(['unauthenticated', 'NOT_LOGGED_IN', 'INVALID_AUTH_ID', 'AGENT_REQUIRES_LOGIN', 'AUTH_TOKEN_NOT_FOUND', 'AUTH_TOKEN_EXPIRED', 'UNAUTHORIZED', 'BAD_API_KEY', 'BAD_USER_API_KEY'])('recognizes plain and nested auth code %s case-insensitively', (code) => {
    expect(isCursorAuthError({ code, message: 'Session expired' })).toBe(true)
    expect(isCursorAuthError({ status: 'error', error: { code, message: 'Session expired' } })).toBe(true)
    expect(isCursorAuthError({ status: 'error', error: { code: code.toLowerCase(), message: 'Session expired' } })).toBe(true)
  })
  it('sniffs supported image magic bytes', () => {
    expect(cursorImageMime(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))).toBe('image/png')
    expect(cursorImageMime(Buffer.from([255, 216, 255]))).toBe('image/jpeg')
    expect(cursorImageMime(Buffer.from('GIF89a'))).toBe('image/gif')
    expect(cursorImageMime(Buffer.from('RIFF1234WEBP'))).toBe('image/webp')
    expect(cursorImageMime(Buffer.from('<svg/>'))).toBeUndefined()
  })
})

describe('CursorChatSession', () => {
  it('creates lazily with the first prompt and the model selected after readiness', async () => {
    const { session, sdk } = harness()
    sdk.listModels.mockResolvedValue(liveModels)
    await session.start()
    expect(session.snapshot().session).toMatchObject({ status: 'idle', selectedModel: 'default' })
    expect(session.snapshot().session.sessionId).toBeUndefined()
    expect(sdk.create).not.toHaveBeenCalled()
    await session.configure({ model: 'gpt-5.5', effort: 'xhigh', fast: true })
    const prompt = `  ${'A'.repeat(100)}  `
    session.send(prompt); await tick()
    const model = { id: 'gpt-5.5', params: [{ id: 'reasoning', value: 'extra-high' }, { id: 'fast', value: 'true' }] }
    expect(sdk.create).toHaveBeenCalledWith({ name: 'A'.repeat(80), model, disallowedTools: ['askQuestion'], local: { cwd: '/tmp', sandboxOptions: { enabled: false } } })
    expect(sdk.sends[0]).toMatchObject({ message: { text: 'A'.repeat(100) }, options: { model } })
    expect(session.snapshot().session.sessionId).toBe('agent-123')
    session.close()
  })
  it.each([
    { requested: 'auto-smart', list: liveModels, selected: 'auto-smart' },
    { requested: 'missing', list: liveModels, selected: 'default' },
    { requested: undefined, list: models, selected: 'auto' },
    { requested: undefined, list: [liveModels[2]], selected: 'gpt-5.5' },
  ])('selects $selected from the available models', async ({ requested, list, selected }) => {
    const { session, sdk } = harness({ model: requested })
    sdk.listModels.mockResolvedValue(list)
    await session.start()
    expect(session.snapshot().session.selectedModel).toBe(selected)
    expect(sdk.create).not.toHaveBeenCalled()
    session.close()
  })
  it('shows the turn as running while the agent is created, and idle again if creation fails', async () => {
    const { session, sdk } = harness()
    await session.start()
    const created = deferred<CursorAgent>()
    sdk.create.mockReturnValueOnce(created.promise)
    session.send('First'); await tick()
    expect(session.snapshot().session.status).toBe('running')
    created.reject(new Error('create failed')); await tick()
    expect(session.snapshot().session.status).toBe('idle')
    session.close()
  })
  it('can retry failed lazy creation without losing readiness', async () => {
    const { session, sdk } = harness()
    await session.start()
    sdk.create.mockRejectedValueOnce(new Error('create failed'))
    session.send('First'); await tick()
    expect(session.snapshot().session.status).toBe('idle')
    expect(session.snapshot().session.sessionId).toBeUndefined()
    session.send('Retry'); await tick()
    expect(sdk.create).toHaveBeenCalledTimes(2)
    expect(sdk.create.mock.calls[1][0].name).toBe('Retry')
    expect(sdk.sends[0].message.text).toBe('Retry')
    session.close()
  })
  it('starts logged out, exposes browser login, then becomes ready without retaining credentials', async () => {
    const { session, sdk } = harness({ initialPrompt: 'Start' })
    sdk.authStatus.mockResolvedValue({ status: 'logged-out' })
    const commands = vi.fn()
    session.on('commands', commands)
    await session.start()
    expect(session.snapshot().session).toMatchObject({ status: 'idle', models: [], login: { state: 'required', reason: 'Cursor needs you to log in before this chat can start.' } })
    expect(sdk.create).not.toHaveBeenCalled()
    session.send('No'); await tick()
    expect(sdk.sends).toHaveLength(0)
    expect(session.queued).toHaveLength(0)
    session.send(' /login '); await tick()
    expect(session.snapshot().session.login).toEqual({ state: 'pending' })
    sdk.loginOptions!.onLoginUrl('https://cursor.com/login')
    expect(session.snapshot().session.login).toEqual({ state: 'pending', url: 'https://cursor.com/login' })
    session.send('Still no')
    sdk.loginResult.resolve({ email: 'user@example.com', apiKey: 'secret' } as { email: string })
    await tick()
    expect(session.snapshot().session).toMatchObject({ status: 'running', sessionId: 'agent-123', selectedModel: 'auto', models: cursorModels(models) })
    expect(session.snapshot().session.login).toBeUndefined()
    expect(JSON.stringify(session.snapshot())).not.toContain('secret')
    expect(sdk.sends[0].message.text).toBe('Start')
    expect(commands).toHaveBeenCalledWith(session.commands)
    expect('tui' in session).toBe(false)
    session.close()
  })
  it('uses an explicit key without calling auth status and selects the requested model', async () => {
    const { session, sdk } = harness({ env: { CURSOR_API_KEY: 'secret' }, model: 'test-model', effort: 'high', fast: true })
    await session.start()
    expect(sdk.authStatus).not.toHaveBeenCalled()
    expect(sdk.create).not.toHaveBeenCalled()
    expect(session.snapshot().session.sessionId).toBeUndefined()
    session.send('Hello'); await tick()
    expect(sdk.create).toHaveBeenCalledWith({ name: 'Hello', model: { id: 'test-model', params: [{ id: 'reasoning_effort', value: 'high' }, { id: 'fast', value: 'true' }] }, disallowedTools: ['askQuestion'], local: { cwd: '/tmp', sandboxOptions: { enabled: false } } })
    expect(parseChatSessionInfo(session.snapshot().session)).not.toBeNull()
    session.close()
  })
  it.each([false, true])('serializes a send immediately after browser login behind readiness (existing agent: %s)', async (existing) => {
    const { session, sdk } = harness({ model: 'test-model', ...(existing ? { resume: 'old-agent' } : {}) })
    if (!existing) sdk.authStatus.mockResolvedValue({ status: 'logged-out' })
    await session.start()
    const readModels = deferred<ModelListItem[]>()
    sdk.listModels.mockReturnValueOnce(readModels.promise)
    session.send('/login'); await tick()
    sdk.loginResult.resolve({ email: 'user@example.com' })
    session.send('Right after login')
    await tick()
    expect(session.snapshot().session.login).toEqual({ state: 'pending' })
    expect(sdk.sends).toHaveLength(0)
    expect(session.snapshot().items.some((item) => item.kind === 'notice' && item.text.startsWith('Logged in'))).toBe(false)
    readModels.resolve(models); await tick()
    expect(session.snapshot().session.login).toBeUndefined()
    expect(sdk.sends).toHaveLength(1)
    expect(sdk.sends[0]).toMatchObject({ message: { text: 'Right after login' }, options: { model: { id: 'test-model' } } })
    expect(session.snapshot().items.some((item) => item.kind === 'notice' && item.level === 'error')).toBe(false)
    session.close()
  })
  it('streams deltas into one assistant message, then a command and another step', async () => {
    const { session, sdk } = await running()
    sdk.delta({ type: 'text-delta', text: 'Hi' }); sdk.delta({ type: 'text-delta', text: ' there' })
    expect(session.snapshot().items.filter((item) => item.kind === 'assistant_message')).toMatchObject([{ text: 'Hi there' }])
    sdk.delta({ type: 'tool-call-completed', callId: 's', toolCall: { type: 'shell', args: { command: 'pwd' }, result: { status: 'success', value: { stdout: '/tmp', stderr: '' } } } })
    sdk.delta({ type: 'text-delta', text: 'Done' })
    sdk.runs[0].finish(); await tick()
    expect(session.snapshot().items.filter((item) => item.kind === 'command')).toMatchObject([{ command: 'pwd', output: '/tmp', status: 'completed' }])
    expect(session.snapshot().session.status).toBe('idle')
    session.close()
  })
  it('shows delivered steers and puts reverted steers at the front of the queue', async () => {
    const { session, sdk } = await running()
    session.send('Steer'); await tick()
    expect(sdk.runs[0].steer).toHaveBeenCalledWith('Steer')
    expect(session.snapshot().items.at(-1)).toMatchObject({ kind: 'user_message', text: 'Steer', steered: true })
    session.send('Queued', [], { delivery: 'queue' }); await tick()
    sdk.runs[0].steer.mockResolvedValue('revert_to_followup')
    session.send('Reverted'); await tick()
    expect(session.queued.map((entry) => entry.text)).toEqual(['Reverted', 'Queued'])
    sdk.runs[0].finish(); await tick()
    expect(sdk.sends[1].message.text).toBe('Reverted\n\nQueued')
    expect(session.queued).toEqual([])
    session.close()
  })
  it('queues when steer is absent and supports editing, removing and bounded queues', async () => {
    const { session, sdk } = await running()
    sdk.runs[0].steer = undefined as never
    session.send('First'); await tick()
    const id = session.queued[0].id
    session.updateQueue({ action: 'edit', id, text: 'Edited' })
    for (let i = 1; i <= MAX_QUEUED_MESSAGES; i++) session.send(String(i), [], { delivery: 'queue' })
    await tick()
    expect(session.queued).toHaveLength(MAX_QUEUED_MESSAGES)
    session.updateQueue({ action: 'remove', id })
    expect(session.queued).toHaveLength(MAX_QUEUED_MESSAGES - 1)
    expect(session.snapshot().items.at(-1)).toMatchObject({ kind: 'notice', text: 'The message queue is full.' })
    session.close()
  })
  it('interrupts pending steering without waiting for its acknowledgement first', async () => {
    const { session, sdk } = await running()
    const steer = deferred<SteerAckOutcome>()
    sdk.runs[0].steer.mockReturnValue(steer.promise)
    sdk.runs[0].cancel.mockImplementation(async () => { steer.resolve('revert_to_followup'); sdk.runs[0].finish('cancelled') })
    session.send('Steer'); await tick()
    await session.interrupt()
    expect(sdk.runs[0].cancel).toHaveBeenCalledTimes(1)
    session.close()
  })
  it('interrupts active runs, settles items and drops named queued messages', async () => {
    const { session, sdk } = await running()
    sdk.delta({ type: 'text-delta', text: 'Working' })
    session.send('Drop', [], { delivery: 'queue' }); await tick()
    await session.interrupt(session.queued.map((entry) => entry.id)); await tick()
    expect(sdk.runs[0].cancel).toHaveBeenCalledTimes(1)
    expect(session.snapshot().items.at(-1)).toMatchObject({ text: 'Working', status: 'interrupted' })
    expect(session.queued).toEqual([])
    session.close()
  })
  it('re-resumes stale permission options on the next send and keeps model switches sticky', async () => {
    const { session, sdk } = await running({ permissionMode: 'default' })
    await session.configure({ model: 'test-model', effort: 'high', fast: true, permissionMode: 'auto' })
    expect(sdk.resume).not.toHaveBeenCalled()
    sdk.runs[0].finish(); await tick()
    session.send('Next'); await tick()
    expect(sdk.agent.close).toHaveBeenCalledTimes(1)
    expect(sdk.resume).toHaveBeenCalledWith('agent-123', { model: cursorModelSelection(models[1], 'high', true), disallowedTools: ['askQuestion'], local: { cwd: '/tmp', sandboxOptions: { enabled: false }, autoReview: true } })
    expect(sdk.sends[1].options.model).toEqual(cursorModelSelection(models[1], 'high', true))
    await session.configure({ effort: 'medium' })
    await session.configure({ model: 'unknown' })
    await session.configure({ permissionMode: 'acceptEdits' })
    expect(session.snapshot().session).toMatchObject({ effort: 'high', permissionMode: 'auto', selectedModel: 'test-model' })
    sdk.runs[1].finish(); await tick()
    session.send('Again'); await tick()
    expect(sdk.sends[2].options.model).toEqual(sdk.sends[1].options.model)
    expect(sdk.resume).toHaveBeenCalledTimes(1)
    session.close()
  })
  it('sends plan mode and maps createPlan, then Implement leaves plan mode', async () => {
    const { session, sdk } = harness({ permissionMode: 'plan', prePlanPermissionMode: 'bypassPermissions' })
    await session.start()
    session.send('Plan'); await tick()
    expect(sdk.sends[0].options.mode).toBe('plan')
    expect(sdk.create.mock.calls[0][0].local).toEqual({ cwd: '/tmp', sandboxOptions: { enabled: false } })
    expect(session.snapshot().session.prePlanPermissionMode).toBe('bypassPermissions')
    sdk.delta({ type: 'tool-call-completed', callId: 'p', toolCall: { type: 'createPlan', args: { plan: '# Plan\nDo this' } } })
    expect(session.snapshot().items.at(-1)).toMatchObject({ kind: 'plan', text: '# Plan\nDo this' })
    sdk.runs[0].finish(); await tick()
    session.send('Implement', [], { permissionMode: 'bypassPermissions' }); await tick()
    expect(sdk.sends[1].options.mode).toBe('agent')
    expect(session.snapshot().session.prePlanPermissionMode).toBeUndefined()
    expect(sdk.resume).toHaveBeenCalledWith('agent-123', expect.objectContaining({ local: { cwd: '/tmp', sandboxOptions: { enabled: false } } }))
    session.close()
  })
  it('requests a restart with current settings when an unsandboxed chat switches to sandboxing', async () => {
    const { session, sdk } = await running()
    sdk.runs[0].finish(); await tick()
    const restart = vi.fn(() => expect(session.snapshot().session.permissionMode).toBe('default'))
    session.on('restart', restart)
    await session.configure({ permissionMode: 'default' })
    expect(restart).toHaveBeenCalledTimes(1)
    expect(session.snapshot().items.at(-1)).toMatchObject({ kind: 'notice', level: 'info', text: "Restarting this chat so Cursor's sandbox can turn on." })
    expect(sdk.resume).not.toHaveBeenCalled()
    await session.configure({ permissionMode: 'default' })
    expect(restart).toHaveBeenCalledTimes(1)
    // A send before the restart happens is refused and asks for the restart again.
    session.send('Blocked if restart failed'); await tick()
    expect(sdk.sends).toHaveLength(1)
    expect(sdk.resume).not.toHaveBeenCalled()
    expect(restart).toHaveBeenCalledTimes(2)
    expect(session.snapshot().items.at(-1)).toMatchObject({ kind: 'notice', level: 'error', text: "Message not sent: Cursor's sandbox can't turn on until this chat restarts; it restarts when idle, then send this again (or switch to Full access)" })
    session.close()
  })
  it('refuses to turn the sandbox on mid-turn or with queued messages, since the restart would drop them', async () => {
    const { session, sdk } = await running()
    const restart = vi.fn()
    session.on('restart', restart)
    await session.configure({ permissionMode: 'default' })
    expect(session.snapshot().session.permissionMode).toBe('bypassPermissions')
    expect(session.snapshot().items.at(-1)).toMatchObject({ kind: 'notice', level: 'error', text: expect.stringContaining('switch once this turn has finished and nothing is queued') })
    session.send('Later', [], { delivery: 'queue' }); await tick()
    sdk.runs[0].finish(); await tick()
    expect(sdk.sends.map((send) => send.message.text)).toEqual(['Hello', 'Later'])
    expect(restart).not.toHaveBeenCalled()
    session.hostNotice('error', 'Restart failed: no pane')
    expect(session.snapshot().items.at(-1)).toMatchObject({ kind: 'notice', level: 'error', text: 'Restart failed: no pane' })
    session.close()
  })
  it('allows sandboxing before any unsandboxed run and requests restart after one runs', async () => {
    const { session, sdk } = harness()
    const restart = vi.fn()
    session.on('restart', restart)
    await session.start()
    await session.configure({ permissionMode: 'default' })
    expect(restart).not.toHaveBeenCalled()
    session.send('Sandboxed'); await tick()
    expect(sdk.create.mock.calls[0][0].local?.sandboxOptions?.enabled).toBe(true)
    sdk.runs[0].finish(); await tick()
    await session.configure({ permissionMode: 'bypassPermissions' })
    session.send('Full access'); await tick()
    expect(sdk.sends).toHaveLength(2)
    sdk.runs[1].finish(); await tick()
    await session.configure({ permissionMode: 'default' })
    expect(restart).toHaveBeenCalledTimes(1)
    session.close()
  })
  it('keeps plan mode on its pre-plan policy and does not restart for unsandboxed modes', async () => {
    const { session, sdk } = await running()
    const restart = vi.fn()
    session.on('restart', restart)
    await session.configure({ permissionMode: 'plan' })
    expect(session.snapshot().session.prePlanPermissionMode).toBe('bypassPermissions')
    expect(restart).not.toHaveBeenCalled()
    sdk.runs[0].finish(); await tick()
    session.send('Plan'); await tick()
    expect(sdk.sends[1].options.mode).toBe('plan')
    expect(sdk.resume.mock.calls[0][1].local?.sandboxOptions?.enabled).toBe(false)
    expect(restart).not.toHaveBeenCalled()
    session.close()
  })
  it('starts a plan without pre-plan mode sandboxed', async () => {
    const { session, sdk } = await running({ permissionMode: 'plan' })
    expect(sdk.create.mock.calls[0][0].local?.sandboxOptions?.enabled).toBe(true)
    expect(sdk.sends[0].options.mode).toBe('plan')
    session.close()
  })
  it('becomes idle after a per-send sandbox switch is blocked so the host can restart', async () => {
    const { session, sdk } = await running()
    sdk.runs[0].finish(); await tick()
    const idle = vi.fn()
    session.on('session', (info) => { if (info.status === 'idle' && !session.busy) idle() })
    const restart = vi.fn()
    session.on('restart', restart)
    session.send('Switch', [], { permissionMode: 'default' }); await tick()
    expect(restart).toHaveBeenCalled()
    expect(idle).toHaveBeenCalled()
    expect(sdk.sends).toHaveLength(1)
    session.close()
  })
  it('replays resumed history and retains only the newest items', async () => {
    const { session, sdk } = harness({ resume: 'old-agent' })
    sdk.history.mockResolvedValue({ skipped: 0, turns: Array.from({ length: MAX_CHAT_ITEMS + 1 }, (_, i) => ({ type: 'agentConversationTurn', turn: { steps: [{ type: 'assistantMessage', message: { text: String(i) } }] } })) })
    await session.start()
    expect(sdk.resume).toHaveBeenCalledWith('old-agent', expect.objectContaining({ disallowedTools: ['askQuestion'], local: { cwd: '/tmp', sandboxOptions: { enabled: false } } }))
    expect(sdk.history).toHaveBeenCalledWith('agent-123', '/tmp')
    expect(session.snapshot().items).toHaveLength(MAX_CHAT_ITEMS)
    expect(session.snapshot().items[0]).toMatchObject({ text: '1' })
    session.close()
  })
  it('requires login after a mid-run auth failure and requeues the input until login succeeds', async () => {
    const { session, sdk } = await running()
    session.send('Follow-up', [], { delivery: 'queue' }); await tick()
    sdk.runs[0].finish('error', { code: 'AUTH_TOKEN_EXPIRED', message: 'Session expired' }); await tick()
    expect(session.snapshot().session.login).toMatchObject({ state: 'required', reason: expect.stringContaining('saved login') })
    expect(session.queued.map((entry) => entry.text)).toEqual(['Hello', 'Follow-up'])
    session.send('Blocked'); expect(session.queued).toHaveLength(2)
    session.send('/login'); await tick()
    sdk.loginResult.resolve({}); await tick()
    expect(sdk.sends[1].message.text).toBe('Hello\n\nFollow-up')
    expect(session.queued).toEqual([])
    expect(sdk.create).toHaveBeenCalledTimes(1)
    expect(sdk.listModels).toHaveBeenCalledTimes(2)
    session.close()
  })
  it('keeps history failures informational and the resumed agent usable', async () => {
    const { session, sdk } = harness({ resume: 'old-agent' })
    sdk.history.mockRejectedValue(new Error('history unavailable'))
    await session.start()
    expect(session.snapshot().session.status).toBe('idle')
    expect(session.snapshot().items.at(-1)).toMatchObject({ kind: 'notice', level: 'info', text: "Couldn't load this chat's earlier messages: history unavailable" })
    session.send('Continue'); await tick()
    expect(sdk.sends[0].message.text).toBe('Continue')
    session.close()
  })
  it('reports skipped history once and never replays history after re-login recreates the handle', async () => {
    const { session, sdk } = harness({ resume: 'old-agent' })
    sdk.history.mockResolvedValue({ skipped: 2, turns: [{ type: 'agentConversationTurn', turn: { steps: [{ type: 'assistantMessage', message: { text: 'Earlier' } }] } }] })
    await session.start()
    expect(session.snapshot().items.at(-1)).toMatchObject({ kind: 'notice', level: 'info', text: "2 earlier Cursor turns couldn't be loaded." })
    await session.configure({ permissionMode: 'default' })
    sdk.resume.mockRejectedValueOnce({ code: 'AUTH_TOKEN_EXPIRED', message: 'Session expired' })
    session.send('Continue'); await tick()
    session.send('/login'); await tick()
    sdk.loginResult.resolve({}); await tick()
    expect(sdk.history).toHaveBeenCalledTimes(1)
    expect(sdk.resume).toHaveBeenCalledTimes(3)
    expect(session.snapshot().items.filter((item) => item.kind === 'assistant_message' && item.text === 'Earlier')).toHaveLength(1)
    expect(sdk.sends[0].message.text).toBe('Continue')
    session.close()
  })
  it.each([false, true])('removes rejected environment keys after login and still redacts them (shared env: %s)', async (shared) => {
    vi.stubEnv('CURSOR_API_KEY', 'rejected-test-key')
    const env = shared ? process.env : { CURSOR_API_KEY: 'rejected-test-key' }
    const { session, sdk } = harness({ env })
    try {
      sdk.listModels.mockRejectedValueOnce({ code: 'BAD_USER_API_KEY', message: 'Rejected' })
      await session.start()
      expect(session.snapshot().session.login?.state).toBe('required')
      session.send('/login'); await tick()
      sdk.loginResult.resolve({}); await tick()
      expect(process.env.CURSOR_API_KEY).toBeUndefined()
      expect(env.CURSOR_API_KEY).toBeUndefined()
      expect(session.snapshot().session.login).toBeUndefined()
      sdk.agent.send = async () => { throw new Error('Network error for rejected-test-key') }
      session.send('Check redaction'); await tick()
      expect(session.snapshot().items.at(-1)).toMatchObject({ kind: 'notice', level: 'error', text: 'Message not sent: Network error for [redacted]' })
      expect(JSON.stringify(session.snapshot())).not.toContain('rejected-test-key')
    } finally { session.close(); await tick(); vi.unstubAllEnvs() }
  })
  it.each(['send', 'login'])('retries a startup failure without an agent on the next %s', async (retry) => {
    const { session, sdk } = harness()
    sdk.listModels.mockRejectedValueOnce(new Error('disk unavailable'))
    await session.start()
    expect(session.snapshot().session.status).toBe('idle')
    expect(session.snapshot().items.at(-1)).toMatchObject({ kind: 'notice', level: 'error', text: "Couldn't start Cursor: disk unavailable. Sending a message retries." })
    session.send(retry === 'send' ? 'Retry' : '/login'); await tick()
    if (retry === 'login') { sdk.loginResult.resolve({}); await tick(); session.send('Retry'); await tick() }
    expect(sdk.create).toHaveBeenCalledTimes(1)
    expect(sdk.sends[0].message.text).toBe('Retry')
    expect(session.snapshot().session.status).toBe('running')
    session.close()
  })
  it('recovers a ready failure after browser login on the next send', async () => {
    const { session, sdk } = harness()
    sdk.authStatus.mockResolvedValue({ status: 'logged-out' })
    await session.start()
    sdk.listModels.mockRejectedValueOnce(new Error('disk unavailable'))
    session.send('/login'); await tick()
    sdk.authStatus.mockResolvedValue({ status: 'logged-in' })
    sdk.loginResult.resolve({}); await tick()
    expect(session.snapshot().session.status).toBe('idle')
    expect(session.snapshot().session.login).toBeUndefined()
    session.send('Retry ready'); await tick()
    expect(sdk.create).toHaveBeenCalledTimes(1)
    expect(sdk.sends[0].message.text).toBe('Retry ready')
    session.close()
  })
  it('keeps the existing agent usable when reloading models after login fails', async () => {
    const { session, sdk } = harness({ resume: 'old-agent' })
    await session.start()
    sdk.listModels.mockRejectedValueOnce(new Error('models unavailable'))
    session.send('/login'); await tick()
    sdk.loginResult.resolve({}); await tick()
    expect(session.snapshot().session.status).toBe('idle')
    expect(session.snapshot().session.login).toBeUndefined()
    expect(session.snapshot().items.some((item) => item.kind === 'notice' && item.level === 'error' && item.text.includes('models unavailable'))).toBe(true)
    session.send('Continue'); await tick()
    expect(sdk.sends[0].message.text).toBe('Continue')
    expect(sdk.resume).toHaveBeenCalledTimes(1)
    expect(sdk.create).not.toHaveBeenCalled()
    expect(sdk.listModels).toHaveBeenCalledTimes(2)
    session.close()
  })
  it('handles rejected explicit keys without emitting them', async () => {
    const { session, sdk } = harness({ env: { CURSOR_API_KEY: 'secret-key' } })
    sdk.listModels.mockRejectedValue(new Error('Invalid API key secret-key'))
    await session.start()
    expect(session.snapshot().session.login?.reason).toBe('CURSOR_API_KEY was rejected by Cursor; unset it or replace it, then log in.')
    expect(JSON.stringify(session.snapshot())).not.toContain('secret-key')
    expect(sdk.create).not.toHaveBeenCalled()
    session.close()
  })
  it('cancels a pending login quietly and reports login and ordinary startup failures', async () => {
    const { session, sdk } = harness()
    sdk.authStatus.mockResolvedValue({ status: 'logged-out' })
    await session.start()
    session.send('/login'); await tick()
    session.send('/login cancel'); await tick()
    expect(sdk.loginOptions!.signal.aborted).toBe(true)
    expect(session.snapshot().session.login?.state).toBe('required')
    expect(session.snapshot().items.filter((item) => item.kind === 'notice' && item.level === 'error')).toHaveLength(0)
    session.close()
    const other = harness()
    other.sdk.listModels.mockRejectedValue(new Error('disk failed'))
    await other.session.start()
    expect(other.session.snapshot().session).toMatchObject({ status: 'idle', error: 'disk failed' })
    other.session.close()
    const failed = harness()
    failed.sdk.authStatus.mockResolvedValue({ status: 'logged-out' })
    await failed.session.start()
    failed.session.send('/login'); await tick()
    failed.sdk.loginResult.reject(new Error('login failed')); await tick()
    expect(failed.session.snapshot().session.login).toEqual({ state: 'required', reason: 'login failed' })
    failed.session.close()
  })
  it('reads and sniffs images, queues them without steering and rejects unsupported input', async () => {
    const read = vi.fn(async () => Buffer.from('GIF89a'))
    const { session, sdk } = await running({ images: { read } as unknown as AgentSessionSpec['images'] })
    const images = [{ id: 'test.png' }]
    session.send('Picture', images); await tick()
    expect(sdk.runs[0].steer).not.toHaveBeenCalled()
    sdk.runs[0].finish(); await tick()
    expect(sdk.sends[1].message.images).toEqual([{ data: Buffer.from('GIF89a').toString('base64'), mimeType: 'image/gif' }])
    sdk.runs[1].finish(); await tick()
    read.mockResolvedValue(Buffer.from('svg'))
    session.send('Bad', images); await tick()
    expect(sdk.sends).toHaveLength(2)
    session.send('Many', Array.from({ length: MAX_CHAT_IMAGES + 1 }, () => images[0])); await tick()
    expect(session.snapshot().items.at(-1)).toMatchObject({ kind: 'notice', text: 'Message not sent: Too many images' })
    session.close()
  })
  it('sends a video as a note after the text, without reading it as an image', async () => {
    const video = `${'e'.repeat(64)}.mov`
    const read = vi.fn()
    const stage = vi.fn(async (id: string, folder: string) => `/sessions/${folder}/${id}`)
    const { session, sdk } = await running({ images: { read, stage } as unknown as AgentSessionSpec['images'] })
    sdk.runs[0].finish(); await tick()
    session.send('Watch', [{ id: video, name: 'clip.mov' }]); await tick()
    expect(read).not.toHaveBeenCalled()
    const message = sdk.sends.at(-1)!.message
    expect(message.images).toBeUndefined()
    expect(message.text).toMatch(new RegExp(`^Watch\\n\\n\\[Attached video "clip\\.mov" is saved at: /sessions/[0-9a-f-]{36}/${video}\\]$`))
    expect(session.snapshot().items.filter((item) => item.kind === 'user_message').at(-1)).toMatchObject({ text: 'Watch', images: [{ id: video, name: 'clip.mov' }] })
    session.close()
  })
  it('closes once after cancellation, rejects unsupported controls and never answers', async () => {
    const { session, sdk } = await running()
    expect(session.answer('x', { kind: 'approval', decision: 'allow' })).toBe(false)
    await expect(session.controlTask('stop', 'a', 't')).rejects.toThrow('not available')
    expect(await session.subagentTranscript('a')).toMatchObject({ items: [], error: expect.stringContaining('not available') })
    const closed = vi.fn()
    session.on('closed', closed)
    session.close(); session.close(); await tick()
    expect(sdk.runs[0].cancel).toHaveBeenCalledTimes(1)
    expect(sdk.agent.close).toHaveBeenCalledTimes(1)
    expect(closed).toHaveBeenCalledTimes(1)
    expect(session.snapshot().session.status).toBe('closed')
  })
})
