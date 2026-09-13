import type { CloudCreateInput, CloudDiff, CloudIssue, CloudProviderId, CloudProviderInfo, CloudReceipt, CloudRemoteState, CloudTask } from '../shared/cloud-tasks.js'
export type CloudCliRequest = { executable: string; args: string[]; cwd?: string; timeoutMs?: number; maxOutputBytes?: number; signal?: AbortSignal; stdin?: string }
export type CloudCliResult = { stdout: string; stderr: string; exitCode: number | null; signal: string | null; spawned: boolean; timedOut: boolean; truncated: boolean }
export type CloudCliRunner = (request: CloudCliRequest) => Promise<CloudCliResult>
export type CloudDispatchResult = { state: 'accepted'; receipt: CloudReceipt } | { state: 'rejected' | 'delivery_unknown'; issue: CloudIssue }
export type CloudInspection = { remoteState: CloudRemoteState; rawState: string; updatedAt?: string }
export interface CloudProviderAdapter {
  readonly id: CloudProviderId
  info(): Promise<CloudProviderInfo>
  create(input: CloudCreateInput, signal?: AbortSignal): Promise<CloudDispatchResult>
  sendMessage(task: CloudTask, message: string, signal?: AbortSignal): Promise<CloudDispatchResult>
  inspect(task: CloudTask, signal?: AbortSignal): Promise<CloudInspection>
  diff(task: CloudTask, signal?: AbortSignal): Promise<CloudDiff>
}
export class CloudTaskError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message) }
}
