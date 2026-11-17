import { DeviceLockError, type DeviceHolder, type DeviceLockSnapshot, type DeviceResource, type LockOwner, type LockResult, type QueueEntry, type SweepContext, type SweepEvents } from './device-locks.js'
import type { DeviceLockStore } from './device-lock-store.js'

/**
 * Commando's device locks backed by device farms (https://github.com/laeijebor/device-farm): this Mac's own farm,
 * plus an optional remote one whose devices appear alongside. Each Commando pane (and script pid) is a farm session
 * of Commando's engineer, so the farm queues them like any other client. Reads come from a mirror of each farm kept
 * fresh by its change feed; changes go over HTTP and refresh the mirror before they return.
 */

type FarmOwner = { engineer: string; session: string; as?: string; label?: string; pid?: number }
type FarmQueueEntry = FarmOwner & { id: string; request: string; resourceIds: string[]; task: string; estimateMs?: number; mode: 'notify' | 'wait'; enqueuedAt: number;
  offer?: { resourceId: string; at: number; deliveredAt?: number }; skips?: number }
type FarmHolder = FarmOwner & { resourceId: string; task: string; estimateMs?: number; acquiredAt: number; lastSeenAt: number; entryId: string }
type FarmResource = { id: string; name: string; kind: DeviceResource['kind']; serial?: string; aliases?: string[]; release?: string; busyProcesses?: string[] }
export type FarmChanges = {
  version: number
  snapshot: { resources: FarmResource[]; holders: FarmHolder[]; queue: FarmQueueEntry[]; paused: string[]; cleaning: Array<{ resourceId: string; since: number }> }
  positions: Record<string, number>
  health: Record<string, { status: string; reasons: string[]; battery?: number; thermal?: number }>
  waitingFor: Record<string, string>
  timing: { offerMs: number; undeliveredOfferMs: number; idleMs: number; maxHoldMs: number }
  engineers: Array<{ id: string; name: string }>
}
type Fetcher = typeof fetch

const SESSION_PREFIX = 'cmd:'
const MAX_SKIPS = 3
const HEARTBEAT_MS = 60_000

/** One farm: its HTTP API, its engineer identity and a mirror of its state, kept fresh by long-polling its change feed. */
export class FarmClient {
  readonly name: 'local' | 'remote'
  readonly url: string
  private readonly token: string
  private readonly fetcher: Fetcher
  changes?: FarmChanges
  me?: { id: string; name: string; admin: boolean }
  error?: string
  private stopped = false
  private readonly listeners = new Set<() => void>()

  constructor(options: { name: 'local' | 'remote'; url: string; token: string; fetcher?: Fetcher }) {
    this.name = options.name
    this.url = options.url.replace(/\/$/, '')
    this.token = options.token
    this.fetcher = options.fetcher ?? fetch
  }

  get connected(): boolean { return Boolean(this.changes && this.me && !this.error) }
  onUpdate(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener) }

  async request<T = Record<string, unknown>>(method: string, path: string, body?: unknown, timeoutMs = 20_000): Promise<T> {
    let response: Response
    try {
      response = await this.fetcher(`${this.url}${path}`, {
        method, headers: { authorization: `Bearer ${this.token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (error) { throw new DeviceLockError(503, `The ${this.name} device farm is unreachable (${(error as Error).message})`) }
    const text = await response.text()
    let parsed: Record<string, unknown> = {}
    try { parsed = text ? JSON.parse(text) : {} } catch { parsed = { error: text } }
    if (!response.ok) throw new DeviceLockError(response.status, typeof parsed.error === 'string' ? parsed.error : `${this.name} farm: ${response.status}`)
    return parsed as T
  }

  /** Reads the current state now (after a change Commando made, so reads that follow see it). */
  async refresh(): Promise<void> {
    this.me ??= (await this.request<{ me: { id: string; name: string; admin: boolean } }>('GET', '/api/state')).me
    this.apply(await this.request<FarmChanges>('GET', '/api/changes'))
  }

  /** Follows the change feed until stopped; on errors, records them and retries. */
  async run(): Promise<void> {
    while (!this.stopped) {
      try {
        if (!this.changes || !this.me) await this.refresh()
        else this.apply(await this.request<FarmChanges>('GET', `/api/changes?since=${this.changes.version}&wait=50`, undefined, 60_000))
      } catch (error) {
        const message = (error as Error).message
        if (this.error !== message) { this.error = message; for (const listener of this.listeners) listener() }
        await new Promise((resolve) => setTimeout(resolve, 5_000))
      }
    }
  }

  stop(): void { this.stopped = true }

  private apply(changes: FarmChanges): void {
    const changed = this.error !== undefined || !this.changes || changes.version !== this.changes.version
    this.changes = changes
    this.error = undefined
    if (changed) for (const listener of this.listeners) listener()
  }
}

export class FarmLockStore implements DeviceLockStore {
  private readonly clients: FarmClient[]
  private readonly changeListeners = new Set<() => void>()
  private readonly offerListeners = new Set<(entries: QueueEntry[]) => void>()
  /** Offer messages Commando queued for its panes, by entry: the farm doesn't know about them. */
  private readonly messages = new Map<string, { at: number; messageId: string }>()
  private readonly announced = new Set<string>()
  private readonly alerts = new Map<string, string>()
  /** Requests Commando itself took out of a queue (claim, cancel, withdraw), so their disappearance isn't a lapse. */
  private readonly removedByUs = new Set<string>()
  private previousOffers = new Map<string, { at: number; skips: number; resourceId: string; entry: QueueEntry }>()
  private pendingExpired: SweepEvents['expired'] = []
  private lastHeartbeat = 0
  private readonly now: () => number

  constructor(clients: FarmClient[], options: { now?: () => number } = {}) {
    this.clients = clients
    this.now = options.now ?? Date.now
    for (const client of clients) client.onUpdate(() => this.updated())
  }

  /** Resolves once every farm has been read once (or failed to answer). */
  async ready(): Promise<void> { await Promise.all(this.clients.map((client) => client.refresh().catch(() => undefined))); this.updated() }

  /** Starts following every farm's change feed. */
  start(): void { for (const client of this.clients) void client.run() }
  stop(): void { for (const client of this.clients) client.stop() }
  status() { return this.clients.map((client) => ({ name: client.name, url: client.url, connected: client.connected, ...(client.error ? { error: client.error } : {}), engineer: client.me?.id })) }

  onChange(listener: () => void): () => void { this.changeListeners.add(listener); return () => this.changeListeners.delete(listener) }
  onOffered(listener: (entries: QueueEntry[]) => void): () => void { this.offerListeners.add(listener); return () => this.offerListeners.delete(listener) }

  // ---- Reads, from the mirrors ----

  snapshot(): DeviceLockSnapshot {
    const seen = new Set<string>()
    const resources: DeviceResource[] = [], holders: DeviceHolder[] = [], queue: QueueEntry[] = [], paused: string[] = []
    for (const client of this.clients) {
      const state = client.changes?.snapshot
      if (!state) continue
      // A remote device whose id is already taken by a local one stays hidden rather than ambiguous.
      const own = state.resources.filter((resource) => !seen.has(resource.id))
      for (const resource of own) { seen.add(resource.id); resources.push(toResource(resource)) }
      const ids = new Set(own.map((resource) => resource.id))
      holders.push(...state.holders.filter((holder) => ids.has(holder.resourceId)).map((holder) => this.toHolder(holder, client)))
      queue.push(...state.queue.filter((entry) => entry.resourceIds.some((id) => ids.has(id))).map((entry) => this.toEntry(entry, client)))
      paused.push(...state.paused.filter((id) => ids.has(id)))
    }
    return { resources, holders, queue, paused }
  }

  resource(id: string): DeviceResource | undefined { return this.snapshot().resources.find((resource) => resource.id === id) }
  entry(id: string): QueueEntry | undefined { return this.snapshot().queue.find((entry) => entry.id === id) }
  holdersOf(resourceId: string): DeviceHolder[] { return this.snapshot().holders.filter((holder) => holder.resourceId === resourceId) }
  position(entry: QueueEntry): number { return this.clientOfEntry(entry.id)?.changes?.positions[entry.id] ?? 0 }
  waitingFor(resource: DeviceResource): string | undefined { return this.clientOf(resource.id)?.changes?.waitingFor[resource.id] }
  health(resourceId: string) { return this.clientOf(resourceId)?.changes?.health[resourceId] }

  offerMessage(entryId: string, offerAt: number, messageId: string): boolean {
    if (this.entry(entryId)?.offer?.at !== offerAt) return false
    this.messages.set(entryId, { at: offerAt, messageId })
    this.emit()
    return true
  }

  /** The agent has the offer message: tell the farm, which starts the claim window when the owner's session checks in. */
  offerDelivered(target: { entryId: string } | { messageId: string }): void {
    const entryId = 'entryId' in target ? target.entryId : [...this.messages].find(([, message]) => message.messageId === target.messageId)?.[0]
    const entry = entryId ? this.entry(entryId) : undefined
    const client = entryId ? this.clientOfEntry(entryId) : undefined
    if (!entry || !client) return
    void client.request('POST', '/api/heartbeat', farmOwner(entry, client)).catch((error) => console.warn('[device-farm] could not confirm an offer', error.message))
  }

  alertSent(key: string): boolean { return this.alerts.has(key) }
  recordAlert(key: string, ref: string): void { this.alerts.set(key, ref) }

  // ---- Changes, over HTTP ----

  async lock(input: Record<string, unknown>): Promise<LockResult> {
    const request = String(input.request ?? '')
    const client = this.clientForRequest(request)
    const owner = input as unknown as LockOwner
    const result = await client.request<FarmResult>('POST', '/api/lock', { ...farmOwner(owner, client), request, task: input.task,
      ...(input.estimateMs !== undefined ? { estimateMs: input.estimateMs } : {}), ...(input.mode === 'wait' ? { mode: 'wait' } : {}) })
    await this.settle(client)
    return this.toResult(result, client)
  }

  async claim(ownerInput: LockOwner | Record<string, unknown>, resourceId?: string): Promise<LockResult> {
    const owner = ownerInput as LockOwner
    const client = (resourceId ? this.clientOf(resourceId) : undefined) ?? this.clientWithOfferFor(owner) ?? this.clients[0]
    const pending = this.snapshot().queue.find((entry) => sameOwner(entry, owner) && entry.offer)
    const result = await client.request<FarmResult>('POST', '/api/claim', { ...farmOwner(owner, client), ...(resourceId ? { request: resourceId } : {}) })
    if (pending) this.removedByUs.add(pending.id)
    await this.settle(client)
    return this.toResult(result, client)
  }

  async release(ownerInput: LockOwner | Record<string, unknown>, resourceId?: string): Promise<DeviceHolder[]> {
    const owner = ownerInput as LockOwner
    const targets = resourceId ? [this.clientOf(resourceId) ?? this.clients[0]] : this.clientsHolding(owner)
    if (!targets.length) throw new DeviceLockError(404, resourceId ? `You don't hold ${resourceId}` : 'You hold no device locks')
    const released: DeviceHolder[] = []
    for (const client of targets) {
      const result = await client.request<{ released: FarmHolder[] }>('POST', '/api/release', { ...farmOwner(owner, client), ...(resourceId ? { request: resourceId } : {}) })
      released.push(...result.released.map((holder) => this.toHolder(holder, client)))
      await this.settle(client)
    }
    return released
  }

  async cancel(ownerInput: LockOwner | Record<string, unknown>, request?: string): Promise<QueueEntry[]> {
    const owner = ownerInput as LockOwner
    const mine = this.snapshot().queue.filter((entry) => sameOwner(entry, owner) && (!request || entry.request === request || entry.resourceIds.includes(request)))
    if (!mine.length) throw new DeviceLockError(404, request ? `You are not queued for ${request}` : 'You are not queued for any device')
    const cancelled: QueueEntry[] = []
    for (const client of new Set(mine.map((entry) => this.clientOfEntry(entry.id)!))) {
      for (const entry of mine) this.removedByUs.add(entry.id)
      const result = await client.request<{ cancelled: FarmQueueEntry[] }>('POST', '/api/cancel', { ...farmOwner(owner, client), ...(request ? { request } : {}) })
      cancelled.push(...result.cancelled.map((entry) => this.toEntry(entry, client)))
      await this.settle(client)
    }
    return cancelled
  }

  async withdraw(paneId: string, entryId: string): Promise<'cancelled' | 'released' | 'gone'> {
    const client = this.clientOfEntry(entryId) ?? this.clients.find((candidate) => candidate.changes?.snapshot.holders.some((holder) => holder.entryId === entryId))
    const ours = this.entry(entryId) ?? this.snapshot().holders.find((holder) => holder.entryId === entryId)
    if (!client || !ours || ours.paneId !== paneId) return 'gone'
    this.removedByUs.add(entryId)
    const result = await client.request<{ result: 'cancelled' | 'released' | 'gone' }>('POST', '/api/withdraw', { entryId })
    await this.settle(client)
    return result.result
  }

  /**
   * Ends the holds and requests of panes that closed or scripts that exited, keeps the live ones' holds alive (the
   * farm otherwise ends idle holds), and reports offers the farm let lapse since the last sweep.
   */
  async sweep(context: SweepContext): Promise<SweepEvents> {
    const alive = (owner: LockOwner) => context.paneExists(owner.paneId) && (owner.pid === undefined || context.pidAlive(owner.pid))
    const snapshot = this.snapshot()
    const ended: SweepEvents['ended'] = [], dropped: QueueEntry[] = []
    for (const holder of snapshot.holders.filter((candidate) => this.isOurs(candidate) && !alive(candidate))) {
      const client = this.clientOf(holder.resourceId)
      if (!client) continue
      await client.request('POST', '/api/release', { ...farmOwner(holder, client), request: holder.resourceId }).catch(() => undefined)
      ended.push({ ...holder, reason: context.paneExists(holder.paneId) ? 'process-exited' : 'pane-closed' })
    }
    for (const entry of snapshot.queue.filter((candidate) => this.isOurs(candidate) && !alive(candidate))) {
      const client = this.clientOfEntry(entry.id)
      if (!client) continue
      this.removedByUs.add(entry.id)
      await client.request('POST', '/api/withdraw', { entryId: entry.id }).catch(() => undefined)
      dropped.push(entry)
    }
    if (this.now() - this.lastHeartbeat >= HEARTBEAT_MS) {
      this.lastHeartbeat = this.now()
      for (const client of this.clients) {
        const owners = snapshot.holders.filter((holder) => this.isOurs(holder) && alive(holder) && this.clientOf(holder.resourceId) === client)
          .map((holder) => farmOwner(holder, client))
        if (owners.length) await client.request('POST', '/api/heartbeat', { owners }).catch((error) => console.warn('[device-farm] heartbeat failed', error.message))
      }
    }
    if (ended.length || dropped.length) for (const client of this.clients) await client.refresh().catch(() => undefined)
    const expired = this.pendingExpired
    this.pendingExpired = []
    return { expired, ended, dropped }
  }

  async reorder(entryId: string, before?: string): Promise<void> { await this.admin(this.clientOfEntry(entryId), '/api/admin/reorder', { entryId, ...(before ? { before } : {}) }) }

  async setPaused(resourceId: string, paused: boolean): Promise<QueueEntry[]> {
    const client = this.requireClientOf(resourceId)
    const result = await this.admin<{ withdrawn: FarmQueueEntry[] }>(client, '/api/admin/pause', { resourceId, paused })
    return result.withdrawn.map((entry) => this.toEntry(entry, client))
  }

  async forceRelease(resourceId: string): Promise<DeviceHolder[]> {
    const client = this.requireClientOf(resourceId)
    const result = await this.admin<{ released: FarmHolder[] }>(client, '/api/admin/release', { resourceId })
    return result.released.map((holder) => this.toHolder(holder, client))
  }

  async remove(entryId: string): Promise<QueueEntry> {
    const client = this.clientOfEntry(entryId)
    const result = await this.admin<{ removed: FarmQueueEntry }>(client, '/api/admin/remove', { entryId })
    return this.toEntry(result.removed, client!)
  }

  async addResource(input: Record<string, unknown>): Promise<DeviceResource> {
    const result = await this.admin<{ resource: FarmResource }>(this.clients[0], '/api/admin/resources', input)
    return toResource(result.resource)
  }

  async removeResource(id: string): Promise<void> { await this.admin(this.requireClientOf(id), '/api/admin/resources/remove', { resourceId: id }) }

  // ---- Helpers ----

  private async admin<T = Record<string, unknown>>(client: FarmClient | undefined, path: string, body: unknown): Promise<T> {
    if (!client) throw new DeviceLockError(404, 'That request is no longer queued')
    const result = await client.request<T>('POST', path, body)
    await this.settle(client)
    return result
  }

  /** Refreshes a farm's mirror after a change, so what Commando reads next includes it. */
  private async settle(client: FarmClient): Promise<void> { await client.refresh().catch(() => undefined) }

  private updated(): void {
    const snapshot = this.snapshot()
    const offers = new Map<string, { at: number; skips: number; resourceId: string; entry: QueueEntry }>()
    const fresh: QueueEntry[] = []
    for (const entry of snapshot.queue) {
      if (!entry.offer || !this.isOurs(entry)) continue
      offers.set(entry.id, { at: entry.offer.at, skips: entry.skips ?? 0, resourceId: entry.offer.resourceId, entry })
      const key = `${entry.id}:${entry.offer.at}`
      if (!this.announced.has(key)) { this.announced.add(key); fresh.push(entry) }
    }
    // An offer that went away without Commando claiming or cancelling lapsed in the farm: the request either stepped
    // back in the queue (skips went up) or, after too many misses, left it.
    const holders = new Set(snapshot.holders.map((holder) => holder.entryId))
    for (const [id, previous] of this.previousOffers) {
      if (offers.has(id) || holders.has(id) || this.removedByUs.has(id)) continue
      const now = snapshot.queue.find((entry) => entry.id === id)
      if (now && !now.offer) this.pendingExpired.push({ ...now, offer: { resourceId: previous.resourceId, at: previous.at }, dropped: false })
      else if (!now && previous.skips + 1 >= MAX_SKIPS) this.pendingExpired.push({ ...previous.entry, dropped: true })
    }
    this.previousOffers = offers
    for (const id of [...this.messages.keys()]) if (!offers.has(id)) this.messages.delete(id)
    this.emit()
    if (fresh.length) for (const listener of this.offerListeners) listener(fresh)
  }

  private emit(): void { for (const listener of this.changeListeners) listener() }

  private isOurs(owner: { paneId: string }): boolean { return owner.paneId.startsWith('%') }

  private clientOf(resourceId: string): FarmClient | undefined {
    return this.clients.find((client) => client.changes?.snapshot.resources.some((resource) => resource.id === resourceId))
  }

  private requireClientOf(resourceId: string): FarmClient {
    const client = this.clientOf(resourceId)
    if (!client) throw new DeviceLockError(404, `No device lock named ${resourceId}`)
    return client
  }

  private clientOfEntry(entryId: string): FarmClient | undefined {
    return this.clients.find((client) => client.changes?.snapshot.queue.some((entry) => entry.id === entryId))
  }

  private clientWithOfferFor(owner: LockOwner): FarmClient | undefined {
    const entry = this.snapshot().queue.find((candidate) => sameOwner(candidate, owner) && candidate.offer)
    return entry ? this.clientOfEntry(entry.id) : undefined
  }

  private clientsHolding(owner: LockOwner): FarmClient[] {
    return [...new Set(this.snapshot().holders.filter((holder) => sameOwner(holder, owner)).map((holder) => this.clientOf(holder.resourceId)).filter((client): client is FarmClient => Boolean(client)))]
  }

  /** A named device's farm; an any-* request goes to the first farm (this Mac's first) that has a matching device. */
  private clientForRequest(request: string): FarmClient {
    const kinds: Record<string, string[]> = { any: ['android', 'ios', 'emulator'], 'any-phone': ['android', 'ios'], 'any-android': ['android'], 'any-ios': ['ios'] }
    const client = kinds[request]
      ? this.clients.find((candidate) => candidate.changes?.snapshot.resources.some((resource) => kinds[request].includes(resource.kind)))
      : this.clientOf(request)
    if (client) return client
    const known = this.snapshot().resources.map((resource) => resource.id).join(', ') || 'none yet'
    throw new DeviceLockError(404, kinds[request] ? `No ${request.replace('any-', '')} devices are registered` : `No device lock named ${request} (known: ${known})`)
  }

  private toResult(result: FarmResult, client: FarmClient): LockResult {
    if (result.status === 'held') return { status: 'held', holder: this.toHolder(result.holder!, client), resource: toResource(result.resource!) }
    if (result.status === 'offered') return { status: 'offered', entry: this.toEntry(result.entry!, client), resource: toResource(result.resource!) }
    return { status: 'queued', entry: this.toEntry(result.entry!, client), position: result.position ?? 0 }
  }

  private toOwner(owner: FarmOwner, client: FarmClient): LockOwner {
    const name = client.changes?.engineers.find((engineer) => engineer.id === owner.engineer)?.name ?? owner.engineer
    const mine = owner.engineer === client.me?.id && owner.session.startsWith(SESSION_PREFIX)
    if (!mine) {
      // Someone else on a shared farm: shown by name, never addressed as a pane here.
      return { paneId: `@${owner.engineer}`, sessionName: owner.label ? `${name} · ${owner.label}` : name, ...(owner.as ? { as: owner.as } : {}) }
    }
    const [, paneId, pid] = /^cmd:(%\d+)(?::(\d+))?$/.exec(owner.session) ?? []
    return { paneId: paneId ?? owner.session, sessionName: owner.label ?? paneId ?? owner.session, ...(owner.as ? { as: owner.as } : {}), ...(pid ? { pid: Number(pid) } : {}) }
  }

  private toHolder(holder: FarmHolder, client: FarmClient): DeviceHolder {
    return { ...this.toOwner(holder, client), resourceId: holder.resourceId, task: holder.task, ...(holder.estimateMs ? { estimateMs: holder.estimateMs } : {}),
      acquiredAt: holder.acquiredAt, entryId: holder.entryId }
  }

  private toEntry(entry: FarmQueueEntry, client: FarmClient): QueueEntry {
    const message = this.messages.get(entry.id)
    return { ...this.toOwner(entry, client), id: entry.id, request: entry.request, resourceIds: entry.resourceIds, task: entry.task,
      ...(entry.estimateMs ? { estimateMs: entry.estimateMs } : {}), mode: entry.mode, enqueuedAt: entry.enqueuedAt,
      ...(entry.offer ? { offer: { ...entry.offer, ...(message && message.at === entry.offer.at ? { messageId: message.messageId } : {}) } } : {}),
      ...(entry.skips ? { skips: entry.skips } : {}) }
  }
}

type FarmResult = { status: 'held' | 'offered' | 'queued'; holder?: FarmHolder; resource?: FarmResource; entry?: FarmQueueEntry; position?: number }

/** A Commando owner (pane, `as`, script pid) as a farm session of Commando's engineer. */
export function farmOwner(owner: { paneId: string; sessionName?: string; as?: string; pid?: number }, client: FarmClient) {
  return { session: `${SESSION_PREFIX}${owner.paneId}${owner.pid ? `:${owner.pid}` : ''}`, ...(owner.as ? { as: owner.as } : {}),
    ...(owner.sessionName ? { label: owner.sessionName } : {}), ...(owner.pid && client.name === 'local' ? { pid: owner.pid } : {}) }
}

const sameOwner = (a: LockOwner, b: LockOwner): boolean => a.paneId === b.paneId && (a.as ?? '') === (b.as ?? '') && (a.pid ?? 0) === (b.pid ?? 0)

function toResource(resource: FarmResource): DeviceResource {
  return { id: resource.id, name: resource.name, kind: resource.kind, ...(resource.serial ? { serial: resource.serial } : {}),
    ...(resource.release ? { release: resource.release } : {}), ...(resource.busyProcesses?.length ? { busyProcesses: resource.busyProcesses } : {}) }
}
