import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CLOUD_DIFF_BYTE_LIMIT, CLOUD_DIFF_LINE_LIMIT, cloudConnectionKey, cloudTaskUrl, type CloudCreateInput } from '../shared/cloud-tasks.js'
import { CloudTaskError, type CloudDispatchResult, type CloudInspection } from './cloud-provider.js'
import { CloudTaskService } from './cloud-task-service.js'
import { FakeCloudRepository, deferred, fakeProvider } from './cloud-test-fixtures/fakes.js'
import { CloudTaskStore } from './cloud-task-store.js'
import { CodexCloudAdapter } from './cloud-providers/codex-cli.js'
import { runCloudCli } from './cloud-cli-runner.js'
import type { CloudTaskRepository } from './cloud-task-repository.js'

const services: CloudTaskService[] = []
const databases: CloudTaskStore[] = []
const directories: string[] = []
const confirmation = { credentialContextId: 'fixture-context', accountConfirmed: true }
const input: CloudCreateInput = { provider: 'codex', prompt: 'Synthetic task', source: { environmentId: 'env_fixture', branch: 'main' }, ...confirmation }
function setup(now?: () => number, repository?: FakeCloudRepository) {
  const store = repository ?? new FakeCloudRepository(now)
  const provider = fakeProvider()
  const service = new CloudTaskService({ store, providers: [provider.adapter], now })
  services.push(service)
  return { service, store, ...provider }
}
async function turn() { await new Promise<void>((resolve) => setImmediate(resolve)) }
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.stop()))
  for (const store of databases.splice(0)) store.close()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
  vi.useRealTimers()
  vi.unstubAllEnvs()
})

describe('durable cloud orchestration', () => {
  it('records before dispatch, claims after heartbeat, and concurrent/lost responses dispatch once', async () => {
    const { service, store, adapter } = setup()
    adapter.create.mockImplementation(async () => {
      expect(store.events).toContain('prepare')
      expect(store.events.slice(-3)).toEqual(['heartbeat', 'claim', 'heartbeat'])
      expect([...store.operations.values()][0].state).toBe('dispatching')
      return { state: 'accepted', receipt: { providerTaskId: 'task_synthetic', providerUrl: cloudTaskUrl('codex', 'task_synthetic'), evidence: 'provider_receipt' } }
    })
    const [first, second] = await Promise.all([service.createTask(input, 'key_one'), service.createTask(input, 'key_one')])
    expect(first.operation.state).toBe('prepared')
    expect(second.reused).toBe(true)
    expect(adapter.create).not.toHaveBeenCalled()
    await turn()
    expect(adapter.create).toHaveBeenCalledTimes(1)
    expect(service.getOperationByKey('key_one').state).toBe('accepted')
    expect(service.listTasks()[0]).not.toHaveProperty('prompt')
  })

  it('resolves duplicate keys before changed capability/context probing and rejects cross-route reuse', async () => {
    const { service, adapter, info } = setup()
    const first = await service.createTask(input, 'key_one')
    await turn()
    info.capabilities.create = false
    info.credentialContextId = 'changed'
    adapter.info.mockClear()
    expect((await service.createTask(input, 'key_one')).reused).toBe(true)
    expect(adapter.info).not.toHaveBeenCalled()
    await expect(service.createTask({ ...input, prompt: 'changed' }, 'key_one')).rejects.toMatchObject({ status: 409 })
    await expect(service.sendMessage(first.task.id, { message: 'follow-up', ...confirmation }, 'key_one')).rejects.toMatchObject({ code: 'idempotency_conflict' })
    await expect(service.linkTask({ provider: 'codex', providerTaskId: 'task_synthetic', ...confirmation }, 'key_one')).rejects.toMatchObject({ code: 'idempotency_conflict' })
  })

  it('binds message keys to their target task', async () => {
    const { service } = setup()
    const one = await service.linkTask({ provider: 'codex', providerTaskId: 'task_one', ...confirmation }, 'one')
    const two = await service.linkTask({ provider: 'codex', providerTaskId: 'task_two', ...confirmation }, 'two')
    await turn()
    const message = { message: 'same text', ...confirmation }
    await service.sendMessage(one.task.id, message, 'message')
    await expect(service.sendMessage(two.task.id, message, 'message')).rejects.toMatchObject({ code: 'idempotency_conflict' })
  })

  it('rejects stale draft contexts before creating or linking any durable intent', async () => {
    const { service, info, store, adapter } = setup()
    info.credentialContextId = 'replacement-context'
    await expect(service.createTask(input, 'stale-create')).rejects.toMatchObject({ code: 'context_mismatch', status: 409 })
    await expect(service.linkTask({ provider: 'codex', providerTaskId: 'task_external', ...confirmation }, 'stale-link')).rejects.toMatchObject({ code: 'context_mismatch', status: 409 })
    expect(store.tasks.size).toBe(0)
    expect(store.operations.size).toBe(0)
    expect(adapter.create).not.toHaveBeenCalled()
  })

  it('rejects unbound inputs and binds the context into the immutable request hash', async () => {
    const { service, adapter, store } = setup()
    await expect(service.createTask({ ...input, credentialContextId: undefined }, 'missing')).rejects.toMatchObject({ code: 'invalid_request' })
    await expect(service.linkTask({ provider: 'codex', providerTaskId: 'task_external', accountConfirmed: true }, 'missing-link')).rejects.toMatchObject({ code: 'invalid_request' })
    expect(adapter.info).not.toHaveBeenCalled()
    const action = await service.createTask(input, 'bound')
    await turn()
    adapter.info.mockClear()
    await expect(service.createTask({ ...input, credentialContextId: 'other-context' }, 'bound')).rejects.toMatchObject({ code: 'idempotency_conflict' })
    await expect(service.sendMessage(action.task.id, { message: 'unbound', accountConfirmed: true }, 'unbound-message')).rejects.toMatchObject({ code: 'invalid_request' })
    await expect(service.sendMessage(action.task.id, { message: 'wrong context', ...confirmation, credentialContextId: 'other-context' }, 'wrong-message')).rejects.toMatchObject({ code: 'context_mismatch' })
    expect(adapter.info).not.toHaveBeenCalled()
    expect(store.operations.size).toBe(1)
    expect(service.getOperation(action.operation.id).payload.credentialContextId).toBe(input.credentialContextId)
  })

  it.each(['context', 'account', 'capability'] as const)('revalidates %s after recording and before mutation', async (change) => {
    const { service, info, adapter } = setup()
    const action = await service.createTask(input, 'key_one')
    if (change === 'context') info.credentialContextId = 'changed-context'
    if (change === 'account') info.verifiedAccountRef = 'changed-account'
    if (change === 'capability') info.capabilities.create = false
    await turn()
    expect(adapter.create).not.toHaveBeenCalled()
    expect(service.getOperation(action.operation.id).state).toBe('rejected')
  })

  it('requires explicit unknown-account confirmation, but local archiving needs no provider', async () => {
    const { service, info, adapter } = setup()
    info.verifiedAccountRef = null
    info.capabilities.accountIdentity = false
    await expect(service.createTask({ ...input, accountConfirmed: false }, 'no_confirmation')).rejects.toMatchObject({ code: 'account_confirmation_required' })
    const action = await service.createTask(input, 'confirmed')
    await turn()
    await expect(service.sendMessage(action.task.id, { message: 'next', ...confirmation, accountConfirmed: false }, 'message')).rejects.toMatchObject({ code: 'account_confirmation_required' })
    adapter.info.mockRejectedValue(new Error('secret stderr'))
    expect(service.updateTask(action.task.id, { archived: true }).task.archivedAt).not.toBeNull()
    expect(service.listTasks(false)).toHaveLength(0)
    expect(service.listTasks(true)).toHaveLength(1)
    expect(service.updateTask(action.task.id, { archived: false, title: 'Renamed' }).task.title).toBe('Renamed')
  })

  it('rejects forged provider info and ignores arbitrary exception text', async () => {
    const { service, adapter, info } = setup()
    adapter.info.mockResolvedValue({ ...info, id: 'claude' })
    await expect(service.createTask(input, 'forged')).rejects.toMatchObject({ code: 'provider_unavailable' })
    adapter.info.mockRejectedValue(new Error('TOKEN=private-secret'))
    expect(JSON.stringify(await service.listProviders())).not.toContain('private-secret')
  })

  it('explains Claude creation source policy independently of verified follow-up capability', async () => {
    const { adapter, info } = fakeProvider('claude')
    info.capabilities.create = false
    info.verifiedAccountRef = null
    info.reason = 'raw diagnostic TOKEN=private-secret'
    const service = new CloudTaskService({ store: new FakeCloudRepository(), providers: [adapter] })
    services.push(service)
    const provider = (await service.listProviders()).providers[0]
    expect(provider.reason).toContain('no verified enforceable no-bundle source-selection path')
    expect(provider.reason).toContain('Cloud follow-up is enabled')
    expect(provider.reason).toContain('Account identity is unverified')
    expect(provider.reason).not.toContain('private-secret')
    expect(provider.capabilities).toMatchObject({ create: false, sendMessage: true })
  })

  it.each([
    { providerTaskId: 'task_one', providerUrl: 'https://evil.test/codex/tasks/task_one', evidence: 'provider_receipt' },
    { providerTaskId: 'task_one', providerUrl: cloudTaskUrl('codex', 'task_two'), evidence: 'provider_receipt' },
    { providerTaskId: 'task_one', providerUrl: `${cloudTaskUrl('codex', 'task_one')}?token=secret`, evidence: 'provider_receipt' },
    { providerTaskId: 'session_other_provider', providerUrl: cloudTaskUrl('claude', 'session_other_provider'), evidence: 'provider_receipt' },
    { providerTaskId: 'task_one', providerUrl: cloudTaskUrl('codex', 'task_one'), evidence: 'user_link' },
  ])('rejects unsafe/mismatched synthetic receipts %#', async (receipt) => {
    const { service, adapter } = setup()
    adapter.create.mockResolvedValue({ state: 'accepted', receipt } as CloudDispatchResult)
    const action = await service.createTask(input, 'key_one')
    await turn()
    expect(service.getOperation(action.operation.id)).toMatchObject({ state: 'delivery_unknown', issue: { code: 'invalid_receipt' } })
    expect(service.getTask(action.task.id).task.providerUrl).toBeNull()
  })

  it('matches follow-up receipts to the saved identity', async () => {
    const { service, adapter, receipt } = setup()
    const task = await service.createTask(input, 'create')
    await turn()
    adapter.sendMessage.mockResolvedValue(receipt('task_wrong'))
    const message = await service.sendMessage(task.task.id, { message: 'next', ...confirmation }, 'message')
    await turn()
    expect(service.getOperation(message.operation.id).state).toBe('delivery_unknown')
    expect(service.getTask(task.task.id).task.providerTaskId).toBe('task_synthetic')
    await expect(service.linkTask({ provider: 'codex', providerTaskId: 'task_synthetic', ...confirmation }, 'recovery', task.task.id)).rejects.toMatchObject({ code: 'invalid_recovery' })
    expect(service.getOperation(message.operation.id).state).toBe('delivery_unknown')
  })

  it('gives a known receipt precedence over a subsequent adapter diagnostic', async () => {
    const { service, adapter, receipt } = setup()
    adapter.create.mockResolvedValue({ ...receipt(), issue: { code: 'process_exit', message: 'raw output secret' } } as CloudDispatchResult)
    const action = await service.createTask(input, 'create')
    await turn()
    expect(service.getOperation(action.operation.id)).toMatchObject({ state: 'accepted', issue: null })
    expect(JSON.stringify(service.getTask(action.task.id))).not.toContain('raw output')
  })

  it('does not downgrade acceptance when persistence reports an error after committing', async () => {
    const { service, store } = setup()
    const finish = store.finishOperation.bind(store)
    vi.spyOn(store, 'finishOperation').mockImplementation((id, result) => {
      const action = finish(id, result)
      if (result.state === 'accepted') throw new Error('after commit failure')
      return action
    })
    const action = await service.createTask(input, 'create')
    await turn()
    expect(service.getOperation(action.operation.id).state).toBe('accepted')
  })

  it('retries known receipt persistence after a pre-commit failure instead of discarding acceptance evidence', async () => {
    const { service, store } = setup()
    const finish = store.finishOperation.bind(store)
    vi.spyOn(store, 'finishOperation').mockImplementationOnce(() => { throw new Error('transient transaction failure') }).mockImplementation(finish)
    const action = await service.createTask(input, 'create')
    await turn()
    expect(service.getOperation(action.operation.id).state).toBe('accepted')
    expect(store.events).not.toContain('finish:delivery_unknown')
  })

  it('cannot start the CLI if its operation was abandoned during readiness revalidation', async () => {
    let now = 1_000
    const { service, adapter, info, store } = setup(() => now)
    const probe = deferred<typeof info>()
    adapter.info.mockResolvedValueOnce(info).mockReturnValueOnce(probe.promise)
    const action = await service.createTask(input, 'create')
    await turn()
    now += 31_000
    store.recoverAbandoned(30_000)
    probe.resolve(info)
    await turn()
    expect(adapter.create).not.toHaveBeenCalled()
    expect(service.getOperation(action.operation.id).state).toBe('delivery_unknown')
  })

  it('retains a sanitized unknown result after dispatch throws and never replays it', async () => {
    const { service, adapter } = setup()
    adapter.create.mockRejectedValue(new Error('stderr with credentials'))
    const action = await service.createTask(input, 'key_one')
    await turn()
    expect(service.getOperation(action.operation.id)).toMatchObject({ state: 'delivery_unknown', issue: { code: 'delivery_unknown' } })
    expect(JSON.stringify(service.getTask(action.task.id))).not.toContain('credentials')
    expect((await service.createTask(input, 'key_one')).reused).toBe(true)
    await turn()
    expect(adapter.create).toHaveBeenCalledTimes(1)
  })

  it('never starts a provider when durable prepare fails', async () => {
    const { service, store, adapter } = setup()
    vi.spyOn(store, 'prepare').mockImplementation(() => { throw new Error('database unavailable') })
    await expect(service.createTask(input, 'failed_record')).rejects.toThrow('database unavailable')
    await turn()
    expect(adapter.create).not.toHaveBeenCalled()
    expect(store.operations.size).toBe(0)
  })

  it('times out a dispatch, aborts only its local signal, and still reconciles a late receipt', async () => {
    vi.useFakeTimers()
    const { service, adapter, receipt } = setup()
    const pending = deferred<CloudDispatchResult>()
    adapter.create.mockReturnValue(pending.promise)
    const action = await service.createTask(input, 'slow')
    await vi.advanceTimersByTimeAsync(0)
    expect(adapter.create).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(120_001)
    expect(adapter.create.mock.calls[0][1]?.aborted).toBe(true)
    expect(service.getOperation(action.operation.id).state).toBe('delivery_unknown')
    expect((await service.createTask(input, 'slow')).reused).toBe(true)
    expect(adapter.create).toHaveBeenCalledTimes(1)
    pending.resolve(receipt())
    await vi.advanceTimersByTimeAsync(0)
    expect(service.getOperation(action.operation.id).state).toBe('accepted')
  })

  it('bounds observer lifetime and performs no catch-up reads while clients sleep', async () => {
    vi.useFakeTimers()
    const { service, adapter } = setup()
    const action = await service.createTask(input, 'create')
    await vi.advanceTimersByTimeAsync(0)
    const pending = deferred<CloudInspection>()
    adapter.inspect.mockReturnValue(pending.promise)
    const refresh = service.refreshTask(action.task.id)
    await vi.advanceTimersByTimeAsync(20_001)
    expect((await refresh).task.observationState).toBe('error')
    expect(adapter.inspect.mock.calls[0][1]?.aborted).toBe(true)
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(adapter.inspect).toHaveBeenCalledTimes(1)
    pending.resolve({ remoteState: 'result_ready', rawState: 'ready' })
    await vi.advanceTimersByTimeAsync(0)
    expect(service.getTask(action.task.id).task.remoteState).toBe('unknown')
  })

  it('does not recover another live owner; restart never replays a prepared intent', async () => {
    const { service, store, adapter } = setup()
    const pending = deferred<CloudDispatchResult>()
    adapter.create.mockReturnValue(pending.promise)
    const active = await service.createTask(input, 'active')
    await turn()
    const second = setup(undefined, store)
    expect(second.service.getOperation(active.operation.id).state).toBe('dispatching')
    expect(second.adapter.create).not.toHaveBeenCalled()
    const prepared = await second.service.createTask(input, 'prepared')
    await second.service.stop()
    const third = setup(undefined, store)
    await turn()
    expect(third.service.getOperation(prepared.operation.id).state).toBe('prepared')
    expect((await third.service.createTask(input, 'prepared')).reused).toBe(true)
    expect(third.adapter.create).not.toHaveBeenCalled()
    await service.stop()
    pending.resolve({ state: 'delivery_unknown', issue: { code: 'unknown', message: 'unknown' } })
  })

  it('explicitly resumes a prepared creation after shutdown once, including concurrent runtime schedulers', async () => {
    const original = setup()
    const action = await original.service.createTask(input, 'prepared')
    await original.service.stop()
    const second = setup(undefined, original.store)
    const third = setup(undefined, original.store)
    expect((await second.service.createTask(input, 'prepared')).reused).toBe(true)
    await turn()
    expect(second.adapter.create).not.toHaveBeenCalled()
    const replies = await Promise.all([
      second.service.resumeOperation(action.operation.id, confirmation),
      third.service.resumeOperation(action.operation.id, confirmation),
    ])
    expect(replies.every((reply) => reply.operation.id === action.operation.id && reply.operation.state === 'prepared')).toBe(true)
    await turn()
    expect(second.adapter.create.mock.calls.length + third.adapter.create.mock.calls.length).toBe(1)
    expect(second.service.getOperation(action.operation.id)).toMatchObject({ state: 'accepted', payload: input, idempotencyKey: 'prepared' })
    expect(original.store.operations.size).toBe(1)
    await expect(second.service.resumeOperation(action.operation.id, confirmation)).rejects.toMatchObject({ status: 409, code: 'operation_not_prepared' })
  })

  it('resumes a prepared message with the frozen message and original task identity', async () => {
    const original = setup()
    const action = await original.service.createTask(input, 'create')
    await turn()
    const message = await original.service.sendMessage(action.task.id, { message: 'Stored follow-up', ...confirmation }, 'message')
    await original.service.stop()
    const next = setup(undefined, original.store)
    await next.service.resumeOperation(message.operation.id, confirmation)
    await turn()
    expect(next.adapter.create).not.toHaveBeenCalled()
    expect(next.adapter.sendMessage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ providerTaskId: 'task_synthetic' }), 'Stored follow-up', expect.any(AbortSignal))
    expect(next.service.getOperation(message.operation.id).state).toBe('accepted')
  })

  it('requires fresh matching context/account confirmation to resume and rechecks before dispatch', async () => {
    const original = setup()
    original.info.verifiedAccountRef = null
    const action = await original.service.createTask(input, 'prepared')
    await original.service.stop()
    const next = setup(undefined, original.store)
    next.info.verifiedAccountRef = null
    await expect(next.service.resumeOperation(action.operation.id, { accountConfirmed: true })).rejects.toMatchObject({ code: 'invalid_request' })
    await expect(next.service.resumeOperation(action.operation.id, { ...confirmation, credentialContextId: 'wrong' })).rejects.toMatchObject({ code: 'context_mismatch' })
    await expect(next.service.resumeOperation(action.operation.id, { ...confirmation, accountConfirmed: false })).rejects.toMatchObject({ code: 'account_confirmation_required' })
    next.info.credentialContextId = 'replacement'
    await expect(next.service.resumeOperation(action.operation.id, confirmation)).rejects.toMatchObject({ code: 'context_mismatch' })
    expect(next.service.getOperation(action.operation.id).state).toBe('prepared')
    next.info.credentialContextId = confirmation.credentialContextId
    await next.service.resumeOperation(action.operation.id, confirmation)
    next.info.credentialContextId = 'changed-after-confirmation'
    await turn()
    expect(next.adapter.create).not.toHaveBeenCalled()
    expect(next.service.getOperation(action.operation.id)).toMatchObject({ state: 'rejected', issue: { code: 'context_mismatch' } })
  })

  it('preserves the frozen source through explicit resume and applies the adapter source gate', async () => {
    const original = setup()
    const action = await original.service.createTask(input, 'prepared')
    await original.service.stop()
    const next = setup(undefined, original.store)
    await expect(next.service.resumeOperation(action.operation.id, { ...confirmation, source: { branch: 'replacement' } })).rejects.toMatchObject({ code: 'invalid_request' })
    next.adapter.create.mockImplementation(async (frozen) => {
      expect(frozen.source).toEqual(input.source)
      return { state: 'rejected', issue: { code: 'source_changed', message: 'Synthetic source policy drift' } }
    })
    await next.service.resumeOperation(action.operation.id, confirmation)
    await turn()
    expect(next.service.getOperation(action.operation.id)).toMatchObject({ state: 'rejected', issue: { code: 'source_changed' }, payload: input })
  })

  it.each((['accepted', 'dispatching', 'delivery_unknown', 'rejected'] as const).flatMap((state) => ['create', 'link'].map((kind) => ({ state, kind }))))('never resumes a $state $kind operation', async ({ state, kind }) => {
    const original = setup()
    const action = kind === 'create' ? await original.service.createTask(input, 'prepared')
      : await original.service.linkTask({ provider: 'codex', providerTaskId: 'task_external', ...confirmation }, 'prepared')
    await original.service.stop()
    const next = setup(undefined, original.store)
    original.store.operations.get(action.operation.id)!.state = state
    await expect(next.service.resumeOperation(action.operation.id, confirmation)).rejects.toMatchObject({ status: 409, code: 'operation_not_prepared' })
    expect(next.adapter.info).not.toHaveBeenCalled()
    expect(next.adapter.create).not.toHaveBeenCalled()
  })

  it('explicitly resumes a stopped prepared link exactly once with fresh confirmation and immutable identity/source', async () => {
    const original = setup()
    original.info.verifiedAccountRef = null
    const payload = { provider: 'codex', providerTaskId: 'task_external', title: 'Saved local link', source: { repository: 'fixture/repo', branch: 'reviewed' }, ...confirmation }
    const action = await original.service.linkTask(payload, 'prepared-link')
    await original.service.stop()
    expect(original.adapter.inspect).not.toHaveBeenCalled()
    expect(original.store.events).not.toContain('claim')
    const next = setup(undefined, original.store)
    next.info.verifiedAccountRef = null
    next.info.readiness = 'unverified'
    next.info.capabilities.create = false
    next.info.capabilities.sendMessage = false
    next.info.capabilities.inspect = false
    await expect(next.service.resumeOperation(action.operation.id, { ...confirmation, credentialContextId: 'wrong' })).rejects.toMatchObject({ code: 'context_mismatch' })
    await expect(next.service.resumeOperation(action.operation.id, { ...confirmation, accountConfirmed: false })).rejects.toMatchObject({ code: 'account_confirmation_required' })
    expect((await next.service.linkTask(payload, 'prepared-link')).operation.state).toBe('prepared')
    await turn()
    expect(original.store.events).not.toContain('claim')
    const replies = await Promise.all([
      next.service.resumeOperation(action.operation.id, confirmation),
      next.service.resumeOperation(action.operation.id, confirmation),
    ])
    expect(replies.every((reply) => reply.operation.id === action.operation.id)).toBe(true)
    await turn()
    expect(original.store.events.filter((event) => event === 'claim')).toHaveLength(1)
    expect(next.service.getOperation(action.operation.id)).toMatchObject({
      state: 'accepted', payload, requestHash: action.operation.requestHash, idempotencyKey: 'prepared-link',
      receipt: { providerTaskId: 'task_external', evidence: 'user_link' },
    })
    expect(next.service.getTask(action.task.id).task).toMatchObject({ source: payload.source, identityEvidence: 'user_link' })
    await expect(next.service.resumeOperation(action.operation.id, confirmation)).rejects.toMatchObject({ status: 409, code: 'operation_not_prepared' })
    expect(next.adapter.create).not.toHaveBeenCalled()
    expect(next.adapter.sendMessage).not.toHaveBeenCalled()
    expect(original.store.operations.size).toBe(1)
  })

  it('refuses a receipt-bearing prepared link and unbound legacy intents instead of dispatching them', async () => {
    const original = setup()
    const link = await original.service.linkTask({ provider: 'codex', providerTaskId: 'task_external', ...confirmation }, 'link')
    const create = await original.service.createTask(input, 'legacy')
    await original.service.stop()
    const next = setup(undefined, original.store)
    original.store.operations.get(link.operation.id)!.receipt = { providerTaskId: 'task_external', providerUrl: cloudTaskUrl('codex', 'task_external'), evidence: 'user_link' }
    await expect(next.service.resumeOperation(link.operation.id, confirmation)).rejects.toMatchObject({ code: 'operation_not_prepared' })
    original.store.operations.get(link.operation.id)!.receipt = null
    delete (original.store.operations.get(link.operation.id)!.payload as Partial<CloudCreateInput>).credentialContextId
    await expect(next.service.resumeOperation(link.operation.id, confirmation)).rejects.toMatchObject({ code: 'invalid_request' })
    delete (original.store.operations.get(create.operation.id)!.payload as Partial<CloudCreateInput>).credentialContextId
    await expect(next.service.resumeOperation(create.operation.id, confirmation)).rejects.toMatchObject({ code: 'invalid_request' })
    expect(next.adapter.create).not.toHaveBeenCalled()
  })

  it('recovers abandoned leases without invoking a provider', async () => {
    let now = 1_000
    const first = setup(() => now)
    const action = await first.service.createTask(input, 'prepared')
    await first.service.stop()
    first.store.heartbeat('dead-owner')
    first.store.claimOperation(action.operation.id, 'dead-owner')
    now += 31_000
    const second = setup(() => now, first.store)
    expect(second.service.getOperation(action.operation.id).state).toBe('delivery_unknown')
    expect(second.adapter.create).not.toHaveBeenCalled()
  })

  it('stop aborts local dispatch before uncertain journaling and releasing its owner, without closing the store', async () => {
    const { service, store, adapter, receipt } = setup()
    const pending = deferred<CloudDispatchResult>()
    adapter.create.mockImplementation(async (_input, signal) => {
      signal!.addEventListener('abort', () => store.events.push('abort'))
      return pending.promise
    })
    const action = await service.createTask(input, 'key_one')
    await turn()
    await service.stop()
    expect(store.events.slice(-3)).toEqual(['abort', 'finish:delivery_unknown', 'release'])
    expect(store.events).not.toContain('close')
    pending.resolve(receipt())
    await turn()
    expect(service.getOperation(action.operation.id).state).toBe('accepted')
  })

  it('journals user recovery separately and preserves conflicting late provider receipt evidence', async () => {
    const { service, adapter, store, receipt } = setup()
    const pending = deferred<CloudDispatchResult>()
    adapter.create.mockReturnValue(pending.promise)
    const creation = await service.createTask(input, 'create')
    await turn()
    await service.stop()
    const next = setup(undefined, store)
    const link = await next.service.linkTask({ provider: 'codex', providerTaskId: 'task_user_selected', ...confirmation }, 'link', creation.task.id)
    await turn()
    expect(next.service.getOperation(link.operation.id).receipt?.evidence).toBe('user_link')
    pending.resolve(receipt())
    await turn()
    expect(next.service.getTask(creation.task.id).task.providerTaskId).toBe('task_user_selected')
    expect(next.service.getOperation(creation.operation.id).issue?.code).toBe('identity_conflict')
  })

  it('links locally even with an unverified CLI, without invoking create or messages', async () => {
    const { service, adapter, info } = setup()
    info.readiness = 'unverified'
    info.capabilities.inspect = false
    info.verifiedAccountRef = null
    const linked = await service.linkTask({ provider: 'codex', providerTaskId: 'task_external', ...confirmation }, 'link')
    await turn()
    expect(service.getTask(linked.task.id).task).toMatchObject({ providerTaskId: 'task_external', identityEvidence: 'user_link' })
    expect(adapter.create).not.toHaveBeenCalled()
    expect(adapter.sendMessage).not.toHaveBeenCalled()
  })

  it.each([
    { ...input, executable: '/bin/sh' }, { ...input, env: { TOKEN: 'secret' } },
    { ...input, source: { ...input.source, url: 'https://evil.test' } },
    { ...input, prompt: 'é'.repeat(8193) }, { ...input, prompt: '\u0000' },
    { ...input, source: { environmentId: '--evil', branch: 'main' } },
    { ...input, source: { environmentId: 'env_ok', branch: '--exec=evil' } },
  ])('bounds and validates synthetic request %# before probing', async (request) => {
    const { service, adapter } = setup()
    await expect(service.createTask(request, 'valid-key')).rejects.toMatchObject({ code: 'invalid_request' })
    expect(adapter.info).not.toHaveBeenCalled()
  })

  it('singleflights observations, caps work across provider/tasks, retains cached state on errors and handles clock rollback', async () => {
    let now = 50_000
    const { service, adapter } = setup(() => now)
    const one = await service.createTask(input, 'one')
    await turn()
    const two = await service.linkTask({ provider: 'codex', providerTaskId: 'task_two', ...confirmation }, 'two')
    await turn()
    adapter.inspect.mockClear()
    const pending = deferred<CloudInspection>()
    adapter.inspect.mockReturnValueOnce(pending.promise)
    const first = service.refreshTask(one.task.id)
    expect(service.refreshTask(one.task.id)).toBe(first)
    const second = service.refreshTask(two.task.id)
    await Promise.resolve()
    pending.resolve({ remoteState: 'running', rawState: 'running' })
    expect((await first).task.remoteState).toBe('running')
    expect((await second).task.remoteState).toBe('running')
    await service.refreshTask(two.task.id)
    expect(adapter.inspect).toHaveBeenCalledTimes(2)
    now += 30_000
    adapter.inspect.mockRejectedValue(new CloudTaskError(401, 'auth_required', 'raw secret'))
    const stale = await service.refreshTask(one.task.id)
    expect(stale.task).toMatchObject({ remoteState: 'running', observationState: 'auth_required' })
    expect(JSON.stringify(stale)).not.toContain('raw secret')
    now -= 40_000
    await service.refreshTask(one.task.id)
    expect(adapter.inspect).toHaveBeenCalledTimes(4)
  })

  it('serves concurrent task refreshes in FIFO order with one active provider read and a TTL for each task', async () => {
    const { service, adapter, store } = setup()
    const action = await service.createTask(input, 'first')
    await turn()
    for (const id of ['second', 'third']) store.tasks.set(id, { ...service.getTask(action.task.id).task, id, providerTaskId: `task_${id}` })
    const held = deferred<CloudInspection>()
    let active = 0
    let maximum = 0
    const order: string[] = []
    adapter.inspect.mockImplementation(async (task) => {
      active++
      maximum = Math.max(maximum, active)
      order.push(task.id)
      try {
        return task.id === action.task.id ? await held.promise : { remoteState: 'running', rawState: 'running' }
      } finally { active-- }
    })
    const first = service.refreshTask(action.task.id)
    const second = service.refreshTask('second')
    const third = service.refreshTask('third')
    expect(service.refreshTask('second')).toBe(second)
    await turn()
    expect(order).toEqual([action.task.id])
    held.resolve({ remoteState: 'running', rawState: 'running' })
    await Promise.all([first, second, third])
    expect(order).toEqual([action.task.id, 'second', 'third'])
    expect(maximum).toBe(1)
    await Promise.all([service.refreshTask(action.task.id), service.refreshTask('second'), service.refreshTask('third')])
    expect(adapter.inspect).toHaveBeenCalledTimes(3)
    // A previously unseen task is immediately eligible even though this provider just ran.
    store.tasks.set('fourth', { ...service.getTask(action.task.id).task, id: 'fourth', providerTaskId: 'task_fourth' })
    expect((await service.refreshTask('fourth')).task.observationState).toBe('fresh')
    expect(order.at(-1)).toBe('fourth')
  })

  it('caps the provider read queue without putting rejected tasks on cooldown', async () => {
    const { service, adapter, store } = setup()
    const action = await service.createTask(input, 'first')
    await turn()
    const held = deferred<CloudInspection>()
    adapter.inspect.mockReturnValueOnce(held.promise)
    const first = service.refreshTask(action.task.id)
    const queued: Promise<unknown>[] = []
    for (let index = 0; index < 17; index++) {
      const id = `queued-${index}`
      store.tasks.set(id, { ...service.getTask(action.task.id).task, id, providerTaskId: `task_${index}` })
      if (index < 16) queued.push(service.refreshTask(id))
    }
    const overflow = await service.refreshTask('queued-16')
    expect(overflow.task.issue?.code).toBe('rate_limited')
    held.resolve({ remoteState: 'running', rawState: 'running' })
    await Promise.all([first, ...queued])
    expect(adapter.inspect).toHaveBeenCalledTimes(17)
    expect((await service.refreshTask('queued-16')).task.observationState).toBe('fresh')
    expect(adapter.inspect).toHaveBeenCalledTimes(18)
  })

  it('cancels queued observations and diffs on stop, draining an active cooperative read without starting more work', async () => {
    vi.useFakeTimers()
    const { service, adapter, store } = setup()
    const action = await service.createTask(input, 'first')
    await vi.advanceTimersByTimeAsync(0)
    store.tasks.set('second', { ...service.getTask(action.task.id).task, id: 'second', providerTaskId: 'task_second' })
    adapter.inspect.mockImplementation((_task, signal) => new Promise((resolve) => {
      signal!.addEventListener('abort', () => setTimeout(() => resolve({ remoteState: 'running', rawState: 'running' }), 250))
    }))
    const first = service.refreshTask(action.task.id)
    const queued = service.refreshTask('second')
    const diff = service.getDiff('second').catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(0)
    const stop = service.stop()
    expect(service.stop()).toBe(stop)
    let drained = false
    void stop.then(() => { drained = true })
    await vi.advanceTimersByTimeAsync(249)
    expect(drained).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await stop
    expect((await first).task.remoteState).toBe('unknown')
    expect((await queued).task.remoteState).toBe('unknown')
    expect(await diff).toMatchObject({ code: 'service_stopped', status: 503 })
    expect(adapter.inspect).toHaveBeenCalledTimes(1)
    expect(adapter.diff).not.toHaveBeenCalled()
    expect(() => service.refreshTask('second')).toThrow('local dispatcher stopped')
  })

  it('drains cooperative dispatch and receipt persistence before allowing storage to close', async () => {
    vi.useFakeTimers()
    const { service, adapter, receipt, store } = setup()
    adapter.create.mockImplementation((_input, signal) => new Promise((resolve) => {
      signal!.addEventListener('abort', () => setTimeout(() => resolve(receipt()), 250))
    }))
    const action = await service.createTask(input, 'cooperative')
    await vi.advanceTimersByTimeAsync(0)
    const stop = service.stop()
    expect(service.getOperation(action.operation.id).state).toBe('delivery_unknown')
    let drained = false
    void stop.then(() => { drained = true })
    await vi.advanceTimersByTimeAsync(249)
    expect(drained).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await stop
    expect(service.getOperation(action.operation.id).state).toBe('accepted')
    expect(store.events.at(-1)).toBe('finish:accepted')
    store.close()
  })

  it('limits shutdown to two seconds even for a raw adapter still pending after its observer timed out', async () => {
    vi.useFakeTimers()
    const { service, adapter } = setup()
    const action = await service.createTask(input, 'uncooperative')
    await vi.advanceTimersByTimeAsync(0)
    const held = deferred<CloudInspection>()
    adapter.inspect.mockReturnValue(held.promise)
    const observation = service.refreshTask(action.task.id)
    await vi.advanceTimersByTimeAsync(20_001)
    await observation
    const stop = service.stop()
    let drained = false
    void stop.then(() => { drained = true })
    await vi.advanceTimersByTimeAsync(1_999)
    expect(drained).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await stop
    expect(drained).toBe(true)
    held.resolve({ remoteState: 'running', rawState: 'running' })
    await vi.advanceTimersByTimeAsync(0)
    expect(service.getTask(action.task.id).task.remoteState).toBe('unknown')
  })

  it('does not poll on its own and bounds multiline/multibyte diffs', async () => {
    const { service, adapter } = setup()
    const action = await service.createTask(input, 'create')
    await turn()
    expect(adapter.inspect).not.toHaveBeenCalled()
    adapter.diff.mockResolvedValue({ text: 'é'.repeat(CLOUD_DIFF_BYTE_LIMIT), truncated: false })
    const diff = await service.getDiff(action.task.id)
    expect(Buffer.byteLength(diff.text)).toBeLessThanOrEqual(CLOUD_DIFF_BYTE_LIMIT)
    expect(diff.truncated).toBe(true)
    await service.getDiff(action.task.id)
    expect(adapter.diff).toHaveBeenCalledTimes(1)
    const second = await service.linkTask({ provider: 'codex', providerTaskId: 'task_two', ...confirmation }, 'link')
    await turn()
    adapter.diff.mockResolvedValue({ text: '+line\n'.repeat(6000), truncated: false })
    const lines = await service.getDiff(second.task.id)
    expect(lines.text.split('\n')).toHaveLength(CLOUD_DIFF_LINE_LIMIT)
    expect(lines.truncated).toBe(true)
  })
})

describe('profile-scoped Claude connections', () => {
  function profiles(store: CloudTaskRepository = new FakeCloudRepository()) {
    const team = fakeProvider('claude', { credentialContextId: 'claude:team', label: 'Claude Team' })
    const max = fakeProvider('claude', { credentialContextId: 'claude:max', label: 'Claude Max' })
    team.info.capabilities.inspect = false
    max.info.capabilities.inspect = false
    const service = new CloudTaskService({ store, providers: [team.adapter, max.adapter] })
    services.push(service)
    return { service, store, team, max }
  }
  async function linkBoth(service: CloudTaskService) {
    const team = await service.linkTask({ provider: 'claude', credentialContextId: 'claude:team', providerTaskId: 'session_shared', source: { repository: 'synthetic/repo' }, accountConfirmed: true }, 'team-link')
    const max = await service.linkTask({ provider: 'claude', credentialContextId: 'claude:max', providerTaskId: 'session_shared', source: { repository: 'synthetic/repo' }, accountConfirmed: true }, 'max-link')
    await turn()
    return { team, max }
  }

  it('accepts distinct full tuples, rejects exact duplicates, and retains immutable connection labels on probe failure', async () => {
    const { service, team, max } = profiles()
    const initial = (await service.listProviders()).providers
    expect(initial.map((entry) => [cloudConnectionKey(entry.id, entry.credentialContextId), entry.label])).toEqual([
      ['claude/claude:team', 'Claude Team'], ['claude/claude:max', 'Claude Max'],
    ])
    team.adapter.info.mockRejectedValue(new Error('private process output'))
    team.adapter.label = 'unexpected relabel'
    const failed = (await service.listProviders()).providers
    expect(failed[0]).toMatchObject({ id: 'claude', credentialContextId: 'claude:team', label: 'Claude Team', readiness: 'error', capabilities: { sendMessage: false } })
    expect(failed[1]).toMatchObject({ credentialContextId: 'claude:max', label: 'Claude Max', readiness: 'ready' })
    expect(JSON.stringify(failed)).not.toContain('private process output')
    const duplicate = fakeProvider('claude', { credentialContextId: 'claude:max' })
    expect(() => new CloudTaskService({ store: new FakeCloudRepository(), providers: [max.adapter, duplicate.adapter] })).toThrow('Duplicate cloud provider connection')
    const codex = fakeProvider('codex', { credentialContextId: 'claude:max', label: 'x'.repeat(129) })
    const otherFamily = new CloudTaskService({ store: new FakeCloudRepository(), providers: [max.adapter, codex.adapter] })
    services.push(otherFamily)
    expect((await otherFamily.listProviders()).providers.map((entry) => entry.label)).toEqual(['Claude Max', 'Codex'])
  })

  it('routes identical remote IDs through distinct runners and SQLite namespaces after connection reordering', async () => {
    const store = new CloudTaskStore(':memory:')
    databases.push(store)
    const { service, team, max } = profiles(store)
    const tasks = await linkBoth(service)
    expect(service.listTasks()).toHaveLength(2)
    expect(service.getTask(tasks.team.task.id).task).toMatchObject({ providerTaskId: 'session_shared', credentialContextId: 'claude:team' })
    expect(service.getTask(tasks.max.task.id).task).toMatchObject({ providerTaskId: 'session_shared', credentialContextId: 'claude:max' })
    const messages = await Promise.all([
      service.sendMessage(tasks.team.task.id, { credentialContextId: 'claude:team', message: 'Team-only message', accountConfirmed: true }, 'team-message'),
      service.sendMessage(tasks.max.task.id, { credentialContextId: 'claude:max', message: 'Max-only message', accountConfirmed: true }, 'max-message'),
    ])
    await service.stop()
    const reordered = new CloudTaskService({ store, providers: [max.adapter, team.adapter] })
    services.push(reordered)
    await Promise.all([
      reordered.resumeOperation(messages[0].operation.id, { credentialContextId: 'claude:team', accountConfirmed: true }),
      reordered.resumeOperation(messages[1].operation.id, { credentialContextId: 'claude:max', accountConfirmed: true }),
    ])
    await turn()
    expect(team.adapter.sendMessage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ credentialContextId: 'claude:team', providerTaskId: 'session_shared' }), 'Team-only message', expect.any(AbortSignal))
    expect(max.adapter.sendMessage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ credentialContextId: 'claude:max', providerTaskId: 'session_shared' }), 'Max-only message', expect.any(AbortSignal))
    team.adapter.diff.mockResolvedValue({ text: 'Team diff', truncated: false })
    max.adapter.diff.mockResolvedValue({ text: 'Max diff', truncated: false })
    expect(await reordered.getDiff(tasks.team.task.id)).toEqual({ text: 'Team diff', truncated: false })
    expect(await reordered.getDiff(tasks.max.task.id)).toEqual({ text: 'Max diff', truncated: false })
    expect((await reordered.getDiff(tasks.team.task.id)).text).toBe('Team diff')
    expect(team.adapter.diff).toHaveBeenCalledTimes(1)
    expect(max.adapter.diff).toHaveBeenCalledTimes(1)
  })

  it('uses independent create/message capability and account gates for each configured context', async () => {
    const { service, team, max } = profiles()
    team.info.readiness = 'unverified'
    team.info.capabilities.create = false
    team.info.capabilities.sendMessage = false
    max.info.verifiedAccountRef = null
    const tasks = await linkBoth(service)
    const create = { provider: 'claude', credentialContextId: 'claude:team', source: { checkoutPath: '/synthetic/checkout' }, prompt: 'Synthetic create', accountConfirmed: true }
    await expect(service.createTask(create, 'disabled-team-create')).rejects.toMatchObject({ code: 'capability_unavailable' })
    await service.createTask({ ...create, credentialContextId: 'claude:max' }, 'max-create')
    await expect(service.sendMessage(tasks.team.task.id, { credentialContextId: 'claude:team', accountConfirmed: true, message: 'Blocked' }, 'disabled-team-message')).rejects.toMatchObject({ code: 'capability_unavailable' })
    await expect(service.sendMessage(tasks.max.task.id, { credentialContextId: 'claude:max', accountConfirmed: false, message: 'Unconfirmed' }, 'unconfirmed-max-message')).rejects.toMatchObject({ code: 'account_confirmation_required' })
    await service.sendMessage(tasks.max.task.id, { credentialContextId: 'claude:max', accountConfirmed: true, message: 'Confirmed Max' }, 'confirmed-max-message')
    await turn()
    expect(team.adapter.create).not.toHaveBeenCalled()
    expect(team.adapter.sendMessage).not.toHaveBeenCalled()
    expect(max.adapter.create).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ credentialContextId: 'claude:max' }), expect.any(AbortSignal))
    expect(max.adapter.sendMessage).toHaveBeenCalledTimes(1)
    expect((await service.listProviders()).providers.map((entry) => entry.capabilities.create)).toEqual([false, true])
  })

  it('preserves records but never falls back when their configured connection was removed', async () => {
    const { service, store, team, max } = profiles()
    const tasks = await linkBoth(service)
    const prepared = await service.sendMessage(tasks.team.task.id, { credentialContextId: 'claude:team', message: 'Prepared Team', accountConfirmed: true }, 'prepared-team')
    await service.stop()
    max.adapter.info.mockClear()
    const remaining = new CloudTaskService({ store, providers: [max.adapter] })
    services.push(remaining)
    await expect(remaining.sendMessage(tasks.team.task.id, { credentialContextId: 'claude:team', message: 'Missing Team', accountConfirmed: true }, 'missing-team')).rejects.toMatchObject({ code: 'context_mismatch' })
    await expect(remaining.resumeOperation(prepared.operation.id, { credentialContextId: 'claude:team', accountConfirmed: true })).rejects.toMatchObject({ code: 'context_mismatch' })
    await expect(remaining.getDiff(tasks.team.task.id)).rejects.toMatchObject({ code: 'context_mismatch' })
    expect((await remaining.refreshTask(tasks.team.task.id)).task.issue?.code).toBe('context_mismatch')
    await expect(remaining.linkTask({ provider: 'claude', credentialContextId: 'claude:team', providerTaskId: 'session_external', accountConfirmed: true }, 'missing-link')).rejects.toMatchObject({ code: 'context_mismatch' })
    expect(max.adapter.info).not.toHaveBeenCalled()
    expect(max.adapter.sendMessage).not.toHaveBeenCalled()
    expect(team.adapter.sendMessage).not.toHaveBeenCalled()
    expect(remaining.listTasks()).toHaveLength(2)
    expect(remaining.getOperation(prepared.operation.id).state).toBe('prepared')
    expect((await remaining.sendMessage(tasks.team.task.id, { credentialContextId: 'claude:team', message: 'Prepared Team', accountConfirmed: true }, 'prepared-team')).reused).toBe(true)
    await remaining.sendMessage(tasks.max.task.id, { credentialContextId: 'claude:max', accountConfirmed: true, message: 'Still Max' }, 'still-max')
    await turn()
    expect(max.adapter.sendMessage).toHaveBeenCalledTimes(1)
  })

  it('does not rebind a connection when discovery or its configured adapter property changes', async () => {
    const { service, team, max } = profiles()
    const tasks = await linkBoth(service)
    team.info.credentialContextId = 'claude:max'
    await expect(service.sendMessage(tasks.team.task.id, { credentialContextId: 'claude:team', accountConfirmed: true, message: 'Do not reroute' }, 'drift')).rejects.toMatchObject({ code: 'context_mismatch' })
    team.info.credentialContextId = 'claude:team'
    team.adapter.credentialContextId = 'claude:replacement'
    const providers = (await service.listProviders()).providers
    expect(providers[0]).toMatchObject({ credentialContextId: 'claude:team', readiness: 'error' })
    expect(providers[1]).toMatchObject({ credentialContextId: 'claude:max', readiness: 'ready' })
    await expect(service.linkTask({ provider: 'claude', credentialContextId: 'claude:replacement', providerTaskId: 'session_new', accountConfirmed: true }, 'replacement')).rejects.toMatchObject({ code: 'context_mismatch' })
    expect(team.adapter.sendMessage).not.toHaveBeenCalled()
    expect(max.adapter.sendMessage).not.toHaveBeenCalled()
  })

  it('keeps Team queue saturation and failure independent of Max reads and per-task caching', async () => {
    const store = new FakeCloudRepository()
    const { service, team, max } = profiles(store)
    const tasks = await linkBoth(service)
    team.info.capabilities.inspect = true
    max.info.capabilities.inspect = true
    const held = deferred<CloudInspection>()
    team.adapter.inspect.mockReturnValueOnce(held.promise)
    const first = service.refreshTask(tasks.team.task.id)
    const queued: Promise<unknown>[] = []
    for (let index = 0; index < 17; index++) {
      const id = `team-queued-${index}`
      store.tasks.set(id, { ...service.getTask(tasks.team.task.id).task, id, providerTaskId: `session_queued_${index}` })
      if (index < 16) queued.push(service.refreshTask(id))
    }
    expect((await service.refreshTask('team-queued-16')).task.issue?.code).toBe('rate_limited')
    expect((await service.refreshTask(tasks.max.task.id)).task.observationState).toBe('fresh')
    expect((await service.getDiff(tasks.max.task.id)).text).toContain('synthetic change')
    expect(team.adapter.inspect).toHaveBeenCalledTimes(1)
    expect(max.adapter.inspect).toHaveBeenCalledTimes(1)
    team.adapter.info.mockRejectedValue(new Error('Team only unavailable'))
    held.reject(new Error('Team only failed'))
    await Promise.all([first, ...queued])
    expect((await service.refreshTask(tasks.max.task.id)).task.observationState).toBe('fresh')
    expect(max.adapter.inspect).toHaveBeenCalledTimes(1)
    expect(service.getTask(tasks.team.task.id).task.observationState).toBe('error')
  })
})

describe('SQLite/service/adapter/process integration', () => {
  function sqlite(path?: string) {
    if (!path) {
      const directory = mkdtempSync(join(tmpdir(), 'commando-cloud-service-'))
      directories.push(directory)
      path = join(directory, 'tasks.sqlite')
    }
    const store = new CloudTaskStore(path)
    databases.push(store)
    return { store, path }
  }
  function sqliteService(store: CloudTaskStore) {
    const provider = fakeProvider()
    const service = new CloudTaskService({ store, providers: [provider.adapter] })
    services.push(service)
    return { service, ...provider }
  }

  it('keeps a live dispatcher protected across two database connections and recovers the same receipt after reopening', async () => {
    const first = sqlite()
    const { service, adapter, receipt } = sqliteService(first.store)
    const pending = deferred<CloudDispatchResult>()
    adapter.create.mockReturnValue(pending.promise)
    const action = await service.createTask(input, 'durable-key')
    await turn()
    const second = sqlite(first.path)
    const other = sqliteService(second.store)
    expect(other.service.getOperation(action.operation.id).state).toBe('dispatching')
    expect((await other.service.createTask(input, 'durable-key')).reused).toBe(true)
    expect(other.adapter.create).not.toHaveBeenCalled()
    pending.resolve(receipt())
    await turn()
    await service.stop()
    await other.service.stop()
    first.store.close()
    second.store.close()
    const reopened = sqlite(first.path)
    const fresh = sqliteService(reopened.store)
    expect(reopened.store.installationId).toBe(first.store.installationId)
    expect(fresh.service.getOperationByKey('durable-key')).toMatchObject({ id: action.operation.id, state: 'accepted' })
    fresh.info.capabilities.create = false
    expect((await fresh.service.createTask(input, 'durable-key')).reused).toBe(true)
    expect(fresh.adapter.info).not.toHaveBeenCalled()
  })

  it('explicitly resumes a reopened SQLite prepared intent exactly once across competing dispatchers', async () => {
    const original = sqlite()
    const first = sqliteService(original.store)
    const action = await first.service.createTask(input, 'prepared-sqlite')
    await first.service.stop()
    original.store.close()
    const second = sqliteService(sqlite(original.path).store)
    const third = sqliteService(sqlite(original.path).store)
    expect((await second.service.createTask(input, 'prepared-sqlite')).operation.state).toBe('prepared')
    await turn()
    expect(second.adapter.create).not.toHaveBeenCalled()
    await Promise.all([
      second.service.resumeOperation(action.operation.id, confirmation),
      third.service.resumeOperation(action.operation.id, confirmation),
    ])
    await turn()
    expect(second.adapter.create.mock.calls.length + third.adapter.create.mock.calls.length).toBe(1)
    expect(second.service.getOperationByKey('prepared-sqlite')).toMatchObject({ id: action.operation.id, state: 'accepted', payload: input })
    expect(second.service.getTask(action.task.id).operations).toHaveLength(1)
  })

  it('preserves both identities when a real journal receives a late receipt after manual recovery', async () => {
    const { store } = sqlite()
    const first = sqliteService(store)
    const pending = deferred<CloudDispatchResult>()
    first.adapter.create.mockReturnValue(pending.promise)
    const action = await first.service.createTask(input, 'create')
    await turn()
    await first.service.stop()
    const next = sqliteService(store)
    await next.service.linkTask({ provider: 'codex', providerTaskId: 'task_manually_linked', ...confirmation }, 'link', action.task.id)
    await turn()
    first.adapter.create.mockClear()
    pending.resolve(first.receipt())
    await turn()
    const detail = next.service.getTask(action.task.id)
    expect(detail.task.providerTaskId).toBe('task_manually_linked')
    expect(detail.operations[0].receipt?.providerTaskId).toBe('task_synthetic')
    expect(detail.task.issue?.code).toBe('identity_conflict')
    expect((await next.service.refreshTask(action.task.id)).task.issue?.code).toBe('identity_conflict')
    expect(detail.operations[1].receipt?.evidence).toBe('user_link')
  })

  it('drains the actual CLI runner on shutdown before closing SQLite', async () => {
    const { store } = sqlite()
    const { service, adapter } = sqliteService(store)
    let processSettled = false
    adapter.create.mockImplementation(async (_input, signal) => {
      await runCloudCli({ executable: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], signal, timeoutMs: 60_000 })
      processSettled = true
      return { state: 'delivery_unknown', issue: { code: 'delivery_unknown', message: 'Synthetic aborted process' } }
    })
    const action = await service.createTask(input, 'shutdown-process')
    await turn()
    expect(adapter.create).toHaveBeenCalledTimes(1)
    await service.stop()
    expect(processSettled).toBe(true)
    expect(service.getOperation(action.operation.id).state).toBe('delivery_unknown')
    store.close()
  })

  it('runs only a synthetic executable through the actual runner and Codex adapter, then persists and observes it', async () => {
    const { store } = sqlite()
    const fixture = fileURLToPath(new URL('./cloud-test-fixtures/codex-process.mjs', import.meta.url))
    const requests: string[][] = []
    vi.stubEnv('COMMANDO_TOKEN', 'synthetic-secret-must-not-leak')
    vi.stubEnv('OPENAI_API_KEY', 'synthetic-secret-must-not-leak')
    const adapter = new CodexCloudAdapter({
      executable: 'synthetic-only', credentialContextId: 'synthetic-process', verifiedVersion: '0.0.0-synthetic',
      runner: (request) => {
        requests.push(request.args)
        return runCloudCli({ ...request, executable: process.execPath, args: [fixture, ...request.args] })
      },
    })
    const service = new CloudTaskService({ store, providers: [adapter] })
    services.push(service)
    const action = await service.createTask({ ...input, credentialContextId: 'synthetic-process', prompt: "Synthetic task; $(do-not-execute) 'quoted'" }, 'process')
    expect(action.operation.state).toBe('prepared')
    await vi.waitFor(() => expect(service.getOperation(action.operation.id).state).toBe('accepted'))
    expect(requests.filter((args) => args[1] === 'exec')).toHaveLength(1)
    expect((await service.refreshTask(action.task.id)).task).toMatchObject({ providerTaskId: 'task_process', remoteState: 'result_ready', rawState: 'ready' })
    expect((await service.getDiff(action.task.id)).text).toContain('+new')
    expect(JSON.stringify(service.getTask(action.task.id))).not.toContain('synthetic-secret')
  })
})
