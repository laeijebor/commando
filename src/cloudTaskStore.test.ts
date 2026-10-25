// @vitest-environment jsdom
/// <reference types="node" />
import { webcrypto } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CloudCreateInput, CloudOperation, CloudProviderInfo, CloudTask, CloudTaskDetail } from '../shared/cloud-tasks'
import { CloudTasksHttpError, type CloudTasksApi } from './cloudTasksApi'
import { CLOUD_PENDING_STORAGE_KEY, CloudTaskStore, CloudTaskSubmissionRejectedError, cloudIntentDigest, cloudTaskStoreFor, digestCloudIntent, type CloudIntent } from './cloudTaskStore'

const provider: CloudProviderInfo = {
  id: 'codex', label: 'Codex', homeUrl: 'https://chatgpt.com/codex', readiness: 'ready', reason: 'Synthetic fixture',
  version: 'fixture', credentialContextId: 'ctx', verifiedAccountRef: null,
  capabilities: { create: true, link: true, list: true, inspect: true, sendMessage: false, diff: true, accountIdentity: false },
}
const input: CloudCreateInput = { provider: 'codex', credentialContextId: 'ctx', prompt: 'PRIVATE original prompt', source: { environmentId: 'env_fixture', branch: 'main' }, accountConfirmed: true }
function task(patch: Partial<CloudTask> = {}): CloudTask {
  return { id: 'local-task', provider: 'codex', credentialContextId: 'ctx', verifiedAccountRef: null,
    title: 'Synthetic task', prompt: input.prompt, source: input.source, providerTaskId: 'task_fixture',
    providerUrl: 'https://chatgpt.com/codex/tasks/task_fixture', identityEvidence: 'provider_receipt', deliveryState: 'accepted',
    remoteState: 'running', rawState: 'RUNNING', observationState: 'fresh', lastObservedAt: '2026-09-13T00:00:00Z',
    providerUpdatedAt: null, createdAt: '2026-09-13T00:00:00Z', updatedAt: '2026-09-13T00:00:00Z', revision: 1, archivedAt: null, issue: null, ...patch }
}
function operation(key: string, patch: Partial<CloudOperation> = {}): CloudOperation {
  return { id: 'op', taskId: 'local-task', kind: 'create', idempotencyKey: key, requestHash: 'server-digest', payload: input,
    state: 'accepted', ownerId: null, createdAt: '2026-09-13T00:00:00Z', updatedAt: '2026-09-13T00:00:00Z',
    receipt: { providerTaskId: 'task_fixture', providerUrl: 'https://chatgpt.com/codex/tasks/task_fixture', evidence: 'provider_receipt' }, issue: null, ...patch }
}
function apiFixture(): CloudTasksApi {
  const detail: CloudTaskDetail = { task: task(), operations: [] }
  return {
    providers: vi.fn().mockResolvedValue({ installationId: 'installation', providers: [provider] }),
    list: vi.fn().mockResolvedValue([]), get: vi.fn().mockResolvedValue(detail),
    create: vi.fn(async (_input, key) => ({ task: task(), operation: operation(key), reused: false })),
    link: vi.fn(async (_input, key) => ({ task: task({ identityEvidence: 'user_link' }), operation: operation(key, { kind: 'link' }), reused: false })),
    message: vi.fn(async (_id, _input, key) => ({ task: task(), operation: operation(key, { kind: 'message', state: 'delivery_unknown', receipt: null }), reused: false })),
    refresh: vi.fn().mockResolvedValue(detail), diff: vi.fn().mockResolvedValue({ text: '', truncated: false }),
    patch: vi.fn().mockResolvedValue(detail), operation: vi.fn(), byKey: vi.fn().mockResolvedValue(null),
    resumeOperation: vi.fn(async () => ({ task: task(), operation: operation('prepared', { state: 'dispatching' }), reused: true })),
  }
}
let cleanups: (() => void)[] = []
beforeEach(() => { localStorage.clear(); vi.stubGlobal('crypto', webcrypto) })
afterEach(() => { cleanups.forEach((fn) => fn()); cleanups = []; vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers() })

describe('shared cloud task store', () => {
  it('shares one foreground poll, pauses hidden, refreshes on focus/online, and retains stale data', async () => {
    vi.useFakeTimers()
    let visibility: DocumentVisibilityState = 'visible'
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility)
    const api = apiFixture()
    vi.mocked(api.list).mockResolvedValue([task()])
    const store = cloudTaskStoreFor(api)
    expect(cloudTaskStoreFor(api)).toBe(store)
    cleanups.push(store.subscribe(vi.fn()), store.subscribe(vi.fn()))
    await store.refresh()
    expect(api.list).toHaveBeenCalledTimes(1)
    expect(api.refresh).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(api.list).toHaveBeenCalledTimes(2)
    visibility = 'hidden'
    await vi.advanceTimersByTimeAsync(90_000)
    expect(api.list).toHaveBeenCalledTimes(2)
    visibility = 'visible'
    document.dispatchEvent(new Event('visibilitychange'))
    window.dispatchEvent(new Event('focus'))
    window.dispatchEvent(new Event('online'))
    await store.refresh()
    expect(api.list).toHaveBeenCalledTimes(3)
    vi.mocked(api.list).mockRejectedValue(new Error('offline'))
    await store.refresh()
    expect(store.getSnapshot()).toMatchObject({ connected: false, tasks: [expect.objectContaining({ id: 'local-task' })] })
    expect(store.getSnapshot().details['local-task'].task.prompt).toBe(input.prompt)
    const calls = vi.mocked(api.list).mock.calls.length
    await vi.advanceTimersByTimeAsync(30_000)
    expect(api.list).toHaveBeenCalledTimes(calls)
  })

  it('does not inspect receipt-only Claude or demand-load its prompt for HUD/list', async () => {
    const api = apiFixture()
    vi.mocked(api.providers).mockResolvedValue({ installationId: 'installation', providers: [{ ...provider, id: 'claude', capabilities: { ...provider.capabilities, inspect: false } }] })
    vi.mocked(api.list).mockResolvedValue([task({ provider: 'claude' })])
    const store = new CloudTaskStore(api)
    await store.refresh()
    expect(api.refresh).not.toHaveBeenCalled()
    expect(api.get).not.toHaveBeenCalled()
    cleanups.push(store.watch('local-task'))
    await store.loadDetail('local-task')
    expect(api.get).toHaveBeenCalledTimes(1)
  })

  it('keeps the daemon usable when only one provider observation fails', async () => {
    const api = apiFixture()
    vi.mocked(api.list).mockResolvedValue([task()])
    vi.mocked(api.refresh).mockRejectedValue(new Error('provider rate limit'))
    const store = new CloudTaskStore(api)
    await store.refresh()
    expect(store.getSnapshot()).toMatchObject({ connected: true, error: expect.stringContaining('last-known'), tasks: [expect.objectContaining({ id: 'local-task' })] })
    await store.patch('local-task', { title: 'Local edit still available' })
    expect(api.patch).toHaveBeenCalled()
  })

  it('persists only scoped key/digest BEFORE post and recovers a lost 202 after reload without replay', async () => {
    const api = apiFixture()
    const first = new CloudTaskStore(api)
    await first.refresh()
    let recordedKey = ''
    vi.mocked(api.create).mockImplementation(async (_input, key) => {
      recordedKey = key
      const index = JSON.parse(localStorage.getItem(CLOUD_PENDING_STORAGE_KEY)!)
      expect(index).toEqual([{ key, digest: expect.stringMatching(/^[a-f0-9]{64}$/), installationId: 'installation' }])
      expect(index[0].digest).toBe(await cloudIntentDigest({ kind: 'create', taskId: null, payload: input }))
      expect(JSON.stringify(index)).not.toContain('PRIVATE')
      throw new Error('Lost response after durable 202')
    })
    await expect(first.create(input)).rejects.toThrow('Delivery unknown')
    vi.mocked(api.byKey).mockImplementation(async (key) => operation(key))
    vi.mocked(api.get).mockResolvedValue({ task: task(), operations: [operation(recordedKey)] })
    const reloaded = new CloudTaskStore(api)
    await reloaded.refresh()
    expect(api.byKey).toHaveBeenCalledWith(recordedKey)
    expect(api.create).toHaveBeenCalledTimes(1)
    expect(reloaded.getSnapshot().details['local-task'].operations[0].state).toBe('accepted')
    expect(reloaded.getSnapshot().pending).toEqual([])
    expect(JSON.parse(localStorage.getItem(CLOUD_PENDING_STORAGE_KEY)!)).toEqual([])
  })

  it('clears a definitively rejected create and permits a corrected draft under a fresh key', async () => {
    const api = apiFixture()
    const store = new CloudTaskStore(api)
    await store.refresh()
    vi.mocked(api.create).mockRejectedValueOnce(new CloudTasksHttpError(400, 'invalid_request', 'Invalid prompt'))
    const rejected = store.create({ ...input, prompt: '日'.repeat(6_000) })
    await expect(rejected).rejects.toBeInstanceOf(CloudTaskSubmissionRejectedError)
    await expect(rejected).rejects.toThrow('Invalid prompt')
    const oldKey = vi.mocked(api.create).mock.calls[0][1]
    expect(store.getSnapshot().pending).toEqual([])
    expect(JSON.parse(localStorage.getItem(CLOUD_PENDING_STORAGE_KEY)!)).toEqual([])
    expect(store['memory'].has(oldKey)).toBe(false)
    await expect(store.retry(oldKey)).rejects.toThrow('Intent not found')
    await store.create(input)
    expect(api.create).toHaveBeenCalledTimes(2)
    expect(vi.mocked(api.create).mock.calls[1][1]).not.toBe(oldKey)
    expect(api.byKey).not.toHaveBeenCalled()
  })

  it.each([
    [400, 'invalid_request'], [413, 'invalid_request'], [415, 'invalid_request'], [401, ''], [403, ''],
  ] as const)('clears fresh create, link, and message intents after %s/%s', async (status, code) => {
    const api = apiFixture()
    const store = new CloudTaskStore(api)
    await store.refresh()
    const error = new CloudTasksHttpError(status, code, 'Daemon rejection')
    vi.mocked(api.create).mockRejectedValue(error)
    vi.mocked(api.link).mockRejectedValue(error)
    vi.mocked(api.message).mockRejectedValue(error)
    await expect(store.create(input)).rejects.toThrow('Daemon rejection')
    await expect(store.link({ provider: 'codex', credentialContextId: 'ctx', providerTaskId: 'task_fixture', accountConfirmed: true })).rejects.toThrow('Daemon rejection')
    await expect(store.message('local-task', { credentialContextId: 'ctx', message: 'Follow-up', accountConfirmed: true })).rejects.toThrow('Daemon rejection')
    expect(store.getSnapshot().pending).toEqual([])
    expect(JSON.parse(localStorage.getItem(CLOUD_PENDING_STORAGE_KEY)!)).toEqual([])
    expect(store['memory'].size).toBe(0)
  })

  it('clears a message to an unknown task but retains other task-not-found failures', async () => {
    const api = apiFixture()
    const store = new CloudTaskStore(api)
    await store.refresh()
    const error = new CloudTasksHttpError(404, 'task_not_found', 'Cloud task not found')
    vi.mocked(api.message).mockRejectedValue(error)
    await expect(store.message('missing', { credentialContextId: 'ctx', message: 'Follow-up', accountConfirmed: true })).rejects.toThrow('Cloud task not found')
    expect(store.getSnapshot().pending).toEqual([])
    expect(JSON.parse(localStorage.getItem(CLOUD_PENDING_STORAGE_KEY)!)).toEqual([])
    vi.mocked(api.create).mockRejectedValue(error)
    await expect(store.create(input)).rejects.toThrow('Delivery unknown')
    vi.mocked(api.link).mockRejectedValue(error)
    await expect(store.link({ provider: 'codex', credentialContextId: 'ctx', providerTaskId: 'task_fixture', accountConfirmed: true })).rejects.toThrow('Delivery unknown')
    expect(store.getSnapshot().pending).toHaveLength(2)
  })

  it.each([
    new Error('network'), new Error('timeout'),
    new CloudTasksHttpError(500, 'internal_error', 'Server failure'),
    new CloudTasksHttpError(503, 'invalid_request', 'Server failure'),
    new CloudTasksHttpError(409, 'idempotency_conflict', 'Conflicting intent'),
    new CloudTasksHttpError(409, 'capability_unavailable', 'Unavailable'),
    new CloudTasksHttpError(429, 'rate_limited', 'Busy'),
    new CloudTasksHttpError(400, 'invalid_intent', 'Invalid intent'),
    new CloudTasksHttpError(401, 'auth_required', 'Provider auth failed'),
    new CloudTasksHttpError(403, 'denied', 'Provider denied'),
    new CloudTasksHttpError(404, 'operation_not_found', 'Missing operation'),
  ])('retains unknown delivery and the frozen payload for $message ($status/$code)', async (error) => {
    const api = apiFixture()
    const store = new CloudTaskStore(api)
    await store.refresh()
    vi.mocked(api.create).mockRejectedValue(error)
    await expect(store.create(input)).rejects.toThrow('Delivery unknown')
    expect(store.getSnapshot().pending).toEqual([expect.objectContaining({ status: 'unknown', retryable: true })])
    const key = store.getSnapshot().pending[0].key
    expect(JSON.parse(localStorage.getItem(CLOUD_PENDING_STORAGE_KEY)!)).toEqual([expect.objectContaining({ key })])
    expect(store['memory'].get(key)?.input).toEqual(input)
  })

  it.each([400, 401, 403])('does not let a later %s rejection erase an earlier uncertain attempt', async (status) => {
    const api = apiFixture()
    const store = new CloudTaskStore(api)
    await store.refresh()
    vi.mocked(api.create).mockRejectedValueOnce(new Error('Lost response'))
      .mockRejectedValueOnce(new CloudTasksHttpError(status, status === 400 ? 'invalid_request' : '', 'Rejected retry'))
    await expect(store.create(input)).rejects.toThrow('Delivery unknown')
    const key = store.getSnapshot().pending[0].key
    await expect(store.retry(key)).rejects.toThrow('Delivery unknown')
    expect(store.getSnapshot().pending).toEqual([expect.objectContaining({ key, status: 'unknown', retryable: true })])
    expect(store['memory'].has(key)).toBe(true)
    expect(JSON.parse(localStorage.getItem(CLOUD_PENDING_STORAGE_KEY)!)).toHaveLength(1)
  })

  it('retains unknown delivery after a malformed receipt', async () => {
    const api = apiFixture()
    const store = new CloudTaskStore(api)
    await store.refresh()
    vi.mocked(api.create).mockImplementationOnce(async () => ({ task: task(), operation: operation('wrong-key'), reused: false }))
    await expect(store.create(input)).rejects.toThrow('Delivery unknown')
    expect(store.getSnapshot().pending[0]).toMatchObject({ status: 'unknown', retryable: true })
  })

  it('retains the old installation index even for a definitive rejection after an installation change', async () => {
    const api = apiFixture()
    const store = new CloudTaskStore(api)
    await store.refresh()
    let reject!: (error: Error) => void
    vi.mocked(api.create).mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail }))
    const sending = store.create(input)
    const failure = expect(sending).rejects.toThrow('Delivery unknown')
    await vi.waitFor(() => expect(api.create).toHaveBeenCalledOnce())
    vi.mocked(api.providers).mockResolvedValue({ installationId: 'replacement', providers: [provider] })
    await store.refresh()
    reject(new CloudTasksHttpError(400, 'invalid_request', 'Invalid prompt'))
    await failure
    expect(JSON.parse(localStorage.getItem(CLOUD_PENDING_STORAGE_KEY)!)).toEqual([expect.objectContaining({ installationId: 'installation' })])
  })

  it('freezes inputs and coalesces explicit transport retry with the same key after recovery lookup', async () => {
    const api = apiFixture()
    const store = new CloudTaskStore(api)
    await store.refresh()
    vi.mocked(api.create).mockRejectedValueOnce(new Error('network'))
    const draft = { ...input, source: { ...input.source } }
    await expect(store.create(draft)).rejects.toThrow('Delivery unknown')
    const key = store.getSnapshot().pending[0].key
    draft.prompt = 'changed text'; draft.source.branch = 'changed branch'
    const retry = store.retry(key)
    expect(store.retry(key)).toBe(retry)
    await retry
    expect(api.byKey).toHaveBeenCalledWith(key)
    expect(api.create).toHaveBeenNthCalledWith(2, input, key)
    expect(store.getSnapshot().pending).toEqual([])
  })

  it('never replays a missing draft after reload or after failed lookup', async () => {
    const api = apiFixture()
    localStorage.setItem(CLOUD_PENDING_STORAGE_KEY, JSON.stringify([{ key: 'lost', digest: 'digest', installationId: 'installation' }]))
    const store = new CloudTaskStore(api)
    await store.refresh()
    expect(store.getSnapshot().pending[0]).toMatchObject({ status: 'unknown', retryable: false })
    await expect(store.retry('lost')).rejects.toThrow('Unknown draft')
    vi.mocked(api.byKey).mockRejectedValue(new Error('offline'))
    await expect(store.retry('lost')).rejects.toThrow('offline')
    expect(api.create).not.toHaveBeenCalled()
    expect(JSON.parse(localStorage.getItem(CLOUD_PENDING_STORAGE_KEY)!)).toHaveLength(1)
  })

  it('blocks a transport retry if the installation changes during recovery', async () => {
    const api = apiFixture()
    const store = new CloudTaskStore(api)
    await store.refresh()
    vi.mocked(api.create).mockRejectedValueOnce(new Error('lost response'))
    await expect(store.create(input)).rejects.toThrow('Delivery unknown')
    const key = store.getSnapshot().pending[0].key
    let resolveLookup!: (operation: CloudOperation | null) => void
    vi.mocked(api.byKey).mockImplementationOnce(() => new Promise((resolve) => { resolveLookup = resolve }))
    const retry = store.retry(key)
    const failure = expect(retry).rejects.toThrow('Installation changed')
    vi.mocked(api.providers).mockResolvedValue({ installationId: 'replacement', providers: [provider] })
    await store.refresh()
    resolveLookup(null)
    await failure
    expect(api.create).toHaveBeenCalledTimes(1)
    expect(store.getSnapshot().pending).toEqual([])
    expect(JSON.parse(localStorage.getItem(CLOUD_PENDING_STORAGE_KEY)!)[0].installationId).toBe('installation')
  })

  it('retains a prepared recovered intent without dispatch and scopes out another installation', async () => {
    const api = apiFixture()
    localStorage.setItem(CLOUD_PENDING_STORAGE_KEY, JSON.stringify([
      { key: 'prepared', digest: 'a', installationId: 'installation' }, { key: 'other', digest: 'b', installationId: 'other-installation' },
    ]))
    vi.mocked(api.byKey).mockResolvedValue(operation('prepared', { state: 'prepared', receipt: null }))
    const store = new CloudTaskStore(api)
    await store.refresh()
    expect(api.byKey).toHaveBeenCalledTimes(1)
    expect(api.byKey).toHaveBeenCalledWith('prepared')
    await store.retry('prepared')
    expect(api.create).not.toHaveBeenCalled()
    expect(store.getSnapshot().pending[0]).toMatchObject({ retryable: false, operation: { state: 'prepared' } })
  })

  it('keeps message uncertainty independent of an accepted create and later identity link', async () => {
    const api = apiFixture()
    const store = new CloudTaskStore(api)
    await store.refresh()
    vi.mocked(api.message).mockImplementation(async (_id, payload, key) => ({ task: task(), operation: operation(key, { id: 'message-op', kind: 'message', payload, state: 'delivery_unknown', receipt: null }), reused: false }))
    await store.create(input)
    await store.message('local-task', { credentialContextId: 'ctx', message: 'PRIVATE follow-up', accountConfirmed: true })
    await store.link({ provider: 'codex', credentialContextId: 'ctx', providerTaskId: 'task_fixture', accountConfirmed: true }, 'local-task')
    const snapshot = store.getSnapshot()
    expect(snapshot.details['local-task'].operations.find((op) => op.id === 'message-op')?.state).toBe('delivery_unknown')
    expect(snapshot.pending).toEqual([expect.objectContaining({ operation: expect.objectContaining({ kind: 'message', state: 'delivery_unknown' }) })])
    expect(localStorage.getItem(CLOUD_PENDING_STORAGE_KEY)).not.toContain('follow-up')
  })

  it('fails closed before post if storage cannot persist or is corrupt', async () => {
    const api = apiFixture()
    const storage = { getItem: () => null, setItem: () => { throw new Error('quota') } } as unknown as Storage
    const store = new CloudTaskStore(api, storage)
    await store.refresh()
    await expect(store.create(input)).rejects.toThrow('quota')
    expect(api.create).not.toHaveBeenCalled()
    localStorage.setItem(CLOUD_PENDING_STORAGE_KEY, '{bad')
    const corrupt = new CloudTaskStore(api)
    await corrupt.refresh()
    await expect(corrupt.create(input)).rejects.toThrow()
    expect(api.create).not.toHaveBeenCalled()
  })

  it('uses canonical digest ordering and distinguishes changed payload or destination', async () => {
    expect(await cloudIntentDigest({ b: 2, a: 1 })).toBe(await cloudIntentDigest({ a: 1, b: 2 }))
    expect(await cloudIntentDigest({ taskId: 'one', input })).not.toBe(await cloudIntentDigest({ taskId: 'two', input }))
  })

  it('drains all 18 eligible tasks fairly and limits simultaneous detail/refresh reads to four globally', async () => {
    const api = apiFixture()
    const tasks = Array.from({ length: 18 }, (_, n) => task({ id: `local-${n}`, providerTaskId: `task_${n}` }))
    vi.mocked(api.list).mockResolvedValue(tasks)
    let active = 0
    let maximum = 0
    vi.mocked(api.refresh).mockImplementation(async (id) => {
      active++; maximum = Math.max(maximum, active)
      if (active > 4) throw new Error('provider queue full')
      await Promise.resolve(); await Promise.resolve()
      active--
      return { task: tasks.find((task) => task.id === id)!, operations: [] }
    })
    const store = new CloudTaskStore(api)
    await store.refresh()
    expect(vi.mocked(api.refresh).mock.calls.map(([id]) => id)).toEqual(tasks.map((task) => task.id))
    expect(maximum).toBe(1)
    await Promise.all(tasks.map((task) => store.loadDetail(task.id, true)))
    expect(api.refresh).toHaveBeenCalledTimes(36)
    expect(maximum).toBeLessThanOrEqual(4)
    expect(store.getSnapshot().error).toBe('')
  })

  it('uses each task connection tuple for polling and never substitutes another Claude profile', async () => {
    const api = apiFixture()
    const team = { ...provider, id: 'claude' as const, credentialContextId: 'claude:team', capabilities: { ...provider.capabilities, inspect: false } }
    const max = { ...team, credentialContextId: 'claude:max', capabilities: { ...team.capabilities, inspect: true } }
    const tasks = [team, max, { ...team, credentialContextId: 'legacy-context' }].map((info) => task({ id: info.credentialContextId, provider: 'claude', credentialContextId: info.credentialContextId }))
    vi.mocked(api.providers).mockResolvedValue({ installationId: 'installation', providers: [team, max] })
    vi.mocked(api.list).mockResolvedValue(tasks)
    vi.mocked(api.refresh).mockImplementation(async (id) => ({ task: tasks.find((task) => task.id === id)!, operations: [] }))
    const store = new CloudTaskStore(api)
    await store.refresh()
    expect(api.refresh).toHaveBeenCalledTimes(1)
    expect(api.refresh).toHaveBeenCalledWith('claude:max')
    vi.mocked(api.providers).mockResolvedValue({ installationId: 'installation', providers: [max, team] })
    await store.refresh()
    expect(api.refresh).toHaveBeenCalledTimes(2)
    vi.mocked(api.providers).mockResolvedValue({ installationId: 'installation', providers: [team] })
    await store.refresh()
    expect(api.refresh).toHaveBeenCalledTimes(2)
    expect(store.getSnapshot().tasks).toHaveLength(3)
  })

  it.each(['error', 'stale', 'auth_required'] as const)('backs off HTTP-200 %s observations without treating the daemon as disconnected', async (observationState) => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const api = apiFixture()
    vi.mocked(api.list).mockResolvedValue([task()])
    vi.mocked(api.refresh).mockResolvedValue({ task: task({ observationState, issue: { code: 'read_failed', message: 'Observation unavailable' } }), operations: [] })
    const store = new CloudTaskStore(api)
    cleanups.push(store.subscribe(vi.fn()))
    await store.refresh()
    expect(store.getSnapshot()).toMatchObject({ connected: true, error: expect.stringContaining('could not be refreshed') })
    await vi.advanceTimersByTimeAsync(30_000)
    expect(api.refresh).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(api.refresh).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(119_999)
    expect(api.refresh).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(api.refresh).toHaveBeenCalledTimes(3)
  })

  const reentries: CloudIntent[] = [
    { kind: 'create', input },
    { kind: 'link', taskId: 'local-task', input: { provider: 'codex', credentialContextId: 'ctx', providerTaskId: 'task_fixture', accountConfirmed: true } },
    { kind: 'message', taskId: 'local-task', input: { credentialContextId: 'ctx', message: 'Original follow-up', accountConfirmed: true } },
  ]
  it.each(reentries)('persists and dispatches $kind without randomUUID or subtle, matching the secure digest', async (intent) => {
    const digest = vi.spyOn(webcrypto.subtle, 'digest')
    const secureDigest = await digestCloudIntent(intent)
    expect(digest).toHaveBeenCalledOnce()
    const getRandomValues = vi.fn(webcrypto.getRandomValues.bind(webcrypto))
    vi.stubGlobal('crypto', { getRandomValues })
    const api = apiFixture()
    const store = new CloudTaskStore(api)
    await store.refresh()
    const capture = (key: string) => {
      expect(JSON.parse(localStorage.getItem(CLOUD_PENDING_STORAGE_KEY)!)).toEqual([
        { key, digest: secureDigest, installationId: 'installation' },
      ])
      return { task: task(), operation: operation(key, { kind: intent.kind, state: 'prepared', receipt: null }), reused: false }
    }
    vi.mocked(api.create).mockImplementation(async (_input, key) => capture(key))
    vi.mocked(api.link).mockImplementation(async (_input, key) => capture(key))
    vi.mocked(api.message).mockImplementation(async (_id, _input, key) => capture(key))
    const action = await (intent.kind === 'create' ? store.create(intent.input)
      : intent.kind === 'link' ? store.link(intent.input, intent.taskId)
        : store.message(intent.taskId, intent.input))
    const key = action.operation.idempotencyKey
    expect(key).toMatch(/^[a-f0-9]{32}$/)
    expect(getRandomValues).toHaveBeenCalledOnce()
    expect(digest).toHaveBeenCalledOnce()
    expect(store.getSnapshot().pending).toEqual([
      expect.objectContaining({ key, digest: secureDigest, status: 'recorded' }),
    ])
    if (intent.kind === 'create') expect(api.create).toHaveBeenCalledWith(intent.input, key)
    if (intent.kind === 'link') expect(api.link).toHaveBeenCalledWith(intent.input, key, intent.taskId)
    if (intent.kind === 'message') expect(api.message).toHaveBeenCalledWith(intent.taskId, intent.input, key)
  })

  it.each(reentries)('re-enters a reloaded $kind with the same key only after digest, kind, target, and confirmation match', async (intent) => {
    const api = apiFixture()
    localStorage.setItem(CLOUD_PENDING_STORAGE_KEY, JSON.stringify([{ key: 'reload-key', digest: await digestCloudIntent(intent), installationId: 'installation' }]))
    const store = new CloudTaskStore(api)
    await store.refresh()
    expect(api.create).not.toHaveBeenCalled(); expect(api.link).not.toHaveBeenCalled(); expect(api.message).not.toHaveBeenCalled()
    await expect(store.reenter('reload-key', { ...intent, input: { ...intent.input, accountConfirmed: false } } as CloudIntent)).rejects.toThrow('confirmation')
    await store.reenter('reload-key', intent)
    if (intent.kind === 'create') expect(api.create).toHaveBeenCalledWith(intent.input, 'reload-key')
    if (intent.kind === 'link') expect(api.link).toHaveBeenCalledWith(intent.input, 'reload-key', intent.taskId)
    if (intent.kind === 'message') expect(api.message).toHaveBeenCalledWith(intent.taskId, intent.input, 'reload-key')
  })

  it('requires explicit new-intent acknowledgement for mismatched draft/target and never changes the old key silently', async () => {
    const api = apiFixture()
    const original: CloudIntent = { kind: 'message', taskId: 'original-task', input: { credentialContextId: 'ctx', message: 'Original', accountConfirmed: true } }
    const changed: CloudIntent = { ...original, taskId: 'different-task' }
    localStorage.setItem(CLOUD_PENDING_STORAGE_KEY, JSON.stringify([{ key: 'original-key', digest: await digestCloudIntent(original), installationId: 'installation' }]))
    const store = new CloudTaskStore(api)
    await store.refresh()
    await expect(store.reenter('original-key', changed)).rejects.toThrow('does not match')
    expect(api.message).not.toHaveBeenCalled()
    await store.reenter('original-key', changed, true)
    expect(api.message).toHaveBeenCalledTimes(1)
    expect(vi.mocked(api.message).mock.calls[0][2]).not.toBe('original-key')
    expect(store.getSnapshot().pending.some((entry) => entry.key === 'original-key')).toBe(true)
  })

  it('recovers an operation that appears during re-entry rather than dispatching the re-entered draft', async () => {
    const api = apiFixture()
    const intent: CloudIntent = { kind: 'create', input }
    localStorage.setItem(CLOUD_PENDING_STORAGE_KEY, JSON.stringify([{ key: 'late-key', digest: await digestCloudIntent(intent), installationId: 'installation' }]))
    const store = new CloudTaskStore(api)
    await store.refresh()
    vi.mocked(api.byKey).mockResolvedValue(operation('late-key', { state: 'delivery_unknown' }))
    await store.reenter('late-key', intent)
    expect(api.create).not.toHaveBeenCalled()
    expect(store.getSnapshot().pending[0].operation?.state).toBe('delivery_unknown')
  })

  it('resumes only prepared operations after explicit confirmation and authoritative state/context recheck', async () => {
    const api = apiFixture()
    const store = new CloudTaskStore(api)
    await store.refresh()
    vi.mocked(api.operation).mockResolvedValue(operation('prepared', { state: 'prepared' }))
    await expect(store.resumeOperation('op', { credentialContextId: 'ctx', accountConfirmed: false })).rejects.toThrow('Confirm')
    await expect(store.resumeOperation('op', { credentialContextId: 'different', accountConfirmed: true })).rejects.toThrow('Credential context changed')
    const first = store.resumeOperation('op', { credentialContextId: 'ctx', accountConfirmed: true })
    expect(store.resumeOperation('op', { credentialContextId: 'ctx', accountConfirmed: true })).toBe(first)
    await first
    expect(api.resumeOperation).toHaveBeenCalledTimes(1)
    expect(api.resumeOperation).toHaveBeenCalledWith('op', { credentialContextId: 'ctx', accountConfirmed: true })
  })

  it.each(['delivery_unknown', 'accepted', 'dispatching', 'rejected'] as const)('never resumes an authoritative %s operation', async (state) => {
    const api = apiFixture()
    const store = new CloudTaskStore(api)
    await store.refresh()
    vi.mocked(api.operation).mockResolvedValue(operation('key', { state }))
    await expect(store.resumeOperation('op', { credentialContextId: 'ctx', accountConfirmed: true })).rejects.toThrow('Only a prepared operation')
    expect(api.resumeOperation).not.toHaveBeenCalled()
  })
})
