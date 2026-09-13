/** Synthetic service fixtures. No provider executable, credential, or network access. */
import { vi } from 'vitest'
import { cloudProviderHome, cloudTaskUrl, type CloudOperation, type CloudProviderId, type CloudProviderInfo, type CloudTask, type CloudTaskAction } from '../../shared/cloud-tasks.js'
import { CloudTaskError, type CloudDispatchResult, type CloudProviderAdapter } from '../cloud-provider.js'
import type { CloudOperationResult, CloudTaskRepository } from '../cloud-task-repository.js'

export function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

export function fakeProvider(id: CloudProviderId = 'codex') {
  const info: CloudProviderInfo = {
    id, label: id, homeUrl: cloudProviderHome(id), readiness: 'ready', reason: 'Synthetic fixture', version: 'synthetic-1',
    credentialContextId: 'fixture-context', verifiedAccountRef: 'fixture-account',
    capabilities: { create: true, link: true, list: true, inspect: true, sendMessage: true, diff: true, accountIdentity: true },
  }
  const receipt = (remoteId = id === 'codex' ? 'task_synthetic' : 'session_synthetic'): CloudDispatchResult => ({ state: 'accepted', receipt: { providerTaskId: remoteId, providerUrl: cloudTaskUrl(id, remoteId), evidence: 'provider_receipt' } })
  const adapter = {
    id,
    info: vi.fn(async () => structuredClone(info)),
    create: vi.fn<CloudProviderAdapter['create']>(async () => receipt()),
    sendMessage: vi.fn<CloudProviderAdapter['sendMessage']>(async (task) => receipt(task.providerTaskId!)),
    inspect: vi.fn<CloudProviderAdapter['inspect']>(async () => ({ remoteState: 'running', rawState: 'running' })),
    diff: vi.fn<CloudProviderAdapter['diff']>(async () => ({ text: '+synthetic change\n', truncated: false })),
  }
  return { adapter, info, receipt }
}

/** Minimal transactional double; durable SQLite behavior is tested separately with the real store. */
export class FakeCloudRepository implements CloudTaskRepository {
  readonly installationId = 'synthetic-installation'
  readonly tasks = new Map<string, CloudTask>()
  readonly operations = new Map<string, CloudOperation>()
  readonly owners = new Map<string, number>()
  readonly events: string[] = []
  constructor(private readonly now: () => number = Date.now) {}
  private clone<T>(value: T): T { return structuredClone(value) }
  listTasks(includeArchived = false) {
    return [...this.tasks.values()].filter((task) => includeArchived || !task.archivedAt).map((task) => {
      const { prompt: _prompt, ...summary } = this.clone(task)
      return summary
    })
  }
  getTask(id: string) { return this.clone(this.tasks.get(id)) }
  getOperation(id: string) { return this.clone(this.operations.get(id)) }
  getOperationByKey(key: string) { return this.clone([...this.operations.values()].find((operation) => operation.idempotencyKey === key)) }
  operationsForTask(id: string) { return this.clone([...this.operations.values()].filter((operation) => operation.taskId === id)) }
  prepare(task: CloudTask, operation: CloudOperation): CloudTaskAction {
    const previous = this.getOperationByKey(operation.idempotencyKey)
    if (previous) {
      if (previous.requestHash !== operation.requestHash) throw new CloudTaskError(409, 'idempotency_conflict', 'Different request')
      return { task: this.getTask(previous.taskId)!, operation: previous, reused: true }
    }
    this.events.push('prepare')
    if (!this.tasks.has(task.id)) this.tasks.set(task.id, this.clone(task))
    this.operations.set(operation.id, this.clone(operation))
    return { task: this.getTask(task.id)!, operation: this.getOperation(operation.id)!, reused: false }
  }
  heartbeat(id: string) { this.events.push('heartbeat'); this.owners.set(id, this.now()) }
  claimOperation(id: string, owner: string) {
    const operation = this.operations.get(id)
    if (!operation || operation.state !== 'prepared' || !this.owners.has(owner)) return false
    this.events.push('claim')
    operation.ownerId = owner
    operation.state = 'dispatching'
    if (operation.kind === 'create') this.tasks.get(operation.taskId)!.deliveryState = 'dispatching'
    return true
  }
  finishOperation(id: string, result: CloudOperationResult): CloudTaskAction {
    const operation = this.operations.get(id)!
    const task = this.tasks.get(operation.taskId)!
    this.events.push(`finish:${result.state}`)
    if (operation.state !== 'accepted') {
      if (result.receipt && task.providerTaskId && task.providerTaskId !== result.receipt.providerTaskId) {
        operation.issue = { code: 'identity_conflict', message: 'Synthetic conflicting late receipt' }
        operation.state = 'delivery_unknown'
        operation.receipt = this.clone(result.receipt)
      } else {
        operation.state = result.state
        operation.receipt = this.clone(result.receipt ?? null)
        operation.issue = this.clone(result.issue ?? null)
        if (result.receipt && operation.kind !== 'message') {
          task.providerTaskId = result.receipt.providerTaskId
          task.providerUrl = result.receipt.providerUrl
          task.identityEvidence = result.receipt.evidence
          task.deliveryState = 'accepted'
        } else if (operation.kind === 'create') task.deliveryState = result.state
      }
    }
    return { task: this.clone(task), operation: this.clone(operation), reused: false }
  }
  updateTask(id: string, patch: Parameters<CloudTaskRepository['updateTask']>[1]) {
    const task = this.tasks.get(id)!
    Object.assign(task, this.clone(patch), { revision: task.revision + 1 })
    return this.clone(task)
  }
  recoverAbandoned(staleAfterMs: number) {
    let count = 0
    for (const operation of this.operations.values()) {
      const last = this.owners.get(operation.ownerId ?? '')
      if (operation.state === 'dispatching' && (last === undefined || this.now() - last > staleAfterMs)) {
        this.finishOperation(operation.id, { state: 'delivery_unknown' })
        count++
      }
    }
    return count
  }
  releaseOwner(id: string) { this.events.push('release'); this.owners.delete(id) }
  close() { this.events.push('close') }
}
