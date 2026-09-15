import { useCallback, useMemo, useSyncExternalStore } from 'react'
import {
  canonicalCloudRequest, cloudConnectionKey, type CloudCreateInput, type CloudLinkInput, type CloudMessageInput,
  type CloudOperation, type CloudProvidersResponse, type CloudResumeInput, type CloudTaskAction, type CloudTaskDetail,
  type CloudTaskSummary,
} from '../shared/cloud-tasks'
import type { CloudTaskPatch, CloudTasksApi } from './cloudTasksApi'

export const CLOUD_FOREGROUND_INTERVAL_MS = 30_000
export const CLOUD_PENDING_STORAGE_KEY = 'commando-cloud-pending-intents-v1'
/** This is the entire persisted browser record. Never add payloads, titles, or tokens. */
export type CloudPendingIndex = { key: string; digest: string; installationId: string }
export type CloudPendingIntent = CloudPendingIndex & {
  status: 'checking' | 'unknown' | 'recorded'
  operation?: CloudOperation
  retryable: boolean
}
export type CloudIntent =
  | { kind: 'create'; input: CloudCreateInput }
  | { kind: 'link'; input: CloudLinkInput; taskId?: string }
  | { kind: 'message'; input: CloudMessageInput; taskId: string }
export type CloudTasksSnapshot = {
  providers: CloudProvidersResponse | null
  tasks: CloudTaskSummary[]
  details: Readonly<Record<string, CloudTaskDetail>>
  pending: CloudPendingIntent[]
  loading: boolean
  connected: boolean
  error: string
  lastLoadedAt: number | null
}

function browserStorage(): Storage | null {
  try { return window.localStorage } catch { return null }
}
function readIndex(storage: Storage): CloudPendingIndex[] {
  const raw = storage.getItem(CLOUD_PENDING_STORAGE_KEY)
  if (!raw) return []
  const parsed: unknown = JSON.parse(raw)
  if (!Array.isArray(parsed) || parsed.some((entry) => !entry || typeof entry.key !== 'string'
    || typeof entry.digest !== 'string' || typeof entry.installationId !== 'string')) {
    throw new Error('Pending intent index is unreadable. Restore browser storage before submitting.')
  }
  return parsed.map(({ key, digest, installationId }) => ({ key, digest, installationId }))
}
export async function cloudIntentDigest(intent: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalCloudRequest(intent))
  const hash = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('')
}
export function digestCloudIntent(intent: CloudIntent): Promise<string> {
  return cloudIntentDigest({ kind: intent.kind, taskId: 'taskId' in intent ? intent.taskId ?? null : null, payload: intent.input })
}
const summary = ({ prompt: _prompt, ...task }: CloudTaskDetail['task']): CloudTaskSummary => task
const terminal = (operation: CloudOperation) => operation.state === 'accepted' || operation.state === 'rejected'
export class CloudIntentMismatchError extends Error {
  constructor() { super('This draft does not match the saved intent digest (including kind and target). Correct it, or explicitly acknowledge a new intent and duplicate risk.') }
}

export class CloudTaskStore {
  private snapshot: CloudTasksSnapshot = {
    providers: null, tasks: [], details: {}, pending: [], loading: false,
    connected: false, error: '', lastLoadedAt: null,
  }
  private listeners = new Set<() => void>()
  private watched = new Map<string, number>()
  private flight: Promise<void> | null = null
  private reads = new Map<string, Promise<CloudTaskDetail>>()
  private retries = new Map<string, Promise<CloudTaskAction | null>>()
  private memory = new Map<string, CloudIntent>()
  private activeReads = 0
  private readQueue: (() => void)[] = []
  private resumes = new Map<string, Promise<CloudTaskAction>>()
  private timer: ReturnType<typeof setTimeout> | null = null
  private failures = 0

  constructor(readonly api: CloudTasksApi, private storage: Storage | null = browserStorage()) {}
  getSnapshot = (): CloudTasksSnapshot => this.snapshot
  private update(patch: Partial<CloudTasksSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch }
    this.listeners.forEach((listener) => listener())
  }
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    if (this.listeners.size === 1) {
      document.addEventListener('visibilitychange', this.wake)
      window.addEventListener('focus', this.wake)
      window.addEventListener('online', this.wake)
      window.addEventListener('offline', this.offline)
      window.addEventListener('storage', this.storageChanged)
      this.wake()
    }
    return () => {
      this.listeners.delete(listener)
      if (this.listeners.size) return
      if (this.timer) clearTimeout(this.timer)
      this.timer = null
      document.removeEventListener('visibilitychange', this.wake)
      window.removeEventListener('focus', this.wake)
      window.removeEventListener('online', this.wake)
      window.removeEventListener('offline', this.offline)
      window.removeEventListener('storage', this.storageChanged)
    }
  }
  watch(id: string): () => void {
    this.watched.set(id, (this.watched.get(id) ?? 0) + 1)
    if (this.snapshot.connected && this.visible()) void this.loadDetail(id).catch(() => undefined)
    return () => {
      const count = (this.watched.get(id) ?? 1) - 1
      if (count) this.watched.set(id, count)
      else this.watched.delete(id)
    }
  }
  private visible = () => document.visibilityState !== 'hidden' && navigator.onLine !== false
  private offline = () => this.update({ connected: false, error: 'Offline. Showing last-known cloud tasks.' })
  private storageChanged = (event: StorageEvent) => { if (event.key === CLOUD_PENDING_STORAGE_KEY) this.wake() }
  private wake = () => { if (this.visible()) void this.refresh() }
  private schedule() {
    if (this.timer) clearTimeout(this.timer)
    if (!this.listeners.size) return
    const delay = CLOUD_FOREGROUND_INTERVAL_MS * Math.min(8, 2 ** this.failures)
    this.timer = setTimeout(() => {
      if (this.visible()) void this.refresh()
      else this.schedule()
    }, delay + (this.failures ? Math.random() * 3_000 : 0))
  }
  refresh = (): Promise<void> => {
    if (this.flight) return this.flight
    this.update({ loading: true })
    this.flight = this.poll().catch(() => {
      this.failures++
      this.update({ connected: false, error: 'Daemon unavailable. Showing last-known cloud tasks; reconnect to refresh.' })
    }).finally(() => {
      this.flight = null
      this.update({ loading: false })
      this.schedule()
    })
    return this.flight
  }
  private async poll() {
    const providers = await this.api.providers()
    const previousScope = this.snapshot.providers?.installationId
    if (previousScope && previousScope !== providers.installationId) {
      this.memory.clear()
      this.update({ tasks: [], details: {}, pending: [] })
    }
    this.update({ providers })
    const tasks = await this.api.list()
    // Keep newer mutation responses if a list request raced an edit/receipt.
    const merged = tasks.map((task) => {
      const cached = this.snapshot.tasks.find((item) => item.id === task.id)
      return cached && cached.revision > task.revision ? cached : task
    })
    // There is no delete API: a task recorded while list was in flight must not disappear.
    merged.push(...this.snapshot.tasks.filter((cached) => !tasks.some((task) => task.id === cached.id)))
    this.update({ tasks: merged, connected: true, error: '', lastLoadedAt: Date.now() })
    await this.recoverPending()
    const ids = new Set(this.watched.keys())
    for (const task of merged) {
      if (!task.archivedAt && (['queued', 'running', 'unknown', 'needs_input'].includes(task.remoteState)
        || ['prepared', 'dispatching'].includes(task.deliveryState))) ids.add(task.id)
    }
    let observationFailed = false
    // Drain every task rather than flooding the daemon's bounded provider queue.
    for (const id of ids) {
      const task = this.snapshot.tasks.find((item) => item.id === id)
      const info = task && providers.providers.find((provider) => cloudConnectionKey(provider.id, provider.credentialContextId) === cloudConnectionKey(task.provider, task.credentialContextId))
      const inspect = info?.readiness === 'ready' && info.capabilities.inspect
      // Receipt-only providers never get invented live polling. Only selected details are loaded.
      try {
        if (inspect && task?.providerTaskId) {
          const detail = await this.loadDetail(id, true)
          if (['error', 'stale', 'auth_required'].includes(detail.task.observationState)) observationFailed = true
        }
        else if (this.watched.has(id) || task?.deliveryState === 'prepared' || task?.deliveryState === 'dispatching') await this.loadDetail(id)
      } catch { observationFailed = true }
    }
    if (observationFailed) this.update({ error: 'Some observations could not be refreshed. Showing last-known task information.' })
    this.failures = observationFailed ? this.failures + 1 : 0
  }
  loadDetail(id: string, observe = false): Promise<CloudTaskDetail> {
    const existing = this.reads.get(id)
    if (existing) return existing
    const scope = this.snapshot.providers?.installationId
    const request = this.queueRead(() => observe ? this.api.refresh(id) : this.api.get(id)).then((detail) => {
      if (scope === this.snapshot.providers?.installationId) this.acceptDetail(detail)
      return detail
    }).finally(() => this.reads.delete(id))
    this.reads.set(id, request)
    return request
  }
  private queueRead(load: () => Promise<CloudTaskDetail>): Promise<CloudTaskDetail> {
    return new Promise((resolve, reject) => {
      const start = () => {
        this.activeReads++
        void Promise.resolve().then(load).then(resolve, reject).finally(() => {
          this.activeReads--
          this.readQueue.shift()?.()
        })
      }
      if (this.activeReads < 4) start()
      else this.readQueue.push(start)
    })
  }
  private acceptDetail(detail: CloudTaskDetail) {
    const existing = this.snapshot.details[detail.task.id]
    if (existing && existing.task.revision > detail.task.revision) return
    const tasks = this.snapshot.tasks.filter((task) => task.id !== detail.task.id)
    this.update({
      details: { ...this.snapshot.details, [detail.task.id]: detail },
      tasks: [summary(detail.task), ...tasks].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    })
  }
  async patch(id: string, patch: CloudTaskPatch) {
    this.requireReady()
    const detail = await this.api.patch(id, patch)
    this.acceptDetail(detail)
    return detail
  }
  private requireReady() {
    if (!this.snapshot.connected || !this.snapshot.providers || navigator.onLine === false) {
      throw new Error('Reconnect to the daemon before changing cloud tasks.')
    }
    return this.snapshot.providers.installationId
  }
  private writeIndex(change: (entries: CloudPendingIndex[]) => CloudPendingIndex[]) {
    if (!this.storage) throw new Error('Browser storage is unavailable. Pending intent recovery is required before sending.')
    const next = change(readIndex(this.storage))
    this.storage.setItem(CLOUD_PENDING_STORAGE_KEY, JSON.stringify(next))
  }
  private setPending(entry: CloudPendingIntent) {
    this.update({ pending: [...this.snapshot.pending.filter((item) => item.key !== entry.key), entry] })
  }
  private async reconcile(entry: CloudPendingIndex, operation: CloudOperation) {
    if (operation.idempotencyKey !== entry.key) throw new Error('Recovery returned a different intent. No request was replayed.')
    // byKey is authoritative. Linking a task never rewrites another operation's delivery state.
    this.setPending({ ...entry, status: 'recorded', operation, retryable: false })
    await this.loadDetail(operation.taskId)
    if (terminal(operation)) {
      this.writeIndex((entries) => entries.filter((item) => item.key !== entry.key || item.installationId !== entry.installationId))
      this.memory.delete(entry.key)
      this.update({ pending: this.snapshot.pending.filter((item) => item.key !== entry.key) })
    }
  }
  async recoverPending() {
    const scope = this.snapshot.providers?.installationId
    if (!scope || !this.storage) return
    let entries: CloudPendingIndex[]
    try { entries = readIndex(this.storage).filter((entry) => entry.installationId === scope) } catch {
      this.update({ error: 'Pending intent index is unreadable. Submissions are blocked until browser storage is restored.' })
      return
    }
    this.update({ pending: this.snapshot.pending.filter((item) => entries.some((entry) => entry.key === item.key)) })
    for (const entry of entries) {
      if (this.retries.has(entry.key)) continue
      this.setPending({ ...entry, status: 'checking', retryable: false })
      try {
        const operation = await this.api.byKey(entry.key)
        if (scope !== this.snapshot.providers?.installationId) return
        if (operation) await this.reconcile(entry, operation)
        else this.setPending({ ...entry, status: 'unknown', retryable: this.memory.has(entry.key) })
      } catch {
        this.setPending({ ...entry, status: 'unknown', retryable: this.memory.has(entry.key) })
      }
    }
  }
  create(input: CloudCreateInput) { return this.begin({ kind: 'create', input }) }
  link(input: CloudLinkInput, taskId?: string) { return this.begin({ kind: 'link', input, taskId }) }
  message(taskId: string, input: CloudMessageInput) { return this.begin({ kind: 'message', taskId, input }) }
  private async begin(intent: CloudIntent): Promise<CloudTaskAction> {
    const installationId = this.requireReady()
    const frozen = JSON.parse(canonicalCloudRequest(intent)) as CloudIntent
    const entry: CloudPendingIndex = { key: crypto.randomUUID(), digest: await digestCloudIntent(frozen), installationId }
    if (installationId !== this.requireReady()) throw new Error('Installation changed. Reconfirm the request.')
    // Persist BEFORE calling any mutation. The request exists only in this store's memory.
    this.writeIndex((entries) => [...entries, entry])
    this.memory.set(entry.key, frozen)
    this.setPending({ ...entry, status: 'checking', retryable: false })
    const request = this.dispatch(entry, frozen).finally(() => this.retries.delete(entry.key))
    this.retries.set(entry.key, request)
    return request
  }
  private async dispatch(entry: CloudPendingIndex, intent: CloudIntent): Promise<CloudTaskAction> {
    if (entry.installationId !== this.requireReady()) throw new Error('Installation changed. Reconfirm the request in the correct installation.')
    try {
      const action = await (intent.kind === 'create' ? this.api.create(intent.input, entry.key)
        : intent.kind === 'link' ? this.api.link(intent.input, entry.key, intent.taskId)
          : this.api.message(intent.taskId, intent.input, entry.key))
      if (entry.installationId !== this.snapshot.providers?.installationId) throw new Error('Installation changed')
      if (!action?.task?.id || !action.operation?.id || action.operation.idempotencyKey !== entry.key) throw new Error('Malformed receipt')
      const prior = this.snapshot.details[action.task.id]?.operations ?? []
      this.acceptDetail({ task: action.task, operations: [...prior.filter((op) => op.id !== action.operation.id), action.operation] })
      this.setPending({ ...entry, status: 'recorded', operation: action.operation, retryable: false })
      if (terminal(action.operation)) {
        this.writeIndex((entries) => entries.filter((item) => item.key !== entry.key || item.installationId !== entry.installationId))
        this.memory.delete(entry.key)
        this.update({ pending: this.snapshot.pending.filter((item) => item.key !== entry.key) })
      }
      return action
    } catch {
      if (entry.installationId === this.snapshot.providers?.installationId) this.setPending({ ...entry, status: 'unknown', retryable: true })
      throw new Error('Delivery unknown — check the provider before retrying. The request may have been recorded or sent.')
    }
  }
  /** Explicit transport retry only: recover first, then reuse the exact in-memory payload/key. */
  retry(key: string): Promise<CloudTaskAction | null> {
    const running = this.retries.get(key)
    if (running) return running
    const request = this.retryIntent(key).finally(() => this.retries.delete(key))
    this.retries.set(key, request)
    return request
  }
  private async retryIntent(key: string): Promise<CloudTaskAction | null> {
    const installationId = this.requireReady()
    const entry = this.snapshot.pending.find((item) => item.key === key && item.installationId === installationId)
    if (!entry) throw new Error('Intent not found in this installation.')
    const operation = await this.api.byKey(key)
    if (installationId !== this.requireReady()) throw new Error('Installation changed. No request was replayed.')
    if (operation) { await this.reconcile(entry, operation); return null }
    const intent = this.memory.get(key)
    if (!intent || await digestCloudIntent(intent) !== entry.digest) {
      throw new Error('Unknown draft after reload. Re-enter the original request and explicitly reconfirm it; no request was replayed.')
    }
    return this.dispatch(entry, intent)
  }
  /** Re-entered payloads must recover by key first, then match the original kind/target/payload digest. */
  reenter(key: string, intent: CloudIntent, allowNewIntent = false): Promise<CloudTaskAction | null> {
    const running = this.retries.get(key)
    if (running) return running
    const frozen = JSON.parse(canonicalCloudRequest(intent)) as CloudIntent
    const request = this.reenterIntent(key, frozen, allowNewIntent).finally(() => this.retries.delete(key))
    this.retries.set(key, request)
    return request
  }
  private async reenterIntent(key: string, intent: CloudIntent, allowNewIntent: boolean): Promise<CloudTaskAction | null> {
    const installationId = this.requireReady()
    const entry = this.snapshot.pending.find((item) => item.key === key && item.installationId === installationId)
    if (!entry) throw new Error('Intent not found in this installation. Refresh recovery before continuing.')
    if (!intent.input.accountConfirmed) throw new Error('Explicit account and source confirmation is required.')
    const operation = await this.api.byKey(key)
    if (installationId !== this.requireReady()) throw new Error('Installation changed. No request was replayed.')
    if (operation) { await this.reconcile(entry, operation); return null }
    if (await digestCloudIntent(intent) !== entry.digest) {
      if (!allowNewIntent) throw new CloudIntentMismatchError()
      return this.begin(intent)
    }
    this.memory.set(key, intent)
    return this.dispatch(entry, intent)
  }
  resumeOperation(id: string, input: CloudResumeInput): Promise<CloudTaskAction> {
    const running = this.resumes.get(id)
    if (running) return running
    const request = this.resumePrepared(id, { ...input }).finally(() => this.resumes.delete(id))
    this.resumes.set(id, request)
    return request
  }
  private async resumePrepared(id: string, input: CloudResumeInput): Promise<CloudTaskAction> {
    const scope = this.requireReady()
    if (!input.accountConfirmed) throw new Error('Confirm the account and original source before resuming.')
    const operation = await this.api.operation(id)
    if (scope !== this.requireReady()) throw new Error('Installation changed. No operation was resumed.')
    if (operation.state !== 'prepared') {
      await this.loadDetail(operation.taskId)
      throw new Error('Only a prepared operation can be resumed. This operation was not replayed.')
    }
    if (operation.payload.credentialContextId !== input.credentialContextId) throw new Error('Credential context changed. This operation was not resumed.')
    const action = await this.api.resumeOperation(id, input)
    if (scope !== this.requireReady()) throw new Error('Installation changed. Refresh the original installation to recover.')
    const prior = this.snapshot.details[action.task.id]?.operations ?? []
    this.acceptDetail({ task: action.task, operations: [...prior.filter((op) => op.id !== action.operation.id), action.operation] })
    const entry = this.snapshot.pending.find((item) => item.key === operation.idempotencyKey)
    if (entry) await this.reconcile(entry, action.operation)
    return action
  }
}

const stores = new WeakMap<CloudTasksApi, CloudTaskStore>()
export function cloudTaskStoreFor(api: CloudTasksApi): CloudTaskStore {
  let store = stores.get(api)
  if (!store) { store = new CloudTaskStore(api); stores.set(api, store) }
  return store
}
export function useCloudTasks(api: CloudTasksApi) {
  const store = useMemo(() => cloudTaskStoreFor(api), [api])
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  return { ...snapshot, store }
}
export function useCloudTask(api: CloudTasksApi, id: string | null) {
  const store = useMemo(() => cloudTaskStoreFor(api), [api])
  const subscribe = useCallback((listener: () => void) => {
    const unwatch = id ? store.watch(id) : () => undefined
    const unsubscribe = store.subscribe(listener)
    return () => { unwatch(); unsubscribe() }
  }, [store, id])
  const snapshot = useSyncExternalStore(subscribe, store.getSnapshot, store.getSnapshot)
  return id ? snapshot.details[id] ?? null : null
}
