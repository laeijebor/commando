/**
 * Minimal app-server subset checked against codex-cli 0.159.3 bindings.
 * Regenerate reference bindings: codex app-server generate-ts --out /tmp/codex-ts
 * Incoming payloads remain unknown until checked: the experimental protocol can grow.
 */
export type RpcId = string | number
export type ApprovalPolicy = 'on-request' | 'never'
export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'
export type SandboxPolicy =
  | { type: 'readOnly'; networkAccess: boolean }
  | { type: 'dangerFullAccess' }
  | { type: 'workspaceWrite'; writableRoots: string[]; networkAccess: boolean; excludeTmpdirEnvVar: boolean; excludeSlashTmp: boolean }
export type UserInput = { type: 'text'; text: string; text_elements: [] } | { type: 'localImage'; path: string }
export interface ThreadSettings {
  cwd: string
  approvalPolicy: ApprovalPolicy
  approvalsReviewer: 'user'
  sandbox: SandboxMode
  model?: string
}
export interface ClientMethods {
  initialize: { clientInfo: { name: string; title: string; version: string }; capabilities: { experimentalApi: boolean; requestAttestation: boolean } }
  'model/list': { cursor?: string; limit?: number }
  'thread/start': ThreadSettings
  'thread/resume': ThreadSettings & { threadId: string }
  'thread/read': { threadId: string; includeTurns: boolean }
  'thread/turns/list': { threadId: string; cursor?: string; limit: number; sortDirection: 'asc' | 'desc'; itemsView: 'full' }
  'turn/start': { threadId: string; input: UserInput[]; model?: string; effort?: string | null; approvalPolicy: ApprovalPolicy; approvalsReviewer: 'user'; sandboxPolicy: SandboxPolicy }
  'turn/steer': { threadId: string; expectedTurnId: string; input: UserInput[] }
  'turn/interrupt': { threadId: string; turnId: string }
  'account/rateLimits/read': Record<string, never>
}
export interface RpcRequest { id: RpcId; method: string; params: unknown }
export interface RpcNotification { method: string; params: unknown }
export type ApprovalDecision = 'accept' | 'acceptForSession' | 'decline' | 'cancel'
export interface InputQuestion {
  id: string; header: string; question: string; isOther: boolean; isSecret: boolean
  options: { label: string; description: string }[] | null
}
export interface PermissionProfile {
  network?: { enabled: boolean | null } | null
  fileSystem?: { read: string[] | null; write: string[] | null; entries?: unknown[]; globScanMaxDepth?: number } | null
}
export interface ServerResults {
  'item/commandExecution/requestApproval': { decision: ApprovalDecision }
  'item/fileChange/requestApproval': { decision: ApprovalDecision }
  'item/permissions/requestApproval': { permissions: PermissionProfile; scope: 'turn' | 'session' }
  'item/tool/requestUserInput': { answers: Record<string, { answers: string[] }> }
}
export interface CodexModel {
  id: string; model: string; displayName: string; description: string; hidden: boolean; isDefault: boolean
  supportedReasoningEfforts: { reasoningEffort: string; description: string }[]
  defaultReasoningEffort: string
}
export interface FileChange { path: string; kind: { type: 'add' | 'delete' | 'update'; move_path?: string | null }; diff: string }
export interface CodexTurn { id: string; status: string; items: unknown[]; error?: { message: string } | null }
export interface CodexThread { id: string; name?: string | null; preview?: string; historyMode?: string; turns: CodexTurn[] }

export function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}
export function string(value: unknown): string | undefined { return typeof value === 'string' ? value : undefined }
export function list(value: unknown): unknown[] { return Array.isArray(value) ? value : [] }
export function rpcId(value: unknown): value is RpcId {
  return (typeof value === 'string' && value.length > 0) || (typeof value === 'number' && Number.isFinite(value))
}
export function requestKey(id: RpcId): string { return `${typeof id}:${id}` }
export function parseThread(value: unknown): CodexThread {
  const thread = record(value)
  if (!string(thread.id)) throw new Error('Codex returned a thread without an id')
  return { id: thread.id as string, name: string(thread.name), preview: string(thread.preview), historyMode: string(thread.historyMode), turns: list(thread.turns).flatMap((value) => {
    const turn = record(value)
    return string(turn.id) ? [{ id: turn.id as string, status: string(turn.status) ?? 'completed', items: list(turn.items), error: string(record(turn.error).message) ? { message: record(turn.error).message as string } : null }] : []
  }) }
}

/** Validate permission profiles before reflecting them back as a grant. */
export function parsePermissions(value: unknown): PermissionProfile | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const profile = record(value)
  const granted: PermissionProfile = {}
  if (profile.network != null) {
    const network = record(profile.network)
    if (network.enabled !== null && typeof network.enabled !== 'boolean') return undefined
    granted.network = { enabled: network.enabled as boolean | null }
  }
  if (profile.fileSystem != null) {
    const files = record(profile.fileSystem)
    const paths = (value: unknown): value is string[] | null => value === null || Array.isArray(value) && value.every((path) => typeof path === 'string')
    if (!paths(files.read) || !paths(files.write)) return undefined
    if (files.entries !== undefined && (!Array.isArray(files.entries) || files.entries.some((value) => {
      const entry = record(value)
      const path = record(entry.path)
      return !['read', 'write', 'deny'].includes(String(entry.access)) || !['path', 'glob_pattern', 'special'].includes(String(path.type))
        || path.type === 'path' && !string(path.path) || path.type === 'glob_pattern' && !string(path.pattern)
        || path.type === 'special' && !string(record(path.value).kind)
    }))) return undefined
    if (files.globScanMaxDepth !== undefined && (typeof files.globScanMaxDepth !== 'number' || !Number.isFinite(files.globScanMaxDepth) || files.globScanMaxDepth < 0)) return undefined
    granted.fileSystem = { read: files.read, write: files.write, ...(Array.isArray(files.entries) ? { entries: files.entries } : {}), ...(typeof files.globScanMaxDepth === 'number' ? { globScanMaxDepth: files.globScanMaxDepth } : {}) }
  }
  return granted
}
