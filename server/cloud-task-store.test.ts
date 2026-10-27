import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Worker } from 'node:worker_threads'
import { afterEach, describe, expect, it } from 'vitest'
import { cloudTaskUrl } from '../shared/cloud-tasks.js'
import type { CloudOperation, CloudReceipt, CloudTask } from '../shared/cloud-tasks.js'
import { CloudTaskError } from './cloud-provider.js'
import { CloudTaskStore } from './cloud-task-store.js'

const cleanup: Array<() => void> = []
afterEach(() => { for (const clean of cleanup.splice(0).reverse()) clean() })

function directory(): string {
  const path = mkdtempSync(join(tmpdir(), 'commando-cloud-store-'))
  cleanup.push(() => rmSync(path, { recursive: true, force: true }))
  return path
}

function open(path = join(directory(), 'cloud-tasks.sqlite'), now?: () => number): CloudTaskStore {
  const store = new CloudTaskStore(path, { now })
  cleanup.push(() => store.close())
  return store
}

function sql(path: string): DatabaseSync {
  const db = new DatabaseSync(path)
  cleanup.push(() => db.close())
  return db
}

/** Synthetic provider-neutral journal inputs; no real provider or source is consulted. */
function intent(options: { task?: Partial<CloudTask>; operation?: Partial<CloudOperation>; kind?: CloudOperation['kind'] } = {}) {
  const time = '2026-09-13T00:00:00.000Z'
  const task: CloudTask = {
    id: randomUUID(), provider: 'codex', credentialContextId: 'synthetic-context', verifiedAccountRef: null,
    title: 'Synthetic task', prompt: 'Private synthetic prompt', source: { repository: 'fixture/repo', branch: 'fixture' },
    providerTaskId: null, providerUrl: null, identityEvidence: null, deliveryState: 'prepared',
    remoteState: 'unknown', rawState: null, observationState: 'unavailable', lastObservedAt: null,
    providerUpdatedAt: null, createdAt: time, updatedAt: time, revision: 0, archivedAt: null, issue: null,
    ...options.task,
  }
  const kind = options.kind ?? 'create'
  const operation: CloudOperation = {
    id: randomUUID(), taskId: task.id, kind, idempotencyKey: randomUUID(), requestHash: 'synthetic-sha256',
    payload: kind === 'message' ? { message: 'Synthetic follow-up', credentialContextId: task.credentialContextId, accountConfirmed: true }
      : kind === 'link' ? { provider: task.provider, providerTaskId: 'task_linked', credentialContextId: task.credentialContextId, accountConfirmed: true }
        : { provider: task.provider, prompt: task.prompt, source: task.source, credentialContextId: task.credentialContextId, accountConfirmed: true },
    state: 'prepared', ownerId: null, createdAt: time, updatedAt: time, receipt: null, issue: null,
    ...options.operation,
  }
  return { task, operation }
}

function prepare(store: CloudTaskStore, options?: Parameters<typeof intent>[0]) {
  const input = intent(options)
  return store.prepare(input.task, input.operation)
}

function receipt(id = 'task_accepted', evidence: CloudReceipt['evidence'] = 'provider_receipt', provider: CloudTask['provider'] = 'codex'): CloudReceipt {
  return { providerTaskId: id, providerUrl: cloudTaskUrl(provider, id), evidence }
}

const unknown = { state: 'delivery_unknown' as const, issue: { code: 'timeout', message: 'No receipt observed' } }
const rejected = { state: 'rejected' as const, issue: { code: 'not_spawned', message: 'Not dispatched' } }

describe('CloudTaskStore persistence and atomic intents', () => {
  it('creates a private, versioned database with a stable installation identity across restart', () => {
    const path = join(directory(), 'private', 'cloud-tasks.sqlite')
    const first = open(path)
    const { task, operation } = prepare(first)
    const installationId = first.installationId
    expect(installationId).toMatch(/^[0-9a-f-]{36}$/)
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(statSync(join(path, '..')).mode & 0o777).toBe(0o700)
    for (const suffix of ['-wal', '-shm']) {
      if (existsSync(path + suffix)) expect(statSync(path + suffix).mode & 0o777).toBe(0o600)
    }
    first.close()
    chmodSync(path, 0o644)
    const restarted = open(path)
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(restarted.installationId).toBe(installationId)
    expect(restarted.getTask(task.id)).toEqual(task)
    expect(restarted.getOperationByKey(operation.idempotencyKey)).toEqual(operation)
    expect(restarted.recoverAbandoned(0)).toBe(0)
    expect(restarted.getOperation(operation.id)?.state).toBe('prepared')
    expect(sql(path).prepare('PRAGMA user_version').get()?.user_version).toBe(1)
    expect(open().installationId).not.toBe(installationId)
  })

  it('reuses the original key/hash forever and rejects changed requests without an orphan task', () => {
    const path = join(directory(), 'tasks.sqlite')
    const first = open(path)
    const original = prepare(first)
    first.finishOperation(original.operation.id, rejected)
    first.close()
    const restarted = open(path)
    const retry = intent({ operation: { idempotencyKey: original.operation.idempotencyKey } })
    expect(restarted.prepare(retry.task, retry.operation)).toMatchObject({
      reused: true, task: { id: original.task.id }, operation: { id: original.operation.id, state: 'rejected' },
    })
    retry.operation.requestHash = 'changed-sha256'
    expect(() => restarted.prepare(retry.task, retry.operation)).toThrow(CloudTaskError)
    expect(() => restarted.prepare(retry.task, retry.operation)).toThrow(expect.objectContaining({ status: 409, code: 'idempotency_conflict' }))
    expect(restarted.listTasks(true)).toHaveLength(1)
    expect(restarted.getTask(retry.task.id)).toBeUndefined()
  })

  it('rolls back a new task when recording its operation fails', () => {
    const path = join(directory(), 'tasks.sqlite')
    const store = open(path)
    sql(path).exec(`CREATE TRIGGER fail_intent BEFORE INSERT ON cloud_operations BEGIN SELECT RAISE(ABORT, 'fixture failure'); END`)
    const input = intent()
    expect(() => store.prepare(input.task, input.operation)).toThrow('fixture failure')
    expect(store.getTask(input.task.id)).toBeUndefined()
    expect(store.getOperationByKey(input.operation.idempotencyKey)).toBeUndefined()
  })

  it('excludes prompts from summaries, isolates returned objects, and retains archived history', () => {
    let now = Date.parse('2026-09-13T01:00:00Z')
    const store = open(undefined, () => now)
    const input = intent()
    const original = store.prepare(input.task, input.operation)
    input.task.prompt = 'mutated input'
    input.task.source.branch = 'mutated input'
    original.task.source.branch = 'mutated return'
    original.operation.payload.accountConfirmed = false
    expect(store.getTask(original.task.id)?.prompt).toBe('Private synthetic prompt')
    expect(store.getTask(original.task.id)?.source.branch).toBe('fixture')
    expect(store.getOperation(original.operation.id)?.payload.accountConfirmed).toBe(true)
    expect(store.listTasks()[0]).not.toHaveProperty('prompt')
    now += 1000
    const archived = store.updateTask(original.task.id, { title: 'Renamed', archivedAt: new Date(now).toISOString() })
    expect(archived).toMatchObject({ title: 'Renamed', revision: 2, updatedAt: new Date(now).toISOString() })
    expect(store.listTasks()).toEqual([])
    expect(store.listTasks(true)).toHaveLength(1)
    expect(store.operationsForTask(original.task.id)).toHaveLength(1)
    now -= 10_000
    expect(store.updateTask(original.task.id, { archivedAt: null }).updatedAt).toBe(archived.updatedAt)
    expect(store.listTasks()).toHaveLength(1)
  })

  it('fails closed on corrupt files, foreign databases, newer schemas, and missing installation metadata', () => {
    const corrupt = join(directory(), 'corrupt.sqlite')
    writeFileSync(corrupt, 'synthetic corruption')
    expect(() => new CloudTaskStore(corrupt)).toThrow()
    expect(readFileSync(corrupt, 'utf8')).toBe('synthetic corruption')
    const foreign = join(directory(), 'auth.sqlite')
    const auth = sql(foreign)
    auth.exec('CREATE TABLE user (id TEXT); INSERT INTO user VALUES (\'synthetic-owner\')')
    expect(() => new CloudTaskStore(foreign)).toThrow('dedicated cloud task database')
    expect(auth.prepare('SELECT * FROM user').all()).toEqual([{ id: 'synthetic-owner' }])
    const future = join(directory(), 'future.sqlite')
    open(future).close()
    sql(future).exec('PRAGMA user_version = 100')
    expect(() => new CloudTaskStore(future)).toThrow('Unsupported')
    const missing = join(directory(), 'missing.sqlite')
    open(missing).close()
    sql(missing).exec('DELETE FROM cloud_metadata')
    expect(() => new CloudTaskStore(missing)).toThrow('installation identity')
  })

  it('fails all reads and mutations safely after close without replacing persisted state', () => {
    const path = join(directory(), 'tasks.sqlite')
    const store = open(path)
    const original = prepare(store)
    store.close()
    store.close()
    const calls = [
      () => store.listTasks(), () => store.getTask(original.task.id), () => store.getOperation(original.operation.id),
      () => store.getOperationByKey(original.operation.idempotencyKey), () => store.operationsForTask(original.task.id),
      () => store.prepare(original.task, original.operation), () => store.heartbeat(randomUUID()),
      () => store.claimOperation(original.operation.id, randomUUID()), () => store.finishOperation(original.operation.id, unknown),
      () => store.updateTask(original.task.id, { title: 'lost update' }), () => store.recoverAbandoned(1000),
      () => store.releaseOwner(randomUUID()),
    ]
    for (const call of calls) expect(call).toThrow(expect.objectContaining({ status: 503, code: 'store_closed' }))
    expect(open(path).getTask(original.task.id)).toEqual(original.task)
  })
})

describe('CloudTaskStore ownership and concurrency', () => {
  it('claims once across independent connections and only recovers stale owners, never prepared intents', () => {
    let now = 10_000
    const path = join(directory(), 'tasks.sqlite')
    const first = open(path, () => now)
    const second = open(path, () => now)
    const owner = randomUUID()
    const otherOwner = randomUUID()
    const active = prepare(first)
    const stale = prepare(first)
    const prepared = prepare(first)
    expect(first.claimOperation(active.operation.id, owner)).toBe(true)
    expect(second.claimOperation(active.operation.id, otherOwner)).toBe(false)
    expect(second.claimOperation(stale.operation.id, otherOwner)).toBe(true)
    expect(first.getTask(active.task.id)?.deliveryState).toBe('dispatching')
    now = 14_000
    first.heartbeat(owner)
    now = 16_000
    expect(second.recoverAbandoned(5000)).toBe(1)
    expect(first.getOperation(active.operation.id)).toMatchObject({ state: 'dispatching', ownerId: owner })
    expect(first.getOperation(stale.operation.id)).toMatchObject({ state: 'delivery_unknown', ownerId: otherOwner })
    expect(first.getTask(stale.task.id)?.deliveryState).toBe('delivery_unknown')
    expect(first.getOperation(prepared.operation.id)?.state).toBe('prepared')
    first.heartbeat(otherOwner)
    expect(first.claimOperation(stale.operation.id, otherOwner)).toBe(false)
    expect(second.recoverAbandoned(5000)).toBe(0)
    first.close()
    // Closing a connection is not proof that its owner stopped in another instance.
    expect(second.recoverAbandoned(5000)).toBe(0)
    now = 20_000
    const restarted = open(path, () => now)
    expect(restarted.recoverAbandoned(5000)).toBe(1)
    expect(restarted.claimOperation(active.operation.id, randomUUID())).toBe(false)
    expect(restarted.getOperation(prepared.operation.id)?.state).toBe('prepared')
  })

  it('releases only the named owner and resists backward clock movement', () => {
    let now = 10_000
    const store = open(undefined, () => now)
    const first = prepare(store)
    const second = prepare(store)
    const owner = randomUUID()
    const other = randomUUID()
    store.claimOperation(first.operation.id, owner)
    store.claimOperation(second.operation.id, other)
    now = 5000
    store.heartbeat(other)
    now = 11_000
    expect(store.recoverAbandoned(2000)).toBe(0)
    store.releaseOwner(owner)
    expect(store.recoverAbandoned(2000)).toBe(1)
    expect(store.getOperation(second.operation.id)?.state).toBe('dispatching')
    expect(store.claimOperation(first.operation.id, other)).toBe(false)
    expect(() => store.heartbeat('shared-process-name')).toThrow(expect.objectContaining({ code: 'invalid_owner' }))
  })

  async function race(differentHashes: boolean) {
    const path = join(directory(), 'tasks.sqlite')
    const key = randomUUID()
    const inputs = [intent({ operation: { idempotencyKey: key } }), intent({ operation: {
      idempotencyKey: key, requestHash: differentHashes ? 'different-sha256' : 'synthetic-sha256',
    } })]
    const workers = inputs.map((input) => new Worker(new URL('./cloud-task-store-fixtures/concurrent.mjs', import.meta.url), {
      workerData: { path, ...input },
    }))
    try {
      await Promise.all(workers.map((worker) => new Promise<void>((resolve, reject) => {
        worker.once('message', () => resolve())
        worker.once('error', reject)
      })))
      type Result = { installationId?: string; taskId?: string; operationId?: string; reused?: boolean; claimed?: boolean; error?: { status: number; code: string } }
      const results = await Promise.all(workers.map((worker) => new Promise<Result>((resolve, reject) => {
        worker.once('message', resolve)
        worker.once('error', reject)
        worker.postMessage('go')
      })))
      return { store: open(path), results }
    } finally {
      await Promise.all(workers.map((worker) => worker.terminate()))
    }
  }

  it('arbitrates simultaneous initialization, same-key prepares and claims in separate worker connections', async () => {
    const { store, results } = await race(false)
    expect(results.filter((result) => result.error)).toEqual([])
    expect(new Set(results.map((result) => result.installationId))).toEqual(new Set([store.installationId]))
    expect(new Set(results.map((result) => result.operationId)).size).toBe(1)
    expect(new Set(results.map((result) => result.taskId)).size).toBe(1)
    expect(results.filter((result) => result.reused)).toHaveLength(1)
    expect(results.filter((result) => result.claimed)).toHaveLength(1)
    expect(store.listTasks(true)).toHaveLength(1)
    expect(store.operationsForTask(results[0].taskId!)).toHaveLength(1)
  })

  it('atomically rejects a racing same-key/different-hash intent without inserting its task', async () => {
    const { store, results } = await race(true)
    expect(results.filter((result) => result.error)).toEqual([
      expect.objectContaining({ error: expect.objectContaining({ status: 409, code: 'idempotency_conflict' }) }),
    ])
    expect(results.filter((result) => result.claimed)).toHaveLength(1)
    expect(store.listTasks(true)).toHaveLength(1)
  })
})

describe('CloudTaskStore receipts, messages, links and source identity', () => {
  it('atomically persists acceptance and immutable source through restart; late failures cannot undo it', () => {
    let now = 10_000
    const path = join(directory(), 'tasks.sqlite')
    const store = open(path, () => now)
    const original = prepare(store)
    now += 1000
    store.claimOperation(original.operation.id, randomUUID())
    now += 1000
    const accepted = store.finishOperation(original.operation.id, { state: 'accepted', receipt: receipt() })
    expect(accepted.task).toMatchObject({ deliveryState: 'accepted', providerTaskId: 'task_accepted', identityEvidence: 'provider_receipt', revision: 3 })
    expect(accepted.operation).toMatchObject({ state: 'accepted', receipt: receipt() })
    expect(accepted.task.updatedAt).toBe(new Date(now).toISOString())
    store.updateTask(original.task.id, { remoteState: 'result_ready', rawState: 'ready', observationState: 'fresh' })
    const terminal = store.getTask(original.task.id)
    for (const failure of [unknown, rejected]) {
      expect(store.finishOperation(original.operation.id, failure)).toMatchObject({ reused: true, task: terminal, operation: accepted.operation })
    }
    store.close()
    const restarted = open(path, () => now)
    expect(restarted.getTask(original.task.id)).toEqual(terminal)
    expect(restarted.getOperation(original.operation.id)).toEqual(accepted.operation)
  })

  it('rolls back receipt and identity together when persistence fails, retaining the dispatch journal', () => {
    const path = join(directory(), 'tasks.sqlite')
    const store = open(path)
    const original = prepare(store)
    store.claimOperation(original.operation.id, randomUUID())
    const db = sql(path)
    db.exec(`CREATE TRIGGER fail_receipt BEFORE UPDATE ON cloud_tasks BEGIN SELECT RAISE(ABORT, 'fixture disk failure'); END`)
    expect(() => store.finishOperation(original.operation.id, { state: 'accepted', receipt: receipt() })).toThrow('fixture disk failure')
    expect(store.getOperation(original.operation.id)).toMatchObject({ state: 'dispatching', receipt: null })
    expect(store.getTask(original.task.id)).toMatchObject({ deliveryState: 'dispatching', providerTaskId: null })
    db.exec('DROP TRIGGER fail_receipt')
    expect(store.finishOperation(original.operation.id, { state: 'accepted', receipt: receipt() }).task.deliveryState).toBe('accepted')
  })

  it.each(['accepted', 'rejected', 'delivery_unknown'] as const)('a %s message never replaces task data or initial delivery', (state) => {
    const store = open()
    const original = prepare(store)
    const accepted = store.finishOperation(original.operation.id, { state: 'accepted', receipt: receipt() })
    store.updateTask(original.task.id, { title: 'Current title', remoteState: 'result_ready', rawState: 'ready', archivedAt: '2026-09-13T00:00:00Z' })
    const message = prepare(store, { task: { ...original.task, prompt: 'stale prompt', source: { branch: 'stale' } }, kind: 'message' })
    expect(message.task).toMatchObject({
      title: 'Current title', prompt: accepted.task.prompt, source: accepted.task.source,
      providerTaskId: 'task_accepted', deliveryState: 'accepted', remoteState: 'result_ready', archivedAt: '2026-09-13T00:00:00Z',
    })
    store.claimOperation(message.operation.id, randomUUID())
    const result = store.finishOperation(message.operation.id, state === 'accepted' ? { state, receipt: receipt() } : { state, issue: unknown.issue })
    expect(result.task).toMatchObject({ deliveryState: 'accepted', providerTaskId: 'task_accepted', remoteState: 'result_ready' })
    expect(result.operation.state).toBe(state)
    expect(store.getOperation(original.operation.id)).toEqual(accepted.operation)
  })

  it('linking recovers only identity, never uncertain create or message delivery; matching late create receipt resolves it', () => {
    const store = open()
    const original = prepare(store)
    store.claimOperation(original.operation.id, randomUUID())
    store.finishOperation(original.operation.id, unknown)
    const link = prepare(store, { task: original.task, kind: 'link' })
    store.claimOperation(link.operation.id, randomUUID())
    const linked = store.finishOperation(link.operation.id, { state: 'accepted', receipt: receipt('task_linked', 'user_link') })
    expect(linked.task).toMatchObject({ deliveryState: 'delivery_unknown', identityEvidence: 'user_link', providerTaskId: 'task_linked' })
    expect(store.getOperation(original.operation.id)?.state).toBe('delivery_unknown')
    const message = prepare(store, { task: original.task, kind: 'message' })
    store.claimOperation(message.operation.id, randomUUID())
    store.finishOperation(message.operation.id, unknown)
    const relink = prepare(store, { task: original.task, kind: 'link' })
    store.finishOperation(relink.operation.id, { state: 'accepted', receipt: receipt('task_linked', 'user_link') })
    expect(store.getOperation(message.operation.id)?.state).toBe('delivery_unknown')
    const late = store.finishOperation(original.operation.id, { state: 'accepted', receipt: receipt('task_linked') })
    expect(late.task).toMatchObject({ deliveryState: 'accepted', identityEvidence: 'provider_receipt', providerTaskId: 'task_linked', issue: null })
    expect(store.getOperation(message.operation.id)?.state).toBe('delivery_unknown')
  })

  it('standalone user links have accepted identity without claiming a create receipt', () => {
    const store = open()
    const link = prepare(store, { kind: 'link' })
    store.claimOperation(link.operation.id, randomUUID())
    const linked = store.finishOperation(link.operation.id, { state: 'accepted', receipt: receipt('task_linked', 'user_link') })
    expect(linked.task).toMatchObject({ deliveryState: 'accepted', identityEvidence: 'user_link', providerTaskId: 'task_linked' })
    expect(store.operationsForTask(link.task.id).map((operation) => operation.kind)).toEqual(['link'])
  })

  it('retains a conflicting late receipt beside manually linked identity across restart', () => {
    const path = join(directory(), 'tasks.sqlite')
    const store = open(path)
    const original = prepare(store)
    store.finishOperation(original.operation.id, unknown)
    const link = prepare(store, { task: original.task, kind: 'link' })
    store.finishOperation(link.operation.id, { state: 'accepted', receipt: receipt('task_linked', 'user_link') })
    const late = store.finishOperation(original.operation.id, { state: 'accepted', receipt: receipt('task_actual') })
    expect(late.operation).toMatchObject({ state: 'accepted', receipt: receipt('task_actual'), issue: { code: 'identity_conflict' } })
    expect(late.task).toMatchObject({ deliveryState: 'delivery_unknown', providerTaskId: 'task_linked', identityEvidence: 'user_link', issue: { code: 'identity_conflict' } })
    store.finishOperation(original.operation.id, rejected)
    store.close()
    const restarted = open(path)
    expect(restarted.getTask(original.task.id)).toEqual(late.task)
    expect(restarted.getOperation(original.operation.id)).toEqual(late.operation)
    expect(restarted.getOperation(link.operation.id)?.receipt).toEqual(receipt('task_linked', 'user_link'))
  })

  it('uniquely namespaces remote identity by provider/context, including archived tasks and changed source', () => {
    const path = join(directory(), 'tasks.sqlite')
    const first = open(path)
    const second = open(path)
    const original = prepare(first)
    first.finishOperation(original.operation.id, { state: 'accepted', receipt: receipt() })
    first.updateTask(original.task.id, { archivedAt: '2026-09-13T00:00:00Z' })
    const duplicate = prepare(second, { task: { source: { repository: 'another/repo', environmentId: 'other-env' }, verifiedAccountRef: 'changed-account' } })
    const conflict = second.finishOperation(duplicate.operation.id, { state: 'accepted', receipt: receipt() })
    expect(conflict.operation.receipt).toEqual(receipt())
    expect(conflict.task).toMatchObject({ providerTaskId: null, deliveryState: 'delivery_unknown', issue: { code: 'identity_conflict' } })
    const context = prepare(second, { task: { credentialContextId: 'synthetic-context-generation-2' } })
    expect(second.finishOperation(context.operation.id, { state: 'accepted', receipt: receipt() }).task.providerTaskId).toBe('task_accepted')
    // Preparing a pre-identified task is also subject to the same unique namespace.
    const preidentified = intent({ kind: 'link', task: { providerTaskId: 'task_accepted' } })
    expect(() => second.prepare(preidentified.task, preidentified.operation)).toThrow(expect.objectContaining({ status: 409 }))
    const otherProvider = prepare(second, { kind: 'link', task: { provider: 'claude' } })
    expect(second.finishOperation(otherProvider.operation.id, {
      state: 'accepted', receipt: receipt('session_linked', 'user_link', 'claude'),
    }).task.providerTaskId).toBe('session_linked')
    expect(sql(path).prepare('PRAGMA index_info(cloud_remote_identity)').all().map((column) => column.name))
      .toEqual(['provider', 'credential_context_id', 'provider_task_id'])
    expect(first.getTask(original.task.id)?.providerTaskId).toBe('task_accepted')
  })

  it('does not cascade from historical origin deletion or rebind recycled pane identities', () => {
    const root = directory()
    const checkout = join(root, 'origin-checkout')
    mkdirSync(checkout)
    const path = join(root, 'tasks.sqlite')
    const store = open(path)
    const original = prepare(store, { task: {
      origin: { sessionId: '$7', paneTargetId: '%12', label: 'Historical origin' }, source: { checkoutPath: checkout, branch: 'fixture' },
    } })
    const accepted = store.finishOperation(original.operation.id, { state: 'accepted', receipt: receipt() })
    rmSync(checkout, { recursive: true })
    const unrelated = prepare(store, { task: { origin: { sessionId: '$7', paneTargetId: '%12', label: 'Recycled' } } })
    store.close()
    const restarted = open(path)
    expect(restarted.getTask(original.task.id)).toEqual(accepted.task)
    expect(restarted.getOperation(original.operation.id)).toEqual(accepted.operation)
    expect(restarted.getTask(unrelated.task.id)?.origin?.label).toBe('Recycled')
    expect(restarted.listTasks()).toHaveLength(2)
    expect(sql(path).prepare('PRAGMA foreign_key_list(cloud_tasks)').all()).toEqual([])
  })

  it('rejects missing or mismatched acceptance evidence without changing the journal', () => {
    const store = open()
    const original = prepare(store)
    expect(() => store.finishOperation(original.operation.id, { state: 'accepted' })).toThrow(expect.objectContaining({ code: 'invalid_receipt' }))
    expect(() => store.finishOperation(original.operation.id, {
      state: 'accepted', receipt: { ...receipt(), providerUrl: cloudTaskUrl('codex', 'task_different') },
    })).toThrow(expect.objectContaining({ code: 'invalid_receipt' }))
    expect(() => store.finishOperation(original.operation.id, { state: 'accepted', receipt: receipt('task_linked', 'user_link') }))
      .toThrow(expect.objectContaining({ code: 'invalid_receipt' }))
    expect(store.getOperation(original.operation.id)).toEqual(original.operation)
    expect(store.getTask(original.task.id)).toEqual(original.task)
  })
})
