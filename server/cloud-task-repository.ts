import type { CloudDeliveryState, CloudIssue, CloudOperation, CloudReceipt, CloudTask, CloudTaskAction, CloudTaskSummary } from '../shared/cloud-tasks.js'
export type CloudOperationResult = { state: Extract<CloudDeliveryState, 'accepted' | 'rejected' | 'delivery_unknown'>; receipt?: CloudReceipt; issue?: CloudIssue }
/** Synchronous transactions only: no process or network operations in this layer. */
export interface CloudTaskRepository {
  readonly installationId: string
  listTasks(includeArchived?: boolean): CloudTaskSummary[]
  getTask(id: string): CloudTask | undefined
  getOperation(id: string): CloudOperation | undefined
  getOperationByKey(key: string): CloudOperation | undefined
  operationsForTask(taskId: string): CloudOperation[]
  prepare(task: CloudTask, operation: CloudOperation): CloudTaskAction
  heartbeat(ownerId: string): void
  claimOperation(id: string, ownerId: string): boolean
  finishOperation(id: string, result: CloudOperationResult): CloudTaskAction
  updateTask(id: string, patch: Partial<Pick<CloudTask, 'title' | 'archivedAt' | 'remoteState' | 'rawState' | 'observationState' | 'lastObservedAt' | 'providerUpdatedAt' | 'issue'>>): CloudTask
  recoverAbandoned(staleAfterMs: number): number
  releaseOwner(ownerId: string): void
  close(): void
}
