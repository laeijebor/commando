import { describe, expect, it, vi } from 'vitest'
import type { AgentOptions, ConversationTurn, ModelListItem, RunResult, SDKUserMessage, SendOptions, SteerAckOutcome } from '@cursor/sdk'
import { MAX_CHAT_IMAGES, MAX_CHAT_ITEMS, MAX_QUEUED_MESSAGES, parseChatSessionInfo } from '../../../shared/agent-chat.js'
import type { AgentSessionSpec } from '../session.js'
import { CursorChatSession, cursorImageMime, cursorModels, cursorModelSelection, cursorPermissions, isCursorAuthError } from './session.js'
import type { CursorAgent, CursorRun, CursorSdk } from './sdk.js'

const models: ModelListItem[] = [
  { id: 'auto', displayName: 'Auto', description: 'Automatic' },
  { id: 'test-model', displayName: 'Test', parameters: [
    { id: 'reasoning_effort', values: [{ value: 'low' }, { value: 'high' }, { value: 'extreme' }] },
    { id: 'fast', values: [{ value: 'true' }, { value: 'false' }] },
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
  history = vi.fn(async (_id: string, _cwd: string): Promise<ConversationTurn[]> => [])
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
    expect(cursorPermissions('plan')).toEqual(cursorPermissions('bypassPermissions'))
    expect(cursorPermissions('plan', 'default')).toEqual(cursorPermissions('default'))
    expect(cursorPermissions('plan', 'auto')).toEqual(cursorPermissions('auto'))
    for (const mode of ['acceptEdits', 'dontAsk'] as const) expect(() => cursorPermissions(mode)).toThrow('does not support')
    expect(() => cursorPermissions('plan', 'plan')).toThrow('cannot be plan')
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
  it.each([{ name: 'AuthenticationError' }, { code: 'unauthenticated' }, new Error('[unknown] Invalid User API Key'), new Error('Invalid API key'), new Error('API key is required'), { status: 'error', error: { code: 'unauthenticated' } }])('recognizes auth rejection %j', (error) => {
    expect(isCursorAuthError(error)).toBe(true)
    expect(isCursorAuthError(new Error('Rate limit'))).toBe(false)
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
    expect(sdk.create).toHaveBeenCalledWith({ model: { id: 'test-model', params: [{ id: 'reasoning_effort', value: 'high' }, { id: 'fast', value: 'true' }] }, disallowedTools: ['askQuestion'], local: { cwd: '/tmp', sandboxOptions: { enabled: false } } })
    expect(parseChatSessionInfo(session.snapshot().session)).not.toBeNull()
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
    const { session, sdk } = await running()
    await session.configure({ model: 'test-model', effort: 'high', fast: true, permissionMode: 'default' })
    expect(sdk.resume).not.toHaveBeenCalled()
    sdk.runs[0].finish(); await tick()
    session.send('Next'); await tick()
    expect(sdk.agent.close).toHaveBeenCalledTimes(1)
    expect(sdk.resume).toHaveBeenCalledWith('agent-123', { model: cursorModelSelection(models[1], 'high', true), disallowedTools: ['askQuestion'], local: { cwd: '/tmp', sandboxOptions: { enabled: true } } })
    expect(sdk.sends[1].options.model).toEqual(cursorModelSelection(models[1], 'high', true))
    await session.configure({ effort: 'medium' })
    await session.configure({ model: 'unknown' })
    await session.configure({ permissionMode: 'acceptEdits' })
    expect(session.snapshot().session).toMatchObject({ effort: 'high', permissionMode: 'default', selectedModel: 'test-model' })
    sdk.runs[1].finish(); await tick()
    session.send('Again'); await tick()
    expect(sdk.sends[2].options.model).toEqual(sdk.sends[1].options.model)
    expect(sdk.resume).toHaveBeenCalledTimes(1)
    session.close()
  })
  it('sends plan mode and maps createPlan, then Implement leaves plan mode', async () => {
    const { session, sdk } = harness({ permissionMode: 'plan', prePlanPermissionMode: 'default' })
    await session.start()
    session.send('Plan'); await tick()
    expect(sdk.sends[0].options.mode).toBe('plan')
    expect(sdk.create.mock.calls[0][0].local).toEqual({ cwd: '/tmp', sandboxOptions: { enabled: true } })
    sdk.delta({ type: 'tool-call-completed', callId: 'p', toolCall: { type: 'createPlan', args: { plan: '# Plan\nDo this' } } })
    expect(session.snapshot().items.at(-1)).toMatchObject({ kind: 'plan', text: '# Plan\nDo this' })
    sdk.runs[0].finish(); await tick()
    session.send('Implement', [], { permissionMode: 'default' }); await tick()
    expect(sdk.sends[1].options.mode).toBe('agent')
    expect(session.snapshot().session.prePlanPermissionMode).toBeUndefined()
    session.close()
  })
  it('replays resumed history and retains only the newest items', async () => {
    const { session, sdk } = harness({ resume: 'old-agent' })
    sdk.history.mockResolvedValue(Array.from({ length: MAX_CHAT_ITEMS + 1 }, (_, i) => ({ type: 'agentConversationTurn', turn: { steps: [{ type: 'assistantMessage', message: { text: String(i) } }] } })))
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
    sdk.runs[0].finish('error', { message: 'Invalid User API Key' }); await tick()
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
    other.sdk.create.mockRejectedValue(new Error('disk failed'))
    await other.session.start()
    expect(other.session.snapshot().session).toMatchObject({ status: 'error', error: 'disk failed' })
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
