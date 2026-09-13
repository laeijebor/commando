/** Provider-hosted work is deliberately independent of tmux sessions and panes. */
export type CloudProviderId = 'claude' | 'codex'
export type CloudRemoteState = 'unknown' | 'queued' | 'running' | 'needs_input' | 'result_ready' | 'failed' | 'cancelled'
export type CloudDeliveryState = 'prepared' | 'dispatching' | 'accepted' | 'rejected' | 'delivery_unknown'
export type CloudObservationState = 'unavailable' | 'fresh' | 'stale' | 'auth_required' | 'error'
export type CloudIssue = { code: string; message: string }
export type CloudSource = { repository?: string; environmentId?: string; branch?: string; checkoutPath?: string; commit?: string }
export type CloudProviderCapabilities = { create: boolean; link: boolean; list: boolean; inspect: boolean; sendMessage: boolean; diff: boolean; accountIdentity: boolean }
export type CloudProviderInfo = {
  id: CloudProviderId
  label: string
  homeUrl: string
  readiness: 'ready' | 'missing_cli' | 'unverified' | 'error'
  reason: string
  version: string | null
  credentialContextId: string
  verifiedAccountRef: string | null
  capabilities: CloudProviderCapabilities
}
export type CloudReceipt = { providerTaskId: string; providerUrl: string; evidence: 'provider_receipt' | 'user_link' }
export type CloudTask = {
  id: string
  provider: CloudProviderId
  credentialContextId: string
  verifiedAccountRef: string | null
  title: string
  prompt: string
  source: CloudSource
  origin?: { sessionId?: string; paneTargetId?: string; label?: string }
  providerTaskId: string | null
  providerUrl: string | null
  identityEvidence: CloudReceipt['evidence'] | null
  deliveryState: CloudDeliveryState
  remoteState: CloudRemoteState
  rawState: string | null
  observationState: CloudObservationState
  lastObservedAt: string | null
  providerUpdatedAt: string | null
  createdAt: string
  updatedAt: string
  revision: number
  archivedAt: string | null
  issue: CloudIssue | null
}
export type CloudTaskSummary = Omit<CloudTask, 'prompt'>
export type CloudCreateInput = { provider: CloudProviderId; credentialContextId: string; title?: string; prompt: string; source: CloudSource; accountConfirmed: boolean }
export type CloudLinkInput = { provider: CloudProviderId; credentialContextId: string; providerTaskId: string; title?: string; source?: CloudSource; accountConfirmed: boolean }
export type CloudMessageInput = { credentialContextId: string; message: string; accountConfirmed: boolean }
export type CloudResumeInput = { credentialContextId: string; accountConfirmed: boolean }
export type CloudOperation = {
  id: string
  taskId: string
  kind: 'create' | 'message' | 'link'
  idempotencyKey: string
  requestHash: string
  payload: CloudCreateInput | CloudLinkInput | CloudMessageInput
  state: CloudDeliveryState
  ownerId: string | null
  createdAt: string
  updatedAt: string
  receipt: CloudReceipt | null
  issue: CloudIssue | null
}
export type CloudTaskDetail = { task: CloudTask; operations: CloudOperation[] }
export type CloudTaskAction = { task: CloudTask; operation: CloudOperation; reused: boolean }
export type CloudProvidersResponse = { installationId: string; providers: CloudProviderInfo[] }
export type CloudDiff = { text: string; truncated: boolean }
export const CLOUD_PROMPT_LIMIT = 16_384
export const CLOUD_DIFF_BYTE_LIMIT = 256 * 1024
export const CLOUD_DIFF_LINE_LIMIT = 5_000
export function isCloudProvider(value: unknown): value is CloudProviderId { return value === 'claude' || value === 'codex' }
export function cloudProviderHome(provider: CloudProviderId): string { return provider === 'claude' ? 'https://claude.ai/code' : 'https://chatgpt.com/codex' }
/** Accept an ID, never an arbitrary URL or shell fragment. */
export function validCloudRemoteId(provider: CloudProviderId, id: unknown): id is string {
  return typeof id === 'string' && id.length <= 160 && (provider === 'claude' ? /^(session_|cse_)[A-Za-z0-9_-]+$/.test(id) : /^task_[A-Za-z0-9_-]+$/.test(id))
}
export function cloudTaskUrl(provider: CloudProviderId, id: string): string {
  if (!validCloudRemoteId(provider, id)) throw new Error('Invalid provider task ID')
  return provider === 'claude' ? `https://claude.ai/code/${id}` : `https://chatgpt.com/codex/tasks/${id}`
}
export function isSafeCloudUrl(provider: CloudProviderId, value: unknown): value is string {
  if (typeof value !== 'string') return false
  try {
    const url = new URL(value)
    if (url.username || url.password || url.protocol !== 'https:' || url.port) return false
    const prefix = provider === 'claude' ? '/code/' : '/codex/tasks/'
    return url.hostname === (provider === 'claude' ? 'claude.ai' : 'chatgpt.com') && url.pathname.startsWith(prefix) && validCloudRemoteId(provider, url.pathname.slice(prefix.length))
  } catch { return false }
}
/** Shared deterministic request encoding; hashes are computed by the caller. */
export function canonicalCloudRequest(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalCloudRequest).join(',')}]`
  if (value !== null && typeof value === 'object') return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonicalCloudRequest(v)}`).join(',')}}`
  return JSON.stringify(value) ?? 'null'
}
export function cloudTaskLabel(task: CloudTaskSummary): string {
  if (task.deliveryState === 'delivery_unknown') return 'Delivery unknown'
  if (task.deliveryState === 'prepared') return 'Recorded locally'
  if (task.deliveryState === 'dispatching') return 'Sending'
  if (task.deliveryState === 'rejected') return 'Not submitted'
  if (task.identityEvidence === 'user_link' && task.observationState !== 'fresh') return 'Linked · unverified'
  if (task.provider === 'claude') return 'Submitted · live status in Claude'
  return ({ unknown: 'Submitted · status unknown', queued: 'Queued', running: 'Working', needs_input: 'Needs input', result_ready: 'Result ready', failed: 'Failed', cancelled: 'Cancelled' })[task.remoteState]
}
