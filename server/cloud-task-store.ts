import { randomUUID } from 'node:crypto'
import { chmodSync, closeSync, lstatSync, mkdirSync, openSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { cloudTaskUrl, isSafeCloudUrl, validCloudRemoteId } from '../shared/cloud-tasks.js'
import type { CloudIssue, CloudOperation, CloudTask, CloudTaskAction, CloudTaskSummary } from '../shared/cloud-tasks.js'
import { CloudTaskError } from './cloud-provider.js'
import type { CloudOperationResult, CloudTaskRepository } from './cloud-task-repository.js'

const APPLICATION_ID = 0x434c4454
const SCHEMA_VERSION = 1
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const IDENTITY_CONFLICT: CloudIssue = {
  code: 'identity_conflict',
  message: 'The receipt conflicts with a tracked identity. Both identities have been retained for review.',
}
const ABANDONED: CloudIssue = {
  code: 'owner_abandoned',
  message: 'The dispatcher stopped responding. Check the provider before submitting another intent.',
}

function decode<T>(row: Record<string, unknown> | undefined): T | undefined {
  return row === undefined ? undefined : JSON.parse(row.data as string) as T
}

/** Durable journal only. No session pruning, provider calls, timers, or automatic redispatch. */
export class CloudTaskStore implements CloudTaskRepository {
  readonly installationId: string
  private readonly db: DatabaseSync
  private readonly now: () => number
  private closed = false

  constructor(path: string, options: { now?: () => number } = {}) {
    this.now = options.now ?? Date.now
    if (!path.trim()) throw new Error('Cloud task database path must not be empty')
    if (path !== ':memory:') {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
      // Create privately before SQLite can write prompts or create journal sidecars.
      try { closeSync(openSync(path, 'wx', 0o600)) } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      }
      if (!lstatSync(path).isFile()) throw new Error('Cloud task database must be a regular file')
      chmodSync(path, 0o600)
    }
    this.db = new DatabaseSync(path)
    try {
      this.db.exec('PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON; PRAGMA synchronous = FULL;')
      this.installationId = this.transaction(() => this.migrate())
      // Main-file permissions are inherited by WAL/SHM files on creation.
      this.db.exec('PRAGMA journal_mode = WAL;')
      if (path !== ':memory:') {
        for (const suffix of ['-wal', '-shm']) {
          try { chmodSync(path + suffix, 0o600) } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          }
        }
      }
      if (this.db.prepare('PRAGMA quick_check').get()?.quick_check !== 'ok'
        || this.db.prepare('PRAGMA foreign_key_check').all().length !== 0) {
        throw new Error('Cloud task database integrity check failed')
      }
    } catch (error) {
      this.db.close()
      throw error
    }
  }

  private migrate(): string {
    const applicationId = Number(this.db.prepare('PRAGMA application_id').get()?.application_id)
    const version = Number(this.db.prepare('PRAGMA user_version').get()?.user_version)
    if (applicationId !== APPLICATION_ID && (applicationId !== 0 || version !== 0
      || this.db.prepare("SELECT 1 FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").get())) {
      throw new Error('Expected a dedicated cloud task database')
    }
    if (version > SCHEMA_VERSION || (applicationId === APPLICATION_ID && version < 1)) {
      throw new Error('Unsupported cloud task database schema')
    }
    if (version === 0) {
      this.db.exec(`
        CREATE TABLE cloud_metadata (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);
        CREATE TABLE cloud_tasks (
          id TEXT PRIMARY KEY NOT NULL,
          provider TEXT NOT NULL,
          credential_context_id TEXT NOT NULL,
          provider_task_id TEXT,
          data TEXT NOT NULL CHECK(json_valid(data))
        );
        CREATE UNIQUE INDEX cloud_remote_identity
          ON cloud_tasks(provider, credential_context_id, provider_task_id)
          WHERE provider_task_id IS NOT NULL;
        CREATE TABLE cloud_operations (
          id TEXT PRIMARY KEY NOT NULL,
          task_id TEXT NOT NULL REFERENCES cloud_tasks(id) ON DELETE RESTRICT,
          idempotency_key TEXT NOT NULL UNIQUE,
          state TEXT NOT NULL CHECK(state IN ('prepared', 'dispatching', 'accepted', 'rejected', 'delivery_unknown')),
          owner_id TEXT,
          data TEXT NOT NULL CHECK(json_valid(data))
        );
        CREATE INDEX cloud_operations_task ON cloud_operations(task_id);
        CREATE INDEX cloud_operations_owner ON cloud_operations(state, owner_id);
        CREATE TABLE cloud_owners (id TEXT PRIMARY KEY NOT NULL, heartbeat_at REAL NOT NULL);
        PRAGMA application_id = ${APPLICATION_ID};
        PRAGMA user_version = 1;
      `)
      this.db.prepare('INSERT INTO cloud_metadata VALUES (?, ?)').run('installation_id', randomUUID())
    }
    const id = this.db.prepare('SELECT value FROM cloud_metadata WHERE key = ?').get('installation_id')?.value
    if (typeof id !== 'string' || !UUID.test(id)) throw new Error('Missing or invalid cloud installation identity')
    return id
  }

  private assertOpen(): void {
    if (this.closed) throw new CloudTaskError(503, 'store_closed', 'Cloud task storage is closed')
  }

  private transaction<T>(body: () => T): T {
    this.assertOpen()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = body()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  private timestamp(previous?: string): string {
    return new Date(Math.max(this.now(), previous ? Date.parse(previous) : -Infinity)).toISOString()
  }

  private requireTask(id: string): CloudTask {
    const task = this.getTask(id)
    if (!task) throw new CloudTaskError(404, 'task_not_found', 'Cloud task not found')
    return task
  }

  private requireOperation(id: string): CloudOperation {
    const operation = this.getOperation(id)
    if (!operation) throw new CloudTaskError(404, 'operation_not_found', 'Cloud operation not found')
    return operation
  }

  private action(operation: CloudOperation, reused: boolean): CloudTaskAction {
    return { task: this.requireTask(operation.taskId), operation, reused }
  }

  listTasks(includeArchived = false): CloudTaskSummary[] {
    this.assertOpen()
    return this.db.prepare(`SELECT json_remove(data, '$.prompt') AS data FROM cloud_tasks
      WHERE ? OR json_extract(data, '$.archivedAt') IS NULL
      ORDER BY json_extract(data, '$.updatedAt') DESC, id`).all(Number(includeArchived))
      .map((row) => decode<CloudTaskSummary>(row)!)
  }

  getTask(id: string): CloudTask | undefined {
    this.assertOpen()
    return decode<CloudTask>(this.db.prepare('SELECT data FROM cloud_tasks WHERE id = ?').get(id))
  }

  getOperation(id: string): CloudOperation | undefined {
    this.assertOpen()
    return decode<CloudOperation>(this.db.prepare('SELECT data FROM cloud_operations WHERE id = ?').get(id))
  }

  getOperationByKey(key: string): CloudOperation | undefined {
    this.assertOpen()
    return decode<CloudOperation>(this.db.prepare('SELECT data FROM cloud_operations WHERE idempotency_key = ?').get(key))
  }

  operationsForTask(taskId: string): CloudOperation[] {
    this.assertOpen()
    return this.db.prepare('SELECT data FROM cloud_operations WHERE task_id = ? ORDER BY rowid').all(taskId)
      .map((row) => decode<CloudOperation>(row)!)
  }

  private saveTask(task: CloudTask): void {
    this.db.prepare(`UPDATE cloud_tasks SET provider_task_id = ?, data = ? WHERE id = ?`)
      .run(task.providerTaskId, JSON.stringify(task), task.id)
  }

  private touchTask(task: CloudTask): void {
    task.revision += 1
    task.updatedAt = this.timestamp(task.updatedAt)
    this.saveTask(task)
  }

  private saveOperation(operation: CloudOperation): void {
    this.db.prepare('UPDATE cloud_operations SET state = ?, owner_id = ?, data = ? WHERE id = ?')
      .run(operation.state, operation.ownerId, JSON.stringify(operation), operation.id)
  }

  prepare(task: CloudTask, operation: CloudOperation): CloudTaskAction {
    return this.transaction(() => {
      const existing = this.getOperationByKey(operation.idempotencyKey)
      if (existing) {
        if (existing.requestHash !== operation.requestHash) {
          throw new CloudTaskError(409, 'idempotency_conflict', 'This intent key already records a different request')
        }
        return this.action(existing, true)
      }
      if (operation.taskId !== task.id || operation.state !== 'prepared' || operation.ownerId !== null
        || operation.receipt !== null || !operation.idempotencyKey || !operation.requestHash) {
        throw new CloudTaskError(400, 'invalid_intent', 'Expected an unclaimed prepared intent for this task')
      }
      if (this.getOperation(operation.id)) throw new CloudTaskError(409, 'operation_conflict', 'Operation ID already exists')
      const current = this.getTask(task.id)
      if (current) {
        if (operation.kind === 'create' || current.provider !== task.provider
          || current.credentialContextId !== task.credentialContextId) {
          throw new CloudTaskError(409, 'task_conflict', 'Task identity already exists in the journal')
        }
        // The caller may hold a pre-receipt snapshot. Never replace persisted task data.
        this.touchTask(current)
      } else {
        if (operation.kind === 'message') throw new CloudTaskError(404, 'task_not_found', 'Cloud task not found')
        if (task.providerTaskId && this.remoteIdentityOwner(task, task.providerTaskId)) {
          throw new CloudTaskError(409, 'identity_conflict', 'Provider identity is already tracked')
        }
        const time = this.timestamp()
        const initial = { ...task, createdAt: time, updatedAt: time, revision: 1, deliveryState: 'prepared' as const }
        this.db.prepare('INSERT INTO cloud_tasks VALUES (?, ?, ?, ?, ?)')
          .run(task.id, task.provider, task.credentialContextId, task.providerTaskId, JSON.stringify(initial))
      }
      const time = this.timestamp()
      const prepared: CloudOperation = { ...operation, createdAt: time, updatedAt: time, issue: null }
      this.db.prepare('INSERT INTO cloud_operations VALUES (?, ?, ?, ?, ?, ?)')
        .run(prepared.id, prepared.taskId, prepared.idempotencyKey, prepared.state, null, JSON.stringify(prepared))
      return this.action(this.requireOperation(operation.id), false)
    })
  }

  heartbeat(ownerId: string): void {
    this.assertOpen()
    if (!UUID.test(ownerId)) throw new CloudTaskError(400, 'invalid_owner', 'Dispatcher owner must be a runtime UUID')
    this.db.prepare(`INSERT INTO cloud_owners VALUES (?, ?) ON CONFLICT(id)
      DO UPDATE SET heartbeat_at = MAX(heartbeat_at, excluded.heartbeat_at)`).run(ownerId, this.now())
  }

  /** A link has initial delivery only if it did not recover an existing create. */
  private controlsDelivery(operation: CloudOperation): boolean {
    return operation.kind === 'create' || (operation.kind === 'link'
      && !this.operationsForTask(operation.taskId).some((item) => item.kind === 'create'))
  }

  claimOperation(id: string, ownerId: string): boolean {
    return this.transaction(() => {
      const operation = this.requireOperation(id)
      if (operation.state !== 'prepared' || operation.ownerId !== null) return false
      this.heartbeat(ownerId)
      operation.state = 'dispatching'
      operation.ownerId = ownerId
      operation.updatedAt = this.timestamp(operation.updatedAt)
      this.saveOperation(operation)
      const task = this.requireTask(operation.taskId)
      if (this.controlsDelivery(operation) && task.deliveryState !== 'accepted') task.deliveryState = 'dispatching'
      this.touchTask(task)
      return true
    })
  }

  private remoteIdentityOwner(task: CloudTask, remoteId: string): string | undefined {
    return this.db.prepare(`SELECT id FROM cloud_tasks
      WHERE provider = ? AND credential_context_id = ? AND provider_task_id = ? AND id != ?`)
      .get(task.provider, task.credentialContextId, remoteId, task.id)?.id as string | undefined
  }

  finishOperation(id: string, result: CloudOperationResult): CloudTaskAction {
    return this.transaction(() => {
      const operation = this.requireOperation(id)
      // A shutdown/error callback must never erase a receipt (or a proven rejection).
      if (operation.state === 'accepted' || (operation.state === 'rejected' && result.state !== 'accepted')) {
        return this.action(operation, true)
      }
      const task = this.requireTask(operation.taskId)
      if (result.state === 'accepted') {
        const receipt = result.receipt
        if (!receipt || !validCloudRemoteId(task.provider, receipt.providerTaskId)
          || !isSafeCloudUrl(task.provider, receipt.providerUrl)
          || new URL(receipt.providerUrl).pathname !== new URL(cloudTaskUrl(task.provider, receipt.providerTaskId)).pathname
          || (receipt.evidence !== 'provider_receipt' && (receipt.evidence !== 'user_link' || operation.kind !== 'link'))) {
          throw new CloudTaskError(400, 'invalid_receipt', 'Acceptance requires a matching, safe provider receipt')
        }
        operation.receipt = receipt
        operation.issue = null
        const conflict = (task.providerTaskId !== null && task.providerTaskId !== receipt.providerTaskId)
          || this.remoteIdentityOwner(task, receipt.providerTaskId) !== undefined
        if (conflict) {
          // Acceptance is still evidence. Keep it even when the unique identity cannot be installed.
          operation.issue = IDENTITY_CONFLICT
          task.issue = IDENTITY_CONFLICT
          if (this.controlsDelivery(operation) && task.deliveryState !== 'accepted') task.deliveryState = 'delivery_unknown'
        } else {
          task.providerTaskId = receipt.providerTaskId
          task.providerUrl = receipt.providerUrl
          if (task.identityEvidence !== 'provider_receipt') task.identityEvidence = receipt.evidence
          if (this.controlsDelivery(operation)) task.deliveryState = 'accepted'
          if (task.issue?.code !== IDENTITY_CONFLICT.code && this.controlsDelivery(operation)) task.issue = null
        }
      } else {
        operation.issue = result.issue ?? null
        if (this.controlsDelivery(operation) && task.deliveryState !== 'accepted') {
          task.deliveryState = result.state
          if (task.issue?.code !== IDENTITY_CONFLICT.code) task.issue = operation.issue
        }
      }
      operation.state = result.state
      operation.updatedAt = this.timestamp(operation.updatedAt)
      this.saveOperation(operation)
      this.touchTask(task)
      return this.action(this.requireOperation(id), false)
    })
  }

  updateTask(id: string, patch: Parameters<CloudTaskRepository['updateTask']>[1]): CloudTask {
    return this.transaction(() => {
      const task = this.requireTask(id)
      // Runtime whitelist as well as a type boundary: identity/prompt are immutable here.
      const { title, archivedAt, remoteState, rawState, observationState, lastObservedAt, providerUpdatedAt, issue } = patch
      const allowed = { title, archivedAt, remoteState, rawState, observationState, lastObservedAt, providerUpdatedAt, issue }
      Object.assign(task, Object.fromEntries(Object.entries(allowed).filter(([, value]) => value !== undefined)))
      this.touchTask(task)
      return this.requireTask(id)
    })
  }

  recoverAbandoned(staleAfterMs: number): number {
    if (!Number.isFinite(staleAfterMs) || staleAfterMs < 0) {
      throw new CloudTaskError(400, 'invalid_lease', 'Owner lease duration must be nonnegative and finite')
    }
    return this.transaction(() => {
      const abandoned = this.db.prepare(`SELECT op.data FROM cloud_operations op
        LEFT JOIN cloud_owners owner ON owner.id = op.owner_id
        WHERE op.state = 'dispatching' AND (owner.id IS NULL OR owner.heartbeat_at < ?)`)
        .all(this.now() - staleAfterMs)
      for (const row of abandoned) {
        const operation = decode<CloudOperation>(row)!
        operation.state = 'delivery_unknown'
        operation.issue = ABANDONED
        operation.updatedAt = this.timestamp(operation.updatedAt)
        this.saveOperation(operation)
        const task = this.requireTask(operation.taskId)
        if (this.controlsDelivery(operation) && task.deliveryState !== 'accepted') {
          task.deliveryState = 'delivery_unknown'
          if (task.issue?.code !== IDENTITY_CONFLICT.code) task.issue = ABANDONED
        }
        this.touchTask(task)
      }
      return abandoned.length
    })
  }

  releaseOwner(ownerId: string): void {
    this.assertOpen()
    // Explicit release makes this owner's in-flight work eligible for recovery, not replay.
    this.db.prepare('DELETE FROM cloud_owners WHERE id = ?').run(ownerId)
  }

  close(): void {
    if (this.closed) return
    this.db.close()
    this.closed = true
  }
}
