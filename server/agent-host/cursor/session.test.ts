import { describe, expect, it, vi } from 'vitest'
import type { AgentOptions, ConversationTurn, ModelListItem, Run, RunResult, SDKMessage, SDKUserMessage, SendOptions, SteerAckOutcome } from '@cursor/sdk'
import { MAX_CHAT_IMAGES, MAX_CHAT_ITEMS, MAX_QUEUED_MESSAGES, parseChatSessionInfo } from '../../../shared/agent-chat.js'
import type { AgentSessionSpec } from '../session.js'
import { CURSOR_SETTING_SOURCES, CursorChatSession, cursorImageMime, cursorModels, cursorModelSelection, cursorPermissions, isCursorAuthError } from './session.js'
import type { CursorMcpCli, CursorMcpLoginProcess } from './mcp.js'
import type { CursorAgent, CursorCloudHistory, CursorCloudRun, CursorHistory, CursorRun, CursorSdk } from './sdk.js'

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
  id = 'run-cloud'
  status: Run['status'] = 'running'
  createdAt = 1
  git?: Run['git']
  turns: ConversationTurn[] = []
  conversation = vi.fn(async () => this.turns)
  private messages: SDKMessage[] = []
  private changed = deferred<void>()
  private streamEnded = false
  private streamError?: Error
  private wake() { this.changed.resolve(); this.changed = deferred<void>() }
  push(...messages: SDKMessage[]) { this.messages.push(...messages); this.wake() }
  endStream() { this.streamEnded = true; this.wake() }
  failStream(error: Error) { this.streamError = error; this.wake() }
  private async *events(): AsyncGenerator<SDKMessage, void> {
    while (true) {
      while (this.messages.length) yield this.messages.shift()!
      if (this.streamError) throw this.streamError
      if (this.streamEnded) return
      await this.changed.promise
    }
  }
  stream = vi.fn(() => this.events())
  readonly done = deferred<RunResult>()
  wait = vi.fn(() => this.done.promise)
  cancel = vi.fn(async () => { this.finish('cancelled') })
  steer = vi.fn(async (_text: string): Promise<SteerAckOutcome> => 'complete_delivered')
  finish(status: RunResult['status'] = 'finished', error?: RunResult['error']) { this.status = status; this.endStream(); this.done.resolve({ id: 'run', status, error, ...(this.git ? { git: this.git } : {}) }) }
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
    reload: vi.fn(async () => undefined),
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
  readonly cloudRun = new FakeRun()
  cloudHistory = vi.fn(async (_id: string): Promise<CursorCloudHistory> => ({ turns: [], skipped: 0 }))
  latestCloudRun = vi.fn(async (_agentId: string): Promise<CursorCloudRun | undefined> => undefined)
  getRun = vi.fn(async (_runId: string, _agentId: string) => this.cloudRun)
  delta(update: unknown, index = this.sends.length - 1) { this.sends[index].options.onDelta?.({ update: update as Parameters<NonNullable<SendOptions['onDelta']>>[0]['update'] }) }
}
function harness(spec: Partial<AgentSessionSpec> = {}, mcpCli: CursorMcpCli | null = null) {
  const sdk = new FakeSdk()
  const session = new CursorChatSession({ paneId: '%3', cwd: '/tmp', permissionMode: 'bypassPermissions', env: {}, ...spec }, sdk, mcpCli)
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
    expect(sdk.create).toHaveBeenCalledWith({ name: 'A'.repeat(80), model, disallowedTools: ['askQuestion'], local: { cwd: '/tmp', settingSources: [...CURSOR_SETTING_SOURCES], sandboxOptions: { enabled: false } } })
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
    expect(sdk.create).toHaveBeenCalledWith({ name: 'Hello', model: { id: 'test-model', params: [{ id: 'reasoning_effort', value: 'high' }, { id: 'fast', value: 'true' }] }, disallowedTools: ['askQuestion'], local: { cwd: '/tmp', settingSources: [...CURSOR_SETTING_SOURCES], sandboxOptions: { enabled: false } } })
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
  it('steers the whole queue in as one message', async () => {
    const { session, sdk } = await running()
    session.send('First', [], { delivery: 'queue' }); session.send('Second', [], { delivery: 'queue' }); await tick()
    session.updateQueue({ action: 'steer_all' }); await tick()
    expect(sdk.runs[0].steer).toHaveBeenCalledWith('First\n\nSecond')
    expect(session.queued).toEqual([])
    session.close()
  })
  it('keeps queue order when Steer all takes a batch with images, which Cursor cannot steer', async () => {
    const { session, sdk } = await running()
    const six = Array.from({ length: 6 }, (_, i) => ({ id: `${i}.png` }))
    session.send('First', six, { delivery: 'queue' }); session.send('Second', six, { delivery: 'queue' }); await tick()
    session.updateQueue({ action: 'steer_all' }); await tick()
    expect(sdk.runs[0].steer).not.toHaveBeenCalled()
    expect(session.queued.map((entry) => entry.text)).toEqual(['First', 'Second'])
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
    expect(sdk.resume).toHaveBeenCalledWith('agent-123', { model: cursorModelSelection(models[1], 'high', true), disallowedTools: ['askQuestion'], local: { cwd: '/tmp', settingSources: [...CURSOR_SETTING_SOURCES], sandboxOptions: { enabled: false }, autoReview: true } })
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
    expect(sdk.create.mock.calls[0][0].local).toEqual({ cwd: '/tmp', settingSources: [...CURSOR_SETTING_SOURCES], sandboxOptions: { enabled: false } })
    expect(session.snapshot().session.prePlanPermissionMode).toBe('bypassPermissions')
    sdk.delta({ type: 'tool-call-completed', callId: 'p', toolCall: { type: 'createPlan', args: { plan: '# Plan\nDo this' } } })
    expect(session.snapshot().items.at(-1)).toMatchObject({ kind: 'plan', text: '# Plan\nDo this' })
    sdk.runs[0].finish(); await tick()
    session.send('Implement', [], { permissionMode: 'bypassPermissions' }); await tick()
    expect(sdk.sends[1].options.mode).toBe('agent')
    expect(session.snapshot().session.prePlanPermissionMode).toBeUndefined()
    expect(sdk.resume).toHaveBeenCalledWith('agent-123', expect.objectContaining({ local: { cwd: '/tmp', settingSources: [...CURSOR_SETTING_SOURCES], sandboxOptions: { enabled: false } } }))
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
    expect(sdk.resume).toHaveBeenCalledWith('old-agent', expect.objectContaining({ disallowedTools: ['askQuestion'], local: { cwd: '/tmp', settingSources: [...CURSOR_SETTING_SOURCES], sandboxOptions: { enabled: false } } }))
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

  it('manages MCP servers via reload and requests restart when auth changes after executor start', async () => {
    const loginDone = deferred<{ ok: boolean; error?: string }>()
    const cancel = vi.fn()
    const cli: CursorMcpCli = {
      run: vi.fn(async (args) => {
        if (args[1] === 'list') return { stdout: 'linear: requires_authentication\n', stderr: '', exitCode: 0 }
        return { stdout: '', stderr: '', exitCode: 0 }
      }),
      startLogin: vi.fn(async (): Promise<CursorMcpLoginProcess> => ({
        authUrl: Promise.resolve('https://mcp.linear.app/oauth/authorize'),
        done: loginDone.promise,
        cancel,
      })),
    }
    // Before an agent executor has been created, auth changes do not need a host restart.
    const beforeExec = harness({}, cli)
    const beforeRestart = vi.fn()
    beforeExec.session.on('restart', beforeRestart)
    await beforeExec.session.start()
    const authResult = await beforeExec.session.mcp({ action: 'authenticate', server: 'linear' })
    expect(authResult.authUrl).toBe('https://mcp.linear.app/oauth/authorize')
    loginDone.resolve({ ok: true })
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(beforeRestart).not.toHaveBeenCalled()
    beforeExec.session.close()

    // Once an agent executor has started, reconnect reloads it and auth completion triggers a restart.
    const secondDone = deferred<{ ok: boolean; error?: string }>()
    vi.mocked(cli.startLogin).mockResolvedValueOnce({
      authUrl: Promise.resolve('https://mcp.linear.app/oauth/authorize?two=1'),
      done: secondDone.promise,
      cancel: vi.fn(),
    })
    const { session, sdk } = harness({}, cli)
    const restart = vi.fn()
    session.on('restart', restart)
    await session.start()
    session.send('Hi'); await tick()
    sdk.runs[0].finish(); await tick()

    await session.mcp({ action: 'reconnect', server: 'linear' })
    expect(sdk.agent.reload).toHaveBeenCalledTimes(1)

    const secondAuth = await session.mcp({ action: 'authenticate', server: 'linear' })
    expect(secondAuth.authUrl).toBe('https://mcp.linear.app/oauth/authorize?two=1')
    secondDone.resolve({ ok: true })
    await vi.waitFor(() => expect(restart).toHaveBeenCalledTimes(1))
    expect(session.snapshot().items.at(-1)).toMatchObject({ kind: 'notice', text: expect.stringContaining('MCP credentials updated for linear') })
    session.close()
  })
})

const cloudSpec = { cursorCloud: { repoUrl: 'https://github.com/acme/app', startingRef: 'feature/cloud' } }
const cloudTurn = (prompt: string, reply: string): ConversationTurn => ({ type: 'agentConversationTurn', turn: { userMessage: { text: prompt }, steps: [{ type: 'assistantMessage', message: { text: reply } }] } })
describe('Cursor cloud chats', () => {
  it.each(['loaded', 'empty', 'failed'] as const)('shows a temporary notice before history starts and replaces it when %s', async (outcome) => {
    const { session, sdk } = harness({ ...cloudSpec, resume: 'bc-cloud123' })
    const history = deferred<CursorCloudHistory>()
    const items = vi.fn()
    session.on('items', items)
    sdk.cloudHistory.mockImplementation(() => {
      expect(session.snapshot().items.at(-1)).toMatchObject({ kind: 'notice', level: 'info', text: 'Loading this Cursor cloud chat…' })
      return history.promise
    })
    const starting = session.start()
    await tick()
    expect(sdk.cloudHistory).toHaveBeenCalledOnce()
    expect(session.snapshot().session.status).toBe('starting')
    expect(session.snapshot().items.at(-1)).toMatchObject({ text: 'Loading this Cursor cloud chat…' })
    if (outcome === 'failed') history.reject(new Error('Unavailable'))
    else history.resolve({ turns: outcome === 'loaded' ? [cloudTurn('Prompt', 'Answer')] : [], skipped: 0 })
    await starting
    expect(session.snapshot().items.some((item) => 'text' in item && item.text === 'Loading this Cursor cloud chat…')).toBe(false)
    expect(items.mock.calls.some((call) => call[1] === true)).toBe(true)
    if (outcome === 'loaded') expect(session.snapshot().items.map((item) => 'text' in item ? item.text : '')).toEqual(['Prompt', 'Answer'])
    else if (outcome === 'empty') expect(session.snapshot().items).toEqual([])
    else expect(session.snapshot().items.at(-1)).toMatchObject({ text: "Couldn't load this chat's earlier messages: Unavailable" })
    expect(session.snapshot().session.status).toBe('idle')
    session.close()
  })
  it.each(['started here', 'reattached'] as const)('detaches on close without cancelling a cloud run %s', async (source) => {
    const { session, sdk } = harness({ ...cloudSpec, ...(source === 'reattached' ? { resume: 'bc-cloud123' } : {}) })
    sdk.latestCloudRun.mockResolvedValue(sdk.cloudRun)
    if (source === 'reattached') sdk.cloudHistory.mockResolvedValue({ turns: [], skipped: 0, running: { id: sdk.cloudRun.id } })
    await session.start()
    if (source === 'started here') { session.send('Keep working'); await tick() }
    const run = source === 'reattached' ? sdk.cloudRun : sdk.runs[0]
    expect(session.snapshot().session.status).toBe('running')
    const closed = vi.fn()
    session.on('closed', closed)
    session.close(); await tick()
    expect(run.cancel).not.toHaveBeenCalled()
    expect(run.status).toBe('running')
    expect(sdk.agent.close).toHaveBeenCalledTimes(1)
    expect(session.snapshot().session.status).toBe('closed')
    expect(closed).toHaveBeenCalledTimes(1)
    run.finish(); await tick()
    expect(run.cancel).not.toHaveBeenCalled()
    expect(session.snapshot().session.status).toBe('closed')
  })
  it('does not cancel a cloud run whose send completes after close', async () => {
    const { session, sdk } = harness(cloudSpec)
    const sending = deferred<CursorRun>()
    sdk.agent.send = vi.fn(() => sending.promise)
    await session.start()
    session.send('Keep working'); await tick()
    session.close()
    sending.resolve(sdk.cloudRun); await tick()
    expect(sdk.cloudRun.cancel).not.toHaveBeenCalled()
    expect(sdk.agent.close).toHaveBeenCalledTimes(1)
    expect(session.snapshot().session.status).toBe('closed')
    sdk.cloudRun.finish()
  })
  it('still cancels a cloud run started here on explicit Stop', async () => {
    const { session, sdk } = await running(cloudSpec)
    await session.interrupt(); await tick()
    expect(sdk.runs[0].cancel).toHaveBeenCalledTimes(1)
    expect(session.snapshot().session.status).toBe('idle')
    session.close(); await tick()
    expect(sdk.runs[0].cancel).toHaveBeenCalledTimes(1)
  })
  it.each([
    { next: {}, branch: 'cursor/original', prUrl: 'https://github.com/acme/app/pull/1' },
    { next: { branch: 'cursor/next' }, branch: 'cursor/next', prUrl: 'https://github.com/acme/app/pull/1' },
    { next: { prUrl: 'https://github.com/acme/app/pull/2' }, branch: 'cursor/original', prUrl: 'https://github.com/acme/app/pull/2' },
  ])('preserves missing git fields from a later run: $next', async ({ next, branch, prUrl }) => {
    const { session, sdk } = harness({ ...cloudSpec, resume: 'bc-cloud123' })
    sdk.cloudHistory.mockResolvedValue({ turns: [], skipped: 0, git: { repoUrl: cloudSpec.cursorCloud.repoUrl, branch: 'cursor/original', prUrl: 'https://github.com/acme/app/pull/1' } })
    await session.start()
    session.send('Continue'); await tick()
    sdk.runs[0].git = { branches: [{ repoUrl: cloudSpec.cursorCloud.repoUrl, ...next }] }
    sdk.runs[0].finish(); await tick()
    expect(session.snapshot().session.cloud).toMatchObject({ branch, prUrl })
    session.close()
  })
  it('creates with only cloud options, sends images and plan mode, and publishes web and git info', async () => {
    const read = vi.fn(async () => Buffer.from('GIF89a'))
    const { session, sdk } = harness({ ...cloudSpec, permissionMode: 'plan', model: 'test-model', effort: 'high', fast: true, images: { read } as unknown as AgentSessionSpec['images'] })
    sdk.agent = { ...sdk.agent, agentId: 'bc-cloud123' }
    await session.start()
    session.send('Build this', [{ id: 'test.png' }]); await tick()
    const model = { id: 'test-model', params: [{ id: 'reasoning_effort', value: 'high' }, { id: 'fast', value: 'true' }] }
    expect(sdk.create).toHaveBeenCalledWith({ model, name: 'Build this', cloud: { repos: [{ url: cloudSpec.cursorCloud.repoUrl, startingRef: 'feature/cloud' }], autoCreatePR: true, metadata: { commando: 'chat' } } })
    expect(sdk.sends[0].options).toMatchObject({ model, mode: 'plan' })
    expect(sdk.sends[0].message.images).toEqual([{ data: Buffer.from('GIF89a').toString('base64'), mimeType: 'image/gif' }])
    sdk.delta({ type: 'text-delta', text: 'Cloud reply' })
    sdk.runs[0].git = { branches: [{ repoUrl: cloudSpec.cursorCloud.repoUrl, branch: 'cursor/feature', prUrl: 'https://github.com/acme/app/pull/1' }] }
    sdk.runs[0].finish(); await tick()
    const cloud = { provider: 'cursor', ...cloudSpec.cursorCloud, webUrl: 'https://cursor.com/agents/bc-cloud123', branch: 'cursor/feature', prUrl: 'https://github.com/acme/app/pull/1' }
    expect(session.snapshot().session.cloud).toEqual(cloud)
    expect(parseChatSessionInfo(session.snapshot().session)?.cloud).toEqual(cloud)
    expect(session.snapshot().items).toContainEqual(expect.objectContaining({ kind: 'assistant_message', text: 'Cloud reply', status: 'completed' }))
    const restart = vi.fn()
    session.on('restart', restart)
    await session.configure({ permissionMode: 'bypassPermissions' })
    session.send('Implement'); await tick()
    expect(sdk.sends[1].options.mode).toBe('agent')
    sdk.runs[1].finish(); await tick()
    expect(session.snapshot().session.cloud).toEqual(cloud) // A run without git does not erase the newest known branch.
    expect(restart).not.toHaveBeenCalled()
    expect(sdk.resume).not.toHaveBeenCalled()
    session.close()
  })
  it.each(['default', 'auto', 'acceptEdits', 'dontAsk'] as const)('rejects %s at construction, configure and per-send', async (permissionMode) => {
    expect(() => harness({ ...cloudSpec, permissionMode })).toThrow('Cursor cloud supports only')
    expect(() => harness({ ...cloudSpec, permissionMode: 'plan', prePlanPermissionMode: permissionMode })).toThrow('Cursor cloud supports only')
    const { session, sdk } = harness(cloudSpec)
    await session.start()
    await session.configure({ permissionMode })
    expect(session.snapshot().session.permissionMode).toBe('bypassPermissions')
    expect(session.snapshot().items.at(-1)).toMatchObject({ kind: 'notice', level: 'error', text: expect.stringContaining('Cursor cloud supports only') })
    session.send('Invalid mode', [], { permissionMode }); await tick()
    expect(sdk.create).not.toHaveBeenCalled()
    session.close()
  })
  it('refuses videos before queuing or staging, and never manages MCP servers', async () => {
    const stage = vi.fn()
    const cli: CursorMcpCli = { run: vi.fn(), startLogin: vi.fn() }
    const { session, sdk } = harness({ ...cloudSpec, images: { stage } as unknown as AgentSessionSpec['images'] }, cli)
    await session.start()
    session.send('Watch', [{ id: `${'e'.repeat(64)}.mov` }]); await tick()
    expect(session.snapshot().items.at(-1)).toMatchObject({ kind: 'notice', level: 'error', text: expect.stringContaining("Cursor cloud chats don't support video attachments") })
    expect(stage).not.toHaveBeenCalled()
    expect(sdk.create).not.toHaveBeenCalled()
    for (const request of [{ action: 'status' }, { action: 'authenticate', server: 'linear' }] as const) {
      expect(await session.mcp(request)).toEqual({ servers: [], error: "MCP servers aren't available in Cursor cloud chats" })
    }
    expect(cli.run).not.toHaveBeenCalled()
    expect(cli.startLogin).not.toHaveBeenCalled()
    session.close()
  })
  it.each([false, true])('renews a cloud wait deadline without settling or flushing queued messages (resumed=%s)', async (resumed) => {
    const { session, sdk } = harness({ ...cloudSpec, ...(resumed ? { resume: 'bc-cloud123' } : {}) })
    if (resumed) sdk.latestCloudRun.mockResolvedValue(sdk.cloudRun)
    if (resumed) sdk.cloudHistory.mockResolvedValue({ turns: [], skipped: 0, running: { id: sdk.cloudRun.id } })
    await session.start()
    if (!resumed) { session.send('Work'); await tick() }
    session.send('Follow-up', [], { delivery: 'queue' }); await tick()
    const original = resumed ? sdk.cloudRun : sdk.runs[0]
    const renewed = new FakeRun()
    sdk.getRun.mockResolvedValue(renewed)
    original.finish('error', { message: 'Timed out waiting for the cloud run to finish.' }); await tick()
    expect(sdk.getRun).toHaveBeenLastCalledWith(original.id, sdk.agent.agentId)
    expect(renewed.stream).toHaveBeenCalledOnce()
    expect(session.snapshot().session.status).toBe('running')
    expect(session.queued.map((entry) => entry.text)).toEqual(['Follow-up'])
    expect(sdk.sends).toHaveLength(resumed ? 0 : 1)
    expect(session.snapshot().items.filter((item) => item.kind === 'notice' && item.text.includes('Reconnected'))).toHaveLength(resumed ? 1 : 0)
    expect(session.snapshot().items.some((item) => item.kind === 'notice' && item.level === 'error')).toBe(false)
    renewed.turns = [cloudTurn('Work', 'Done')]
    renewed.finish(); await tick(); await tick()
    expect(renewed.conversation).toHaveBeenCalledOnce()
    expect(session.queued).toEqual([])
    expect(sdk.sends.at(-1)?.message.text).toBe('Follow-up')
    expect(original.cancel).not.toHaveBeenCalled()
    expect(renewed.cancel).not.toHaveBeenCalled()
    session.close()
  })

  it.each([
    { cloud: false, error: { message: 'Timed out waiting for the cloud run to finish.' } },
    { cloud: true, error: { message: 'Timed out waiting for the cloud run to finish.', code: 'other_error' } },
    { cloud: true, error: { message: 'Timed out waiting for the cloud run' } },
  ])('only renews the precise SDK cloud deadline: %j', async ({ cloud, error }) => {
    const { session, sdk } = await running(cloud ? cloudSpec : {})
    sdk.runs[0].finish('error', error); await tick()
    expect(sdk.getRun).not.toHaveBeenCalled()
    expect(session.snapshot().session.status).toBe('idle')
    expect(session.snapshot().items).toContainEqual(expect.objectContaining({ kind: 'notice', level: 'error', text: error.message }))
    session.close()
  })

  it('uses the actual terminal status if a cloud deadline races completion', async () => {
    const { session, sdk } = await running(cloudSpec)
    sdk.cloudRun.finish()
    sdk.runs[0].finish('error', { message: 'Timed out waiting for the cloud run to finish.' }); await tick()
    expect(sdk.getRun).toHaveBeenCalledWith(sdk.runs[0].id, sdk.agent.agentId)
    expect(session.snapshot().session.status).toBe('idle')
    expect(session.snapshot().items.some((item) => item.kind === 'notice' && item.level === 'error')).toBe(false)
    session.close()
  })

  it('resumes with only model, loads cloud history and skipped notices, and preserves git info', async () => {
    const { session, sdk } = harness({ ...cloudSpec, resume: 'bc-cloud123' })
    sdk.agent = { ...sdk.agent, agentId: 'bc-cloud123' }
    sdk.cloudHistory.mockResolvedValue({ turns: [cloudTurn('Earlier', 'Reply')], skipped: 1, git: { repoUrl: cloudSpec.cursorCloud.repoUrl, branch: 'cursor/history', prUrl: 'https://github.com/acme/app/pull/2' } })
    await session.start()
    expect(sdk.resume).toHaveBeenCalledWith('bc-cloud123', { model: { id: 'auto' } })
    expect(sdk.cloudHistory).toHaveBeenCalledWith('bc-cloud123')
    expect(sdk.history).not.toHaveBeenCalled()
    expect(session.snapshot().items.map((item) => 'text' in item ? item.text : '')).toEqual(['Earlier', 'Reply', "1 earlier Cursor turns couldn't be loaded."])
    expect(session.snapshot().session.cloud).toMatchObject({ branch: 'cursor/history', prUrl: 'https://github.com/acme/app/pull/2', webUrl: 'https://cursor.com/agents/bc-cloud123' })
    session.send('Continue'); await tick()
    expect(sdk.create).not.toHaveBeenCalled()
    expect(sdk.sends[0].message.text).toBe('Continue')
    session.close()
  })
  it.each(['older conversations unavailable', 'older run page unavailable'])('reattaches independently when history fails: %s', async (message) => {
    const { session, sdk } = harness({ ...cloudSpec, resume: 'bc-cloud123' })
    sdk.agent = { ...sdk.agent, agentId: 'bc-cloud123' }
    sdk.cloudHistory.mockRejectedValue(new Error(message))
    sdk.latestCloudRun.mockResolvedValue(sdk.cloudRun)
    await session.start()
    expect(sdk.latestCloudRun).toHaveBeenCalledWith('bc-cloud123')
    expect(sdk.getRun).toHaveBeenCalledWith(sdk.cloudRun.id, 'bc-cloud123')
    expect(sdk.cloudRun.stream).toHaveBeenCalledOnce()
    expect(sdk.cloudRun.conversation).not.toHaveBeenCalled()
    expect(session.snapshot().session.status).toBe('running')
    expect(session.busy).toBe(true)
    expect(session.snapshot().items.map((item) => 'text' in item ? item.text : '')).toEqual([
      `Couldn't load this chat's earlier messages: ${message}`,
      'Reconnected to a Cursor cloud run that was already working.',
    ])
    session.send('Follow up', [], { delivery: 'queue' }); await tick()
    expect(session.queued.map((entry) => entry.text)).toEqual(['Follow up'])
    expect(sdk.sends).toHaveLength(0)
    sdk.cloudRun.turns = [cloudTurn('Working prompt', 'Finished reply')]
    sdk.cloudRun.finish(); await tick(); await tick()
    expect(session.snapshot().items).toContainEqual(expect.objectContaining({ text: 'Finished reply', status: 'completed' }))
    expect(sdk.sends[0].message.text).toBe('Follow up')
    expect(sdk.cloudRun.cancel).not.toHaveBeenCalled()
    session.close()
  })

  it.each(['finished', 'cancelled', 'error', undefined] as const)('does not reattach a newest run with status %s after history failure', async (status) => {
    const { session, sdk } = harness({ ...cloudSpec, resume: 'bc-cloud123' })
    sdk.cloudHistory.mockRejectedValue(new Error('History unavailable'))
    if (status) {
      sdk.cloudRun.status = status
      sdk.latestCloudRun.mockResolvedValue(sdk.cloudRun)
    }
    await session.start()
    expect(sdk.latestCloudRun).toHaveBeenCalledWith(sdk.agent.agentId)
    expect(sdk.getRun).not.toHaveBeenCalled()
    expect(sdk.cloudRun.stream).not.toHaveBeenCalled()
    expect(session.snapshot().session.status).toBe('idle')
    expect(session.snapshot().items).toHaveLength(1)
    expect(session.snapshot().items[0]).toMatchObject({ text: "Couldn't load this chat's earlier messages: History unavailable" })
    session.close()
  })

  it('reports a run lookup failure separately and preserves successfully loaded history', async () => {
    const { session, sdk } = harness({ ...cloudSpec, resume: 'bc-cloud123' })
    sdk.cloudHistory.mockResolvedValue({ turns: [cloudTurn('Earlier', 'Reply')], skipped: 0 })
    sdk.latestCloudRun.mockRejectedValue(new Error('Run lookup unavailable'))
    await session.start()
    expect(session.snapshot().items.map((item) => 'text' in item ? item.text : '')).toEqual([
      'Earlier', 'Reply', "Couldn't reconnect to this Cursor cloud run: Run lookup unavailable",
    ])
    expect(session.snapshot().session.status).toBe('idle')
    session.close()
  })

  it('does not reattach if the newest run finishes during lookup', async () => {
    const { session, sdk } = harness({ ...cloudSpec, resume: 'bc-cloud123' })
    sdk.latestCloudRun.mockResolvedValue(sdk.cloudRun)
    const finished = new FakeRun()
    finished.finish()
    sdk.getRun.mockResolvedValue(finished)
    await session.start()
    expect(sdk.getRun).toHaveBeenCalledWith(sdk.cloudRun.id, sdk.agent.agentId)
    expect(finished.stream).not.toHaveBeenCalled()
    expect(session.snapshot().session.status).toBe('idle')
    session.close()
  })

  it('retains only the newest cloud history items', async () => {
    const { session, sdk } = harness({ ...cloudSpec, resume: 'bc-cloud123' })
    sdk.cloudHistory.mockResolvedValue({ turns: Array.from({ length: MAX_CHAT_ITEMS + 1 }, (_, index) => ({ type: 'agentConversationTurn', turn: { userMessage: { text: String(index) }, steps: [] } })), skipped: 0 })
    await session.start()
    expect(session.snapshot().items).toHaveLength(MAX_CHAT_ITEMS)
    expect(session.snapshot().items[0]).toMatchObject({ text: '1' })
    session.close()
  })
  it.each(['finish', 'cancel'] as const)('reattaches through stream chunks, steers, queues and settles on %s', async (end) => {
    const { session, sdk } = harness({ ...cloudSpec, resume: 'bc-cloud123' })
    const items = vi.fn()
    session.on('items', items)
    sdk.agent = { ...sdk.agent, agentId: 'bc-cloud123' }
    sdk.latestCloudRun.mockResolvedValue(sdk.cloudRun)
    sdk.cloudHistory.mockResolvedValue({ turns: [cloudTurn('Old prompt', 'Old answer')], skipped: 0, running: { id: sdk.cloudRun.id } })
    const envelope = { agent_id: 'bc-cloud123', run_id: sdk.cloudRun.id }
    await session.start()
    expect(sdk.getRun).toHaveBeenCalledWith('run-cloud', 'bc-cloud123')
    expect(sdk.cloudRun.stream).toHaveBeenCalledTimes(1)
    expect(sdk.cloudRun.wait).not.toHaveBeenCalled()
    expect(session.snapshot().session.status).toBe('running')
    expect(session.busy).toBe(true)
    expect(session.snapshot().items.at(-1)).toMatchObject({ kind: 'notice', text: 'Reconnected to a Cursor cloud run that was already working.' })
    sdk.cloudRun.push(
      { ...envelope, type: 'thinking', text: 'Think' }, { ...envelope, type: 'thinking', text: ' more' },
      { ...envelope, type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Working' }] } },
      { ...envelope, type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: ' on it' }, { type: 'tool_use', id: 's', name: 'shell', input: { command: 'pwd' } }] } },
      { ...envelope, type: 'tool_call', call_id: 's', name: 'shell', status: 'running' },
      { ...envelope, type: 'tool_call', call_id: 's', name: 'shell', status: 'completed', result: { status: 'success', value: { stdout: '/cloud', stderr: '' } } },
      { ...envelope, type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Done' }] } },
      { ...envelope, type: 'status', status: 'FINISHED' },
    )
    await tick()
    expect(session.snapshot().items).toEqual(expect.arrayContaining([
      expect.objectContaining({ text: 'Old prompt' }), expect.objectContaining({ text: 'Old answer' }),
      expect.objectContaining({ kind: 'reasoning', text: 'Think more', status: 'completed' }),
      expect.objectContaining({ kind: 'assistant_message', text: 'Working on it', status: 'completed' }),
      expect.objectContaining({ kind: 'command', command: 'pwd', output: '/cloud', status: 'completed' }),
      expect.objectContaining({ kind: 'assistant_message', text: 'Done', status: 'running' }),
    ]))
    expect(session.snapshot().items.filter((item) => item.kind === 'command')).toHaveLength(1)
    expect(session.snapshot().session.status).toBe('running') // A status message does not own turn settlement.
    session.send('Steer'); await tick()
    expect(sdk.cloudRun.steer).toHaveBeenCalledWith('Steer')
    expect(session.snapshot().items.at(-1)).toMatchObject({ kind: 'user_message', text: 'Steer', steered: true })
    session.send('Next', [], { delivery: 'queue' }); await tick()
    expect(session.queued.map((entry) => entry.text)).toEqual(['Next'])
    sdk.cloudRun.endStream(); await tick()
    expect(sdk.cloudRun.wait).toHaveBeenCalledTimes(1)
    expect(session.snapshot().session.status).toBe('running')
    sdk.cloudRun.git = { branches: [{ repoUrl: cloudSpec.cursorCloud.repoUrl, branch: 'cursor/done', prUrl: 'https://github.com/acme/app/pull/3' }] }
    sdk.cloudRun.turns = [cloudTurn('Original prompt', 'Done'), cloudTurn('Steer', 'Steered answer')]
    if (end === 'cancel') await session.interrupt(session.queued.map((entry) => entry.id))
    else { session.updateQueue({ action: 'remove', id: session.queued[0].id }); sdk.cloudRun.finish() }
    await tick()
    expect(sdk.cloudRun.cancel).toHaveBeenCalledTimes(end === 'cancel' ? 1 : 0)
    expect(sdk.cloudRun.wait).toHaveBeenCalledTimes(1)
    expect(sdk.cloudRun.conversation).toHaveBeenCalledOnce()
    expect(items).toHaveBeenLastCalledWith(session.snapshot().items, true)
    expect(session.snapshot().items.map((item) => 'text' in item ? item.text : '')).toEqual([
      'Old prompt', 'Old answer', 'Reconnected to a Cursor cloud run that was already working.',
      'Original prompt', 'Done', 'Steer', 'Steered answer',
    ])
    expect(session.snapshot().session).toMatchObject({ status: 'idle', cloud: { branch: 'cursor/done', prUrl: 'https://github.com/acme/app/pull/3' } })
    expect(session.busy).toBe(false)
    expect(session.snapshot().items.find((item) => item.kind === 'assistant_message' && item.text === 'Done')).toMatchObject({ status: 'completed' })
    expect(sdk.sends).toHaveLength(0)
    session.close()
  })
  it.each(['absent', 'reverted'] as const)('queues a reattached run when steer is %s and sends the queue after stream and wait end', async (steer) => {
    const { session, sdk } = harness({ ...cloudSpec, resume: 'bc-cloud123' })
    sdk.latestCloudRun.mockResolvedValue(sdk.cloudRun)
    sdk.cloudHistory.mockResolvedValue({ turns: [], skipped: 0, running: { id: sdk.cloudRun.id } })
    if (steer === 'absent') Object.defineProperty(sdk.cloudRun, 'steer', { value: undefined })
    else sdk.cloudRun.steer.mockResolvedValue('revert_to_followup')
    await session.start()
    session.send('Follow up'); await tick()
    expect(session.queued.map((entry) => entry.text)).toEqual(['Follow up'])
    sdk.cloudRun.finish(); await tick()
    expect(sdk.sends[0].message.text).toBe('Follow up')
    expect(session.queued).toHaveLength(0)
    session.close()
  })
  it('waits for the result after a stream error before replacing partial items with the finished conversation', async () => {
    const log = vi.fn()
    const { session, sdk } = harness({ ...cloudSpec, resume: 'bc-cloud123', log })
    const items = vi.fn()
    session.on('items', items)
    sdk.latestCloudRun.mockResolvedValue(sdk.cloudRun)
    sdk.cloudHistory.mockResolvedValue({ turns: [cloudTurn('Old prompt', 'Old answer')], skipped: 1, running: { id: sdk.cloudRun.id } })
    await session.start()
    sdk.cloudRun.push({ agent_id: 'bc-cloud123', run_id: sdk.cloudRun.id, type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Partial' }] } })
    await tick()
    sdk.cloudRun.failStream(new Error('Connection dropped')); await tick()
    expect(sdk.cloudRun.wait).toHaveBeenCalledTimes(1)
    expect(sdk.cloudRun.conversation).not.toHaveBeenCalled()
    expect(session.snapshot().session.status).toBe('running')
    expect(session.snapshot().items.at(-1)).toMatchObject({ text: 'Partial', status: 'running' })
    sdk.cloudRun.turns = [cloudTurn('Recovered prompt', 'Complete answer')]
    sdk.cloudRun.git = { branches: [{ repoUrl: cloudSpec.cursorCloud.repoUrl, branch: 'cursor/recovered', prUrl: 'https://github.com/acme/app/pull/5' }] }
    sdk.cloudRun.finish(); await tick()
    expect(sdk.cloudRun.conversation).toHaveBeenCalledTimes(1)
    expect(items).toHaveBeenLastCalledWith(session.snapshot().items, true)
    expect(session.snapshot().items.map((item) => 'text' in item ? item.text : '')).toEqual(['Old prompt', 'Old answer', "1 earlier Cursor turns couldn't be loaded.", 'Reconnected to a Cursor cloud run that was already working.', 'Recovered prompt', 'Complete answer'])
    expect(session.snapshot().session).toMatchObject({ status: 'idle', cloud: { branch: 'cursor/recovered', prUrl: 'https://github.com/acme/app/pull/5' } })
    expect(session.snapshot().items.every((item) => item.status === 'completed')).toBe(true)
    expect(log).toHaveBeenCalledWith("Couldn't stream Cursor cloud run: Connection dropped")
    session.close()
  })
  it('settles partial streamed items and reports an unreadable fallback without losing history', async () => {
    const { session, sdk } = harness({ ...cloudSpec, resume: 'bc-cloud123' })
    sdk.latestCloudRun.mockResolvedValue(sdk.cloudRun)
    sdk.cloudHistory.mockResolvedValue({ turns: [cloudTurn('Old', 'Answer')], skipped: 0, running: { id: sdk.cloudRun.id } })
    await session.start()
    sdk.cloudRun.push({ agent_id: 'bc-cloud123', run_id: sdk.cloudRun.id, type: 'thinking', text: 'Partial thought' })
    await tick()
    sdk.cloudRun.failStream(new Error('Connection dropped')); await tick()
    sdk.cloudRun.conversation.mockRejectedValue(new Error('Unavailable'))
    sdk.cloudRun.finish('error', { message: 'Run failed' }); await tick()
    expect(session.snapshot().session.status).toBe('idle')
    expect(session.snapshot().items).toEqual(expect.arrayContaining([
      expect.objectContaining({ text: 'Old' }), expect.objectContaining({ text: 'Answer' }),
      expect.objectContaining({ text: 'Partial thought', status: 'failed' }),
      expect.objectContaining({ kind: 'notice', text: "Couldn't reload this Cursor cloud run: Unavailable" }),
      expect.objectContaining({ kind: 'notice', level: 'error', text: 'Run failed' }),
    ]))
    session.close()
  })
})
