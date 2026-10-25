import { createHash, randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'
import {
  CLOUD_DIFF_BYTE_LIMIT, CLOUD_DIFF_LINE_LIMIT, CLOUD_PROMPT_LIMIT,
  canonicalCloudRequest, cloudConnectionKey, cloudProviderHome, cloudTaskUrl, isCloudProvider, validCloudRemoteId,
  type CloudCreateInput, type CloudDiff,
} from '../shared/cloud-tasks.js'
import type {
  CloudIssue, CloudLinkInput, CloudMessageInput, CloudOperation, CloudProviderId, CloudProviderInfo,
  CloudProvidersResponse, CloudReceipt, CloudResumeInput, CloudSource, CloudTask, CloudTaskAction, CloudTaskDetail,
} from '../shared/cloud-tasks.js'
import { CloudTaskError, type CloudInspection, type CloudProviderAdapter } from './cloud-provider.js'
import type { CloudTaskRepository } from './cloud-task-repository.js'

const LEASE_MS = 30_000
const HEARTBEAT_MS = 5_000
const OBSERVATION_TTL_MS = 30_000
const PROBE_TIMEOUT_MS = 10_000
const READ_TIMEOUT_MS = 20_000
const DISPATCH_TIMEOUT_MS = 120_000
const STOP_GRACE_MS = 2_000
const READ_QUEUE_LIMIT = 16
const CACHE_LIMIT = 256

type QueuedRead = { run: () => void; cancel: () => void }
type ConfiguredConnection = Readonly<{ id: CloudProviderId; credentialContextId: string; label: string; adapter: CloudProviderAdapter }>

/** Only service-owned text is exposed, never an adapter exception or process diagnostic. */
const ISSUES: Record<string, string> = {
  provider_unavailable: 'The provider is unavailable. Check its local configuration.',
  capability_unavailable: 'This action is not verified for the configured provider.',
  auth_required: 'Sign in using the provider application, then try again.',
  account_mismatch: 'The provider account changed. Reconfirm the destination before continuing.',
  account_confirmation_required: 'Confirm the current provider account before continuing.',
  context_mismatch: 'The configured provider context differs from this task.',
  source_changed: 'The source changed after confirmation. Review and submit a new intent.',
  source_unverified: 'The provider cannot verify a safe source for this request.',
  invalid_receipt: 'The provider did not return a valid matching task receipt. Check the provider before retrying.',
  delivery_unknown: 'Delivery is unknown. Check the provider before retrying.',
  dispatch_rejected: 'The provider rejected this request before delivery.',
  observation_failed: 'Refresh failed. The saved task is retained.',
  service_stopped: 'The local dispatcher stopped. Check the provider before retrying.',
  rate_limited: 'The provider is busy. Try again later.',
}

function issue(code: string): CloudIssue { return { code, message: ISSUES[code] ?? ISSUES.provider_unavailable } }
function fail(status: number, code: string): never { throw new CloudTaskError(status, code, issue(code).message) }
function invalid(message: string): never { throw new CloudTaskError(400, 'invalid_request', message) }
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('Expected an object')
  const record = value as Record<string, unknown>
  if (Object.keys(record).some((key) => !keys.includes(key))) invalid('Unexpected request field')
  return record
}
function text(value: unknown, name: string, max: number, multiline = false): string {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > max
    || (multiline ? /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/ : /[\x00-\x1f\x7f]/).test(value)) invalid(`Invalid ${name}`)
  return value
}
function confirmed(value: unknown): boolean {
  if (typeof value !== 'boolean') invalid('accountConfirmed must be a boolean')
  return value
}
function contextId(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.:-]{1,256}$/.test(value)) invalid('A valid credentialContextId is required')
  return value
}
function resumeInput(value: unknown): CloudResumeInput {
  const record = object(value, ['credentialContextId', 'accountConfirmed'])
  return { credentialContextId: contextId(record.credentialContextId), accountConfirmed: confirmed(record.accountConfirmed) }
}
function source(value: unknown): CloudSource {
  const record = object(value, ['repository', 'environmentId', 'branch', 'checkoutPath', 'commit'])
  const result: CloudSource = {}
  for (const key of ['repository', 'environmentId', 'branch', 'checkoutPath', 'commit'] as const) {
    if (record[key] === undefined) continue
    const field = text(record[key], key, key === 'checkoutPath' ? 4096 : 256)
    if (key === 'repository' && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(field)) invalid('Repository must be owner/name')
    if (key === 'environmentId' && !/^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/.test(field)) invalid('Invalid environment ID')
    if (key === 'branch' && (field.startsWith('-') || /[\s~^:?*\[\\]/.test(field) || field.includes('..') || field.includes('@{'))) invalid('Invalid branch')
    if (key === 'checkoutPath' && !isAbsolute(field)) invalid('Checkout path must be absolute')
    if (key === 'commit' && !/^[a-fA-F0-9]{7,64}$/.test(field)) invalid('Invalid commit')
    result[key] = field
  }
  return result
}
function createInput(value: unknown): CloudCreateInput {
  const record = object(value, ['provider', 'credentialContextId', 'title', 'prompt', 'source', 'accountConfirmed'])
  if (!isCloudProvider(record.provider)) invalid('Invalid provider')
  const input: CloudCreateInput = {
    provider: record.provider, prompt: text(record.prompt, 'prompt', CLOUD_PROMPT_LIMIT, true),
    source: source(record.source), credentialContextId: contextId(record.credentialContextId), accountConfirmed: confirmed(record.accountConfirmed),
  }
  if (record.title !== undefined) input.title = text(record.title, 'title', 256)
  if (input.provider === 'codex' && (!input.source.environmentId || !input.source.branch)) invalid('Codex requires an environment and branch')
  if (input.provider === 'claude' && !input.source.checkoutPath) invalid('Claude requires a checkout path')
  return input
}
function linkInput(value: unknown): CloudLinkInput {
  const record = object(value, ['provider', 'credentialContextId', 'providerTaskId', 'title', 'source', 'accountConfirmed'])
  if (!isCloudProvider(record.provider) || !validCloudRemoteId(record.provider, record.providerTaskId)) invalid('Invalid provider task ID')
  const input: CloudLinkInput = { provider: record.provider, credentialContextId: contextId(record.credentialContextId), providerTaskId: record.providerTaskId, accountConfirmed: confirmed(record.accountConfirmed) }
  if (record.title !== undefined) input.title = text(record.title, 'title', 256)
  if (record.source !== undefined) input.source = source(record.source)
  return input
}
function messageInput(value: unknown): CloudMessageInput {
  const record = object(value, ['credentialContextId', 'message', 'accountConfirmed'])
  return { credentialContextId: contextId(record.credentialContextId), message: text(record.message, 'message', CLOUD_PROMPT_LIMIT, true), accountConfirmed: confirmed(record.accountConfirmed) }
}
function localId(value: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(value)) invalid('Invalid local ID')
  return value
}
function keyValue(value: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(value)) invalid('A valid Idempotency-Key is required')
  return value
}
function providerIssue(error: unknown, fallback: string): CloudIssue {
  const code = error instanceof CloudTaskError && Object.hasOwn(ISSUES, error.code) ? error.code : fallback
  return issue(code)
}
async function bounded<T>(promise: Promise<T>, ms: number, expire?: () => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => { expire?.(); reject(new Error('Timed out')) }, ms)
      timer.unref()
    })])
  } finally { clearTimeout(timer) }
}
function receiptFor(task: CloudTask, value: CloudReceipt, expectedId?: string): CloudReceipt {
  if (!value || value.evidence !== 'provider_receipt' || !validCloudRemoteId(task.provider, value.providerTaskId)
    || value.providerUrl !== cloudTaskUrl(task.provider, value.providerTaskId)
    || (expectedId !== undefined && value.providerTaskId !== expectedId)) fail(502, 'invalid_receipt')
  return { providerTaskId: value.providerTaskId, providerUrl: value.providerUrl, evidence: 'provider_receipt' }
}
function inspectionPatch(value: CloudInspection): Pick<CloudTask, 'remoteState' | 'rawState' | 'providerUpdatedAt'> {
  if (!value || !['unknown', 'queued', 'running', 'needs_input', 'result_ready', 'failed', 'cancelled'].includes(value.remoteState)
    || typeof value.rawState !== 'string' || Buffer.byteLength(value.rawState) > 160 || !/^[A-Za-z0-9 _.-]*$/.test(value.rawState)
    || (value.updatedAt !== undefined && (typeof value.updatedAt !== 'string' || value.updatedAt.length > 40 || !Number.isFinite(Date.parse(value.updatedAt))))) {
    fail(502, 'observation_failed')
  }
  return { remoteState: value.remoteState, rawState: value.rawState, providerUpdatedAt: value.updatedAt ?? null }
}
function boundedDiff(diff: CloudDiff): CloudDiff {
  if (!diff || typeof diff.text !== 'string' || typeof diff.truncated !== 'boolean') fail(502, 'observation_failed')
  const bytes = Buffer.from(diff.text)
  const text = bytes.subarray(0, CLOUD_DIFF_BYTE_LIMIT).toString('utf8').replace(/\uFFFD$/, '')
  const lines = text.split('\n')
  return { text: lines.slice(0, CLOUD_DIFF_LINE_LIMIT).join('\n'), truncated: diff.truncated || bytes.length > CLOUD_DIFF_BYTE_LIMIT || lines.length > CLOUD_DIFF_LINE_LIMIT }
}

export type CloudTaskServiceOptions = { store: CloudTaskRepository; providers: CloudProviderAdapter[]; now?: () => number }

export class CloudTaskService {
  private readonly store: CloudTaskRepository
  private readonly providers: Map<string, ConfiguredConnection>
  private readonly now: () => number
  private readonly ownerId = randomUUID()
  private readonly heartbeatTimer: ReturnType<typeof setInterval>
  private stopped = false
  private stopping: Promise<void> | undefined
  private readonly settlements = new Set<Promise<unknown>>()
  private readonly scheduled = new Map<string, ReturnType<typeof setImmediate>>()
  private readonly dispatches = new Map<string, AbortController>()
  private readonly readers = new Set<AbortController>()
  private readonly observations = new Map<string, Promise<CloudTaskDetail>>()
  private readonly diffs = new Map<string, Promise<CloudDiff>>()
  private readonly diffCache = new Map<string, { at: number; value: CloudDiff }>()
  private readonly connectionReads = new Set<string>()
  private readonly readQueues = new Map<string, QueuedRead[]>()
  private readonly observedAt = new Map<string, number>()

  constructor({ store, providers, now = Date.now }: CloudTaskServiceOptions) {
    this.store = store
    this.now = now
    this.providers = new Map()
    for (const adapter of providers) {
      if (!isCloudProvider(adapter.id)) throw new Error('Invalid cloud provider')
      const credentialContextId = contextId(adapter.credentialContextId)
      const key = cloudConnectionKey(adapter.id, credentialContextId)
      if (this.providers.has(key)) throw new Error('Duplicate cloud provider connection')
      const label = typeof adapter.label === 'string' && adapter.label.trim() && Buffer.byteLength(adapter.label) <= 128 && !/[\x00-\x1f\x7f]/.test(adapter.label)
        ? adapter.label : adapter.id === 'claude' ? 'Claude' : 'Codex'
      // Snapshot the configured namespace and label; discovery can never rebind it.
      this.providers.set(key, Object.freeze({ id: adapter.id, credentialContextId, label, adapter }))
    }
    // Recovery marks abandoned work unknown; it never claims or replays prepared intents.
    store.heartbeat(this.ownerId)
    store.recoverAbandoned(LEASE_MS)
    this.heartbeatTimer = setInterval(() => {
      try { store.heartbeat(this.ownerId); store.recoverAbandoned(LEASE_MS) }
      catch { void this.stop().catch(() => { /* journal unavailable; next startup performs lease recovery */ }) }
    }, HEARTBEAT_MS)
    this.heartbeatTimer.unref()
  }

  private active(): void { if (this.stopped) fail(503, 'service_stopped') }
  private track<T>(promise: Promise<T>): Promise<T> {
    this.settlements.add(promise)
    void promise.then(() => this.settlements.delete(promise), () => this.settlements.delete(promise))
    return promise
  }
  private timestamp(): string { return new Date(this.now()).toISOString() }
  private connection(provider: CloudProviderId, credentialContextId: string): ConfiguredConnection {
    const connection = this.providers.get(cloudConnectionKey(provider, credentialContextId))
    if (!connection || connection.adapter.id !== connection.id || connection.adapter.credentialContextId !== connection.credentialContextId) fail(409, 'context_mismatch')
    return connection
  }
  private adapter(provider: CloudProviderId, credentialContextId: string): CloudProviderAdapter {
    return this.connection(provider, credentialContextId).adapter
  }
  private async info(connection: ConfiguredConnection): Promise<CloudProviderInfo> {
    try {
      this.active()
      const adapter = this.adapter(connection.id, connection.credentialContextId)
      const value = await bounded(this.track(adapter.info()), PROBE_TIMEOUT_MS)
      this.connection(connection.id, connection.credentialContextId)
      if (!value || value.id !== connection.id || !['ready', 'missing_cli', 'unverified', 'error'].includes(value.readiness)
        || typeof value.credentialContextId !== 'string' || !/^[A-Za-z0-9_.:-]{1,256}$/.test(value.credentialContextId)
        || (value.verifiedAccountRef !== null && (typeof value.verifiedAccountRef !== 'string' || !/^[^\x00-\x1f\x7f]{1,256}$/.test(value.verifiedAccountRef)))
        || !value.capabilities || ['create', 'link', 'list', 'inspect', 'sendMessage', 'diff', 'accountIdentity'].some((key) => typeof value.capabilities[key as keyof typeof value.capabilities] !== 'boolean')) fail(503, 'provider_unavailable')
      if (value.credentialContextId !== connection.credentialContextId) fail(409, 'context_mismatch')
      return {
        id: connection.id, label: connection.label, homeUrl: cloudProviderHome(connection.id),
        readiness: value.readiness, reason: this.readinessReason(value),
        version: typeof value.version === 'string' && /^[A-Za-z0-9_.+ -]{1,80}$/.test(value.version) ? value.version : null,
        credentialContextId: connection.credentialContextId, verifiedAccountRef: value.capabilities.accountIdentity ? value.verifiedAccountRef : null,
        capabilities: Object.fromEntries(Object.entries(value.capabilities).filter(([key]) => ['create', 'link', 'list', 'inspect', 'sendMessage', 'diff', 'accountIdentity'].includes(key))) as CloudProviderInfo['capabilities'],
      }
    } catch (error) {
      if (error instanceof CloudTaskError && error.code === 'context_mismatch') throw error
      fail(503, 'provider_unavailable')
    }
  }
  private readinessReason(info: CloudProviderInfo): string {
    const readiness = info.readiness === 'ready' ? 'The CLI matches its locally verified version.'
      : info.readiness === 'missing_cli' ? 'The configured CLI is not installed.'
      : info.readiness === 'unverified' ? 'The installed CLI version requires local capability verification.'
      : ISSUES.provider_unavailable
    // Synthesize precise capability explanations instead of reflecting diagnostic text
    // from an injected adapter. Source safety is independent of CLI version readiness.
    const creation = info.id === 'claude' && !info.capabilities.create
      ? ' Claude creation is disabled: no verified enforceable no-bundle source-selection path is available. Create in Claude, then link the session here.' : ''
    const followUp = info.id === 'claude' && info.capabilities.sendMessage
      ? ' Cloud follow-up is enabled for the verified CLI version.' : ''
    const account = !info.capabilities.accountIdentity || info.verifiedAccountRef === null
      ? ' Account identity is unverified; confirm the current provider account before each submission, message, or link.' : ''
    return readiness + creation + followUp + account
  }
  private async ready(provider: CloudProviderId, capability: 'create' | 'link' | 'sendMessage' | 'inspect' | 'diff', accountConfirmed: boolean, task?: CloudTask, expectedContextId?: string): Promise<CloudProviderInfo> {
    this.active()
    if (task && expectedContextId !== undefined && expectedContextId !== task.credentialContextId) fail(409, 'context_mismatch')
    const info = await this.info(this.connection(provider, contextId(expectedContextId ?? task?.credentialContextId)))
    this.active()
    if (expectedContextId !== undefined && info.credentialContextId !== expectedContextId) fail(409, 'context_mismatch')
    // Linking is local and can remain available without a verified mutation CLI.
    if (!info.capabilities[capability] || (capability !== 'link' && info.readiness !== 'ready')) fail(409, 'capability_unavailable')
    if (task && info.credentialContextId !== task.credentialContextId) fail(409, 'context_mismatch')
    if (task && info.verifiedAccountRef !== task.verifiedAccountRef) fail(409, 'account_mismatch')
    if (['create', 'link', 'sendMessage'].includes(capability) && info.verifiedAccountRef === null && !accountConfirmed) fail(409, 'account_confirmation_required')
    return info
  }
  async listProviders(): Promise<CloudProvidersResponse> {
    const providers = await Promise.all([...this.providers.values()].map(async (connection): Promise<CloudProviderInfo> => {
      try { return await this.info(connection) } catch {
        return { id: connection.id, label: connection.label, homeUrl: cloudProviderHome(connection.id), readiness: 'error', reason: ISSUES.provider_unavailable, version: null, credentialContextId: connection.credentialContextId, verifiedAccountRef: null, capabilities: { create: false, link: false, list: false, inspect: false, sendMessage: false, diff: false, accountIdentity: false } }
      }
    }))
    return { installationId: this.store.installationId, providers }
  }
  listTasks(includeArchived = true) { return this.store.listTasks(includeArchived).map(({ ...task }) => { delete (task as Partial<CloudTask>).prompt; return task }) }
  getTask(id: string): CloudTaskDetail {
    const task = this.store.getTask(localId(id))
    if (!task) throw new CloudTaskError(404, 'task_not_found', 'Cloud task not found')
    return { task, operations: this.store.operationsForTask(id) }
  }
  getOperation(id: string): CloudOperation {
    const operation = this.store.getOperation(localId(id))
    if (!operation) throw new CloudTaskError(404, 'operation_not_found', 'Cloud operation not found')
    return operation
  }
  getOperationByKey(key: string): CloudOperation {
    const operation = this.store.getOperationByKey(keyValue(key))
    if (!operation) throw new CloudTaskError(404, 'operation_not_found', 'Cloud operation not found')
    return operation
  }
  private intent(kind: CloudOperation['kind'], payload: CloudOperation['payload'], key: string, target: string | null): { hash: string; reused?: CloudTaskAction } {
    keyValue(key)
    const hash = createHash('sha256').update(canonicalCloudRequest({ kind, taskId: target, payload })).digest('hex')
    const operation = this.store.getOperationByKey(key)
    if (!operation) return { hash }
    if (operation.requestHash !== hash || operation.kind !== kind || (target !== null && operation.taskId !== target)) throw new CloudTaskError(409, 'idempotency_conflict', 'Idempotency key belongs to a different request')
    return { hash, reused: { task: this.getTask(operation.taskId).task, operation, reused: true } }
  }
  private newTask(input: CloudCreateInput | CloudLinkInput, info: CloudProviderInfo): CloudTask {
    const timestamp = this.timestamp()
    return { id: randomUUID(), provider: input.provider, credentialContextId: input.credentialContextId, verifiedAccountRef: info.verifiedAccountRef, title: input.title ?? 'Cloud task', prompt: 'prompt' in input ? input.prompt : '', source: input.source ?? {}, providerTaskId: null, providerUrl: null, identityEvidence: null, deliveryState: 'prepared', remoteState: 'unknown', rawState: null, observationState: 'unavailable', lastObservedAt: null, providerUpdatedAt: null, createdAt: timestamp, updatedAt: timestamp, revision: 0, archivedAt: null, issue: null }
  }
  private prepare(task: CloudTask, kind: CloudOperation['kind'], payload: CloudOperation['payload'], key: string, hash: string): CloudTaskAction {
    this.active()
    const timestamp = this.timestamp()
    const action = this.store.prepare(task, { id: randomUUID(), taskId: task.id, kind, payload, idempotencyKey: key, requestHash: hash, state: 'prepared', ownerId: null, createdAt: timestamp, updatedAt: timestamp, receipt: null, issue: null })
    if (!action.reused) this.schedule(action.operation.id)
    return action
  }
  private schedule(id: string, confirmation?: CloudResumeInput): void {
    this.active()
    if (this.scheduled.has(id)) return
    // HTTP's continuation writes 202 before this next-turn dispatcher can run.
    const immediate = setImmediate(() => {
      this.scheduled.delete(id)
      void this.track(this.dispatch(id, confirmation)).catch(() => { /* durable dispatching is recovered by owner lease */ })
    })
    this.scheduled.set(id, immediate)
  }
  async createTask(value: unknown, key: string): Promise<CloudTaskAction> {
    const input = createInput(value)
    const intent = this.intent('create', input, key, null)
    if (intent.reused) return intent.reused
    const info = await this.ready(input.provider, 'create', input.accountConfirmed, undefined, input.credentialContextId)
    return this.prepare(this.newTask(input, info), 'create', input, key, intent.hash)
  }
  async linkTask(value: unknown, key: string, taskId?: string): Promise<CloudTaskAction> {
    const input = linkInput(value)
    const intent = this.intent('link', input, key, taskId === undefined ? null : localId(taskId))
    if (intent.reused) return intent.reused
    const task = taskId === undefined ? undefined : this.getTask(taskId).task
    if (task) this.assertRecovery(task, input)
    const info = await this.ready(input.provider, 'link', input.accountConfirmed, task, input.credentialContextId)
    return this.prepare(task ?? this.newTask(input, info), 'link', input, key, intent.hash)
  }
  private assertRecovery(task: CloudTask, input: CloudLinkInput): void {
    if (task.provider !== input.provider || task.providerTaskId !== null || !this.store.operationsForTask(task.id).some((operation) => operation.kind === 'create' && operation.state === 'delivery_unknown')) {
      throw new CloudTaskError(409, 'invalid_recovery', 'Only an uncertain creation without a known identity can be linked')
    }
  }
  async sendMessage(taskId: string, value: unknown, key: string): Promise<CloudTaskAction> {
    const input = messageInput(value)
    const intent = this.intent('message', input, key, localId(taskId))
    if (intent.reused) return intent.reused
    const task = this.getTask(taskId).task
    if (!task.providerTaskId) throw new CloudTaskError(409, 'task_unlinked', 'A provider task identity is required')
    await this.ready(task.provider, 'sendMessage', input.accountConfirmed, task, input.credentialContextId)
    return this.prepare(task, 'message', input, key, intent.hash)
  }
  private preparedForResume(id: string): CloudOperation {
    const operation = this.getOperation(id)
    if (operation.state !== 'prepared' || operation.ownerId !== null || operation.receipt !== null) {
      throw new CloudTaskError(409, 'operation_not_prepared', 'Only an unclaimed, receipt-free prepared operation can be explicitly dispatched')
    }
    return operation
  }
  async resumeOperation(id: string, value: unknown): Promise<CloudTaskAction> {
    this.active()
    const confirmation = resumeInput(value)
    const operation = this.preparedForResume(id)
    const task = this.getTask(operation.taskId).task
    // Revalidate the immutable intent; fresh confirmation cannot replace its source or context.
    const payload = operation.kind === 'create' ? createInput(operation.payload)
      : operation.kind === 'link' ? linkInput(operation.payload) : messageInput(operation.payload)
    if ('provider' in payload && payload.provider !== task.provider) fail(409, 'context_mismatch')
    if (confirmation.credentialContextId !== payload.credentialContextId) fail(409, 'context_mismatch')
    if ((operation.kind === 'create' && task.providerTaskId !== null) || (operation.kind === 'message' && !task.providerTaskId)) {
      throw new CloudTaskError(409, 'operation_not_prepared', 'The saved task identity is incompatible with this prepared operation')
    }
    if (operation.kind === 'link' && this.store.operationsForTask(task.id).some((entry) => entry.kind === 'create')) this.assertRecovery(task, payload as CloudLinkInput)
    await this.ready(task.provider, operation.kind === 'message' ? 'sendMessage' : operation.kind, confirmation.accountConfirmed, task, confirmation.credentialContextId)
    const current = this.preparedForResume(id)
    this.schedule(id, confirmation)
    return { task: this.getTask(task.id).task, operation: current, reused: true }
  }
  private async dispatch(id: string, confirmation?: CloudResumeInput): Promise<void> {
    if (this.stopped) return
    this.store.heartbeat(this.ownerId)
    if (!this.store.claimOperation(id, this.ownerId)) return
    const controller = new AbortController()
    this.dispatches.set(id, controller)
    let invoked = false
    let localLink = false
    let knownReceipt: CloudReceipt | undefined
    try {
      const operation = this.getOperation(id)
      const task = this.getTask(operation.taskId).task
      const capability = operation.kind === 'message' ? 'sendMessage' : operation.kind
      const expectedContext = contextId(operation.payload.credentialContextId)
      if (confirmation && confirmation.credentialContextId !== expectedContext) fail(409, 'context_mismatch')
      const accountConfirmed = confirmation?.accountConfirmed ?? operation.payload.accountConfirmed
      const info = await this.ready(task.provider, capability, accountConfirmed, task, expectedContext)
      if (controller.signal.aborted) return
      // A second runtime may have recovered our lease while discovery was pending.
      // An abandoned operation is never permission to start a new remote attempt.
      const current = this.store.getOperation(id)
      if (current?.state !== 'dispatching' || current.ownerId !== this.ownerId) return
      this.store.heartbeat(this.ownerId)
      const adapter = this.adapter(task.provider, task.credentialContextId)
      if (operation.kind === 'link') {
        localLink = true
        const input = operation.payload as CloudLinkInput
        // Recheck a recovery that could have raced a late creation receipt.
        if (this.store.operationsForTask(task.id).some((entry) => entry.kind === 'create')) this.assertRecovery(task, input)
        const receipt: CloudReceipt = { providerTaskId: input.providerTaskId, providerUrl: cloudTaskUrl(task.provider, input.providerTaskId), evidence: 'user_link' }
        if (this.stopped) return
        // Explicit confirmation records local identity even if a bounded listing misses it.
        knownReceipt = receipt
        const linkedTask = this.store.finishOperation(id, { state: 'accepted', receipt }).task
        if (info.capabilities.inspect && linkedTask.providerTaskId === receipt.providerTaskId) {
          let patch: Parameters<CloudTaskRepository['updateTask']>[1]
          try {
            const observation = await bounded(this.track(adapter.inspect(linkedTask, controller.signal)), READ_TIMEOUT_MS, () => controller.abort())
            patch = { ...inspectionPatch(observation), observationState: 'fresh', lastObservedAt: this.timestamp(), issue: null }
          } catch (error) {
            patch = { remoteState: 'unknown', rawState: null, providerUpdatedAt: null, lastObservedAt: null, observationState: 'unavailable', issue: providerIssue(error, 'observation_failed') }
          }
          if (!this.stopped) this.store.updateTask(task.id, { ...patch, issue: this.identityConflict(task.id) ?? patch.issue })
        }
        return
      }
      invoked = true
      const pending = operation.kind === 'create'
        ? adapter.create({ ...structuredClone(operation.payload as CloudCreateInput), accountConfirmed }, controller.signal)
        : adapter.sendMessage(structuredClone(task), (operation.payload as CloudMessageInput).message, controller.signal)
      // A late valid receipt remains evidence even after timeout/stop; repository reconciles conflicts.
      const resultPromise = this.track(pending.then((result) => {
        if ('receipt' in result && result.receipt) {
          const receipt = receiptFor(task, result.receipt, operation.kind === 'message' ? task.providerTaskId ?? undefined : undefined)
          knownReceipt = receipt
          this.store.finishOperation(id, { state: 'accepted', receipt })
          return true
        }
        return result
      }))
      const result = await bounded(resultPromise, DISPATCH_TIMEOUT_MS, () => controller.abort())
      if (result === true) return
      if (!this.stopped) {
        const fallback = result.state === 'rejected' ? 'dispatch_rejected' : 'delivery_unknown'
        const code = 'issue' in result && result.issue && Object.hasOwn(ISSUES, result.issue.code) ? result.issue.code : fallback
        this.store.finishOperation(id, { state: result.state === 'rejected' ? 'rejected' : 'delivery_unknown', issue: issue(code) })
      }
    } catch (error) {
      // A receipt remains authoritative if writing it failed, including a commit
      // that succeeded but reported failure. A second transactional write is safe.
      if (knownReceipt) { this.store.finishOperation(id, { state: 'accepted', receipt: knownReceipt }); return }
      if (this.stopped) return
      // If acceptance was persisted before a later local error, never downgrade it.
      const operation = this.store.getOperation(id)
      if (operation && operation.state !== 'accepted' && !this.stopped) this.store.finishOperation(id, {
        state: invoked && !localLink ? 'delivery_unknown' : 'rejected',
        issue: providerIssue(error, invoked ? 'delivery_unknown' : 'provider_unavailable'),
      })
    } finally { this.dispatches.delete(id) }
  }
  updateTask(id: string, value: unknown): CloudTaskDetail {
    this.active()
    const record = object(value, ['title', 'archived', 'archivedAt'])
    const patch: { title?: string; archivedAt?: string | null } = {}
    if (record.title !== undefined) patch.title = text(record.title, 'title', 256)
    if (record.archived !== undefined) {
      if (typeof record.archived !== 'boolean') invalid('archived must be a boolean')
      patch.archivedAt = record.archived ? this.timestamp() : null
    }
    if (record.archivedAt !== undefined) {
      if (record.archived !== undefined) invalid('Use either archived or archivedAt')
      if (record.archivedAt !== null && (typeof record.archivedAt !== 'string' || record.archivedAt.length > 40 || !Number.isFinite(Date.parse(record.archivedAt)))) invalid('Invalid archive timestamp')
      patch.archivedAt = record.archivedAt === null ? null : new Date(record.archivedAt as string).toISOString()
    }
    if (!Object.keys(patch).length) invalid('A title or archived value is required')
    this.getTask(id)
    this.store.updateTask(id, patch)
    return this.getTask(id)
  }
  private recent(at: number | undefined): boolean { return at !== undefined && this.now() >= at && this.now() - at < OBSERVATION_TTL_MS }
  private trim<T>(map: Map<string, T>): void { while (map.size > CACHE_LIMIT) map.delete(map.keys().next().value!) }
  private queueRead<T>(connection: string, work: () => Promise<T>): Promise<T> {
    this.active()
    const queue = this.readQueues.get(connection) ?? []
    if (queue.length >= READ_QUEUE_LIMIT) return Promise.reject(new CloudTaskError(429, 'rate_limited', ISSUES.rate_limited))
    const pending = new Promise<T>((resolve, reject) => {
      queue.push({
        cancel: () => reject(new CloudTaskError(503, 'service_stopped', ISSUES.service_stopped)),
        run: () => {
          this.connectionReads.add(connection)
          const job = (async () => {
            try { this.active(); resolve(await work()) }
            catch (error) { reject(error) }
            finally { this.connectionReads.delete(connection); this.pumpReads(connection) }
          })()
          this.track(job)
        },
      })
    })
    this.readQueues.set(connection, queue)
    this.pumpReads(connection)
    return this.track(pending)
  }
  private pumpReads(connection: string): void {
    if (this.stopped || this.connectionReads.has(connection)) return
    const queue = this.readQueues.get(connection)
    const next = queue?.shift()
    if (!queue?.length) this.readQueues.delete(connection)
    next?.run()
  }
  refreshTask(id: string): Promise<CloudTaskDetail> {
    this.active()
    const cached = this.getTask(id)
    const task = cached.task
    const connection = cloudConnectionKey(task.provider, task.credentialContextId)
    const cacheKey = `${connection}/${id}`
    const existing = this.observations.get(cacheKey)
    if (existing) return existing
    if (!task.providerTaskId || this.recent(this.observedAt.get(cacheKey))) return Promise.resolve(cached)
    const controller = new AbortController()
    this.readers.add(controller)
    const pending = this.track((async () => {
      try {
        await this.queueRead(connection, async () => {
          try {
            await this.ready(task.provider, 'inspect', false, task)
            this.active()
            const observation = await bounded(this.track(this.adapter(task.provider, task.credentialContextId).inspect(structuredClone(task), controller.signal)), READ_TIMEOUT_MS, () => controller.abort())
            if (!this.stopped) this.store.updateTask(id, { ...inspectionPatch(observation), observationState: 'fresh', lastObservedAt: this.timestamp(), issue: this.identityConflict(id) })
          } finally {
            this.observedAt.set(cacheKey, this.now())
            this.trim(this.observedAt)
          }
        })
      } catch (error) {
        if (!this.stopped) {
          const safeIssue = providerIssue(error, 'observation_failed')
          this.store.updateTask(id, { observationState: safeIssue.code === 'capability_unavailable' ? 'unavailable' : safeIssue.code === 'auth_required' ? 'auth_required' : 'error', issue: this.identityConflict(id) ?? safeIssue })
        }
      } finally {
        this.observations.delete(cacheKey)
        this.readers.delete(controller)
      }
      // An uncooperative adapter can outlive the shutdown grace and a closed store.
      return this.stopped ? cached : this.getTask(id)
    })())
    this.observations.set(cacheKey, pending)
    return pending
  }
  private identityConflict(id: string): CloudIssue | null {
    const current = this.store.getTask(id)?.issue
    return current?.code === 'identity_conflict' ? current : null
  }
  getDiff(id: string): Promise<CloudDiff> {
    this.active()
    const task = this.getTask(id).task
    const connection = cloudConnectionKey(task.provider, task.credentialContextId)
    // A new provider observation must not reuse an older cached or in-flight diff.
    const cacheKey = `${connection}/${id}/${canonicalCloudRequest([task.providerUpdatedAt, task.rawState, task.remoteState])}`
    const existing = this.diffs.get(cacheKey)
    if (existing) return existing
    const cached = this.diffCache.get(cacheKey)
    if (cached && this.recent(cached.at)) return Promise.resolve(cached.value)
    if (!task.providerTaskId) throw new CloudTaskError(409, 'task_unlinked', 'A provider task identity is required')
    const controller = new AbortController()
    this.readers.add(controller)
    const pending = this.track((async () => {
      try {
        return await this.queueRead(connection, async () => {
          await this.ready(task.provider, 'diff', false, task)
          this.active()
          const diff = boundedDiff(await bounded(this.track(this.adapter(task.provider, task.credentialContextId).diff(structuredClone(task), controller.signal)), READ_TIMEOUT_MS, () => controller.abort()))
          this.active()
          this.diffCache.set(cacheKey, { at: this.now(), value: diff })
          this.trim(this.diffCache)
          return diff
        })
      } catch (error) {
        const safeIssue = providerIssue(error, 'observation_failed')
        throw new CloudTaskError(safeIssue.code === 'rate_limited' ? 429 : safeIssue.code === 'service_stopped' ? 503 : 502, safeIssue.code, safeIssue.message)
      } finally {
        this.diffs.delete(cacheKey)
        this.readers.delete(controller)
      }
    })())
    this.diffs.set(cacheKey, pending)
    return pending
  }
  /** Abort local signals and cancel queued reads, journal uncertainty, release the lease,
   * then drain tracked dispatch/read/probe settlements for at most two seconds.
   * Does not cancel cloud work, close storage, or replay intents. Repeated calls share the drain.
   * Cooperative runners settle within the grace. For uncooperative adapters, keep the
   * repository open until process beforeExit if late receipt reconciliation is desired.
   */
  stop(): Promise<void> {
    return this.stopping ??= this.stopAndDrain()
  }
  private async stopAndDrain(): Promise<void> {
    this.stopped = true
    clearInterval(this.heartbeatTimer)
    for (const immediate of this.scheduled.values()) clearImmediate(immediate)
    this.scheduled.clear()
    for (const queue of this.readQueues.values()) for (const read of queue) read.cancel()
    this.readQueues.clear()
    for (const controller of this.dispatches.values()) controller.abort()
    for (const controller of this.readers) controller.abort()
    let failure: unknown
    for (const id of this.dispatches.keys()) {
      try {
        const operation = this.store.getOperation(id)
        if (operation?.state === 'dispatching' && operation.ownerId === this.ownerId) this.store.finishOperation(id, { state: 'delivery_unknown', issue: issue('service_stopped') })
      } catch (error) { failure ??= error }
    }
    try { this.store.releaseOwner(this.ownerId) } catch (error) { failure ??= error }
    // Track raw adapter promises as well as bounded wrappers, so a prior timeout
    // cannot hide a runner still terminating. Never wait for the 120s dispatch cap.
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        Promise.allSettled([...this.settlements]),
        new Promise<void>((resolve) => { timer = setTimeout(resolve, STOP_GRACE_MS) }),
      ])
    } finally { clearTimeout(timer) }
    if (failure) throw failure
  }
}
