import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/**
 * Locks on shared physical devices (phones, the emulator) and on heavy host jobs (builds, exports).
 * One ordered queue holds every waiting request; a request for "any" device lists several resources
 * and is served by whichever frees first. Agents are offered a lock and must claim it; scripts that
 * block (`wait`) are granted it straight away.
 */

export type DeviceKind = 'android' | 'ios' | 'emulator' | 'host'
export type DeviceResource = {
  id: string
  name: string
  kind: DeviceKind
  /** adb serial or CoreDevice identifier, handed to the holder. */
  serial?: string
  /** What the holder must do before releasing (restore the standard app, log the run, ...). */
  release?: string
  /** Command-line fragments that mean the resource is busy outside the lock (e.g. `xcodebuild`). */
  busyProcesses?: string[]
}
export type LockOwner = { paneId: string; sessionName: string; as?: string; pid?: number }
export type DeviceHolder = LockOwner & {
  resourceId: string; task: string; estimateMs?: number; acquiredAt: number
  /** The queue request this lock was granted from, so a blocked CLI can find it. */
  entryId?: string
}
export type LockMode = 'notify' | 'wait'
export type QueueEntry = LockOwner & {
  id: string
  /** What the requester asked for: a resource id or an `any-*` selector. */
  request: string
  resourceIds: string[]
  task: string
  estimateMs?: number
  mode: LockMode
  enqueuedAt: number
  offer?: { resourceId: string; at: number }
}
export type DeviceLockSnapshot = { resources: DeviceResource[]; holders: DeviceHolder[]; queue: QueueEntry[]; paused: string[] }
export type LockResult =
  | { status: 'held'; holder: DeviceHolder; resource: DeviceResource }
  | { status: 'offered'; entry: QueueEntry; resource: DeviceResource }
  | { status: 'queued'; entry: QueueEntry; position: number }
/** What a sweep changed, so the daemon can message the affected panes. */
export type SweepEvents = { offered: QueueEntry[]; expired: QueueEntry[]; ended: Array<DeviceHolder & { reason: 'pane-closed' | 'process-exited' }>; dropped: QueueEntry[] }
export type SweepContext = { paneExists: (paneId: string) => boolean; pidAlive: (pid: number) => boolean; busy?: BusyCheck }
/** Returns a short description of what is keeping the resource busy outside the lock, if anything. */
export type BusyCheck = (resource: DeviceResource) => string | undefined

export const OFFER_TIMEOUT_MS = 5 * 60_000
export const ANY_SELECTORS: Record<string, DeviceKind[]> = {
  any: ['android', 'ios', 'emulator'], 'any-phone': ['android', 'ios'], 'any-android': ['android'], 'any-ios': ['ios'],
}
const RESOURCE_ID = /^[a-z][a-z0-9-]{0,31}$/
const PANE_ID = /^%\d+$/
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/u
const KINDS: DeviceKind[] = ['android', 'ios', 'emulator', 'host']
const MAX_QUEUE = 200

export class DeviceLockError extends Error {
  constructor(readonly status: number, message: string) { super(message) }
}

export function defaultDeviceLockStatePath(port: number): string {
  return process.env.COMMANDO_DEVICE_LOCKS_PATH ?? join(homedir(), '.commando', `device-locks-${port}.json`)
}

function text(value: unknown, field: string, max: number, optional = false): string | undefined {
  if (value === undefined && optional) return undefined
  if (typeof value !== 'string' || CONTROL.test(value) || value.length > max) throw new DeviceLockError(400, `${field} must be text of at most ${max} characters without control characters`)
  const trimmed = value.replace(/\s+/gu, ' ').trim()
  if (!trimmed && !optional) throw new DeviceLockError(400, `${field} is required`)
  return trimmed || undefined
}

export function parseResource(value: Record<string, unknown>): DeviceResource {
  if (typeof value.id !== 'string' || !RESOURCE_ID.test(value.id) || value.id in ANY_SELECTORS) {
    throw new DeviceLockError(400, 'id must be lowercase letters, digits and dashes, and not an any-* selector')
  }
  if (!KINDS.includes(value.kind as DeviceKind)) throw new DeviceLockError(400, `kind must be one of ${KINDS.join(', ')}`)
  const busy = value.busyProcesses
  if (busy !== undefined && (!Array.isArray(busy) || busy.length > 12 || busy.some((entry) => typeof entry !== 'string' || !entry.trim() || entry.length > 80 || CONTROL.test(entry)))) {
    throw new DeviceLockError(400, 'busyProcesses must be at most 12 short command fragments')
  }
  const serial = text(value.serial, 'serial', 128, true), release = text(value.release, 'release', 1_000, true)
  return { id: value.id, name: text(value.name, 'name', 80)!, kind: value.kind as DeviceKind,
    ...(serial ? { serial } : {}), ...(release ? { release } : {}),
    ...(busy?.length ? { busyProcesses: (busy as string[]).map((entry) => entry.trim()) } : {}) }
}

function parseOwner(value: Record<string, unknown>): LockOwner {
  if (typeof value.paneId !== 'string' || !PANE_ID.test(value.paneId)) throw new DeviceLockError(400, 'paneId must be a tmux pane id')
  const as = text(value.as, 'as', 40, true)
  if (value.pid !== undefined && (!Number.isInteger(value.pid) || (value.pid as number) < 2)) throw new DeviceLockError(400, 'pid must be a process id')
  return { paneId: value.paneId, sessionName: text(value.sessionName ?? value.paneId, 'sessionName', 200)!, ...(as ? { as } : {}),
    ...(value.pid !== undefined ? { pid: value.pid as number } : {}) }
}

function parseEstimate(value: unknown): number | undefined {
  if (value === undefined) return undefined
  if (!Number.isFinite(value) || (value as number) <= 0 || (value as number) > 24 * 3_600_000) throw new DeviceLockError(400, 'estimateMs must be between 1 ms and 24 hours')
  return Math.round(value as number)
}

/** Same owner: same pane and, when either side names one, the same `--as` name. */
const sameOwner = (a: LockOwner, b: LockOwner): boolean => a.paneId === b.paneId && (a.as ?? '') === (b.as ?? '')

export function ownerLabel(owner: LockOwner): string {
  return owner.as ? `${owner.as} (${owner.sessionName})` : owner.sessionName
}

export class DeviceLockRegistry {
  private state: DeviceLockSnapshot = { resources: [], holders: [], queue: [], paused: [] }
  private readonly now: () => number
  private readonly statePath?: string
  /** Bumped on every change so long-polls can wake. */
  private revision = 0
  private readonly listeners = new Set<() => void>()

  constructor(options: { statePath?: string; now?: () => number } = {}) {
    this.now = options.now ?? Date.now
    this.statePath = options.statePath
    if (this.statePath) this.load(this.statePath)
  }

  snapshot(): DeviceLockSnapshot { return structuredClone(this.state) }
  get version(): number { return this.revision }
  onChange(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  resource(id: string): DeviceResource | undefined { return this.state.resources.find((entry) => entry.id === id) }

  addResource(input: Record<string, unknown>): DeviceResource {
    const resource = parseResource(input)
    this.commit({ ...this.state, resources: [...this.state.resources.filter((entry) => entry.id !== resource.id), resource] })
    return { ...resource }
  }

  removeResource(id: string): void {
    if (!this.resource(id)) throw new DeviceLockError(404, `No device lock named ${id}`)
    if (this.state.holders.some((entry) => entry.resourceId === id) || this.state.queue.some((entry) => entry.resourceIds.includes(id))) {
      throw new DeviceLockError(409, `${id} is held or has a queue; release and cancel those first`)
    }
    this.commit({ ...this.state, resources: this.state.resources.filter((entry) => entry.id !== id), paused: this.state.paused.filter((entry) => entry !== id) })
  }

  /** Resolves a resource id or `any-*` selector to the resources it covers. */
  resolve(request: string): DeviceResource[] {
    const kinds = ANY_SELECTORS[request]
    const matches = kinds ? this.state.resources.filter((entry) => kinds.includes(entry.kind)) : this.state.resources.filter((entry) => entry.id === request)
    if (!matches.length) {
      const known = this.state.resources.map((entry) => entry.id).join(', ') || 'none yet'
      throw new DeviceLockError(404, kinds ? `No ${request.replace('any-', '')} devices are registered` : `No device lock named ${request} (known: ${known})`)
    }
    return matches
  }

  /**
   * Takes a lock now if it is free, else joins the queue. Asking again is idempotent: a holder keeps
   * its lock, a queued request keeps its place, and an offered request is claimed.
   */
  lock(input: Record<string, unknown>, busy?: BusyCheck): LockResult {
    const owner = parseOwner(input)
    if (typeof input.request !== 'string') throw new DeviceLockError(400, 'request must name a device or an any-* selector')
    const resources = this.resolve(input.request)
    const task = text(input.task, 'task', 300)!
    const estimateMs = parseEstimate(input.estimateMs)
    const mode: LockMode = input.mode === 'wait' ? 'wait' : 'notify'
    const held = this.state.holders.find((entry) => sameOwner(entry, owner) && resources.some((resource) => resource.id === entry.resourceId))
    if (held) return { status: 'held', holder: { ...held }, resource: this.resource(held.resourceId)! }
    const existing = this.state.queue.find((entry) => sameOwner(entry, owner) && entry.request === input.request)
    if (existing?.offer) return this.claim(owner, existing.offer.resourceId)
    if (existing) return this.queued(existing)
    if (this.state.queue.length >= MAX_QUEUE) throw new DeviceLockError(429, 'The device queue is full')
    const entry: QueueEntry = { ...owner, id: randomUUID(), request: input.request, resourceIds: resources.map((resource) => resource.id),
      task, ...(estimateMs ? { estimateMs } : {}), mode, enqueuedAt: this.now() }
    const served = this.pump({ ...this.state, queue: [...this.state.queue, entry] }, new Set([entry.id]), busy)
    this.commit(served.state)
    const holder = served.granted.get(entry.id)
    if (holder) return { status: 'held', holder: { ...holder }, resource: this.resource(holder.resourceId)! }
    return this.queued(this.state.queue.find((candidate) => candidate.id === entry.id)!)
  }

  /** Accepts an offered lock. */
  claim(ownerInput: LockOwner | Record<string, unknown>, resourceId?: string): LockResult {
    const owner = parseOwner(ownerInput as Record<string, unknown>)
    const entry = this.state.queue.find((candidate) => sameOwner(candidate, owner) && candidate.offer && (!resourceId || candidate.offer.resourceId === resourceId || candidate.request === resourceId))
    if (!entry?.offer) {
      const held = this.state.holders.find((candidate) => sameOwner(candidate, owner) && (!resourceId || candidate.resourceId === resourceId))
      if (held) return { status: 'held', holder: { ...held }, resource: this.resource(held.resourceId)! }
      throw new DeviceLockError(409, resourceId ? `Nothing is offered to you on ${resourceId}` : 'Nothing is offered to you')
    }
    const holder = this.holderFor(entry, entry.offer.resourceId)
    this.commit({ ...this.state, holders: [...this.state.holders, holder], queue: this.state.queue.filter((candidate) => candidate.id !== entry.id) })
    return { status: 'held', holder: { ...holder }, resource: this.resource(holder.resourceId)! }
  }

  /** Releases what the owner holds (one resource, or all of them), then serves the queue. */
  release(ownerInput: LockOwner | Record<string, unknown>, resourceId?: string, busy?: BusyCheck): { released: DeviceHolder[]; offered: QueueEntry[] } {
    const owner = parseOwner(ownerInput as Record<string, unknown>)
    const released = this.state.holders.filter((entry) => sameOwner(entry, owner) && (!resourceId || entry.resourceId === resourceId) && (!owner.pid || !entry.pid || entry.pid === owner.pid))
    if (!released.length) throw new DeviceLockError(404, resourceId ? `You don't hold ${resourceId}` : 'You hold no device locks')
    const served = this.pump({ ...this.state, holders: this.state.holders.filter((entry) => !released.includes(entry)) }, new Set(), busy)
    this.commit(served.state)
    return { released: released.map((entry) => ({ ...entry })), offered: served.offered }
  }

  /** Leaves the queue (one request, or every request of this owner). */
  cancel(ownerInput: LockOwner | Record<string, unknown>, request?: string, busy?: BusyCheck): { cancelled: QueueEntry[]; offered: QueueEntry[] } {
    const owner = parseOwner(ownerInput as Record<string, unknown>)
    const cancelled = this.state.queue.filter((entry) => sameOwner(entry, owner) && (!request || entry.request === request || entry.resourceIds.includes(request)))
    if (!cancelled.length) throw new DeviceLockError(404, request ? `You are not queued for ${request}` : 'You are not queued for any device')
    const served = this.pump({ ...this.state, queue: this.state.queue.filter((entry) => !cancelled.includes(entry)) }, new Set(), busy)
    this.commit(served.state)
    return { cancelled: cancelled.map((entry) => ({ ...entry })), offered: served.offered }
  }

  /** A queue entry's place among the requests that compete for any of its resources (1-based). */
  position(entry: QueueEntry): number {
    const competing = this.state.queue.filter((candidate) => candidate.resourceIds.some((id) => entry.resourceIds.includes(id)))
    return competing.findIndex((candidate) => candidate.id === entry.id) + 1
  }

  entry(id: string): QueueEntry | undefined {
    const entry = this.state.queue.find((candidate) => candidate.id === id)
    return entry && { ...entry }
  }

  /** Who holds a resource right now (empty when free). */
  holdersOf(resourceId: string): DeviceHolder[] {
    return this.state.holders.filter((entry) => entry.resourceId === resourceId).map((entry) => ({ ...entry }))
  }

  /**
   * Housekeeping: ends locks whose pane closed or whose process exited, drops requests in the same
   * position, expires unclaimed offers, then serves the queue.
   */
  sweep(context: SweepContext): SweepEvents {
    const now = this.now()
    const alive = (owner: LockOwner) => context.paneExists(owner.paneId) && (owner.pid === undefined || context.pidAlive(owner.pid))
    const ended = this.state.holders.filter((entry) => !alive(entry))
      .map((entry) => ({ ...entry, reason: context.paneExists(entry.paneId) ? 'process-exited' as const : 'pane-closed' as const }))
    const dropped = this.state.queue.filter((entry) => !alive(entry))
    const expired = this.state.queue.filter((entry) => alive(entry) && entry.offer && now - entry.offer.at >= OFFER_TIMEOUT_MS)
    const gone = new Set([...dropped, ...expired].map((entry) => entry.id))
    const served = this.pump({ ...this.state, holders: this.state.holders.filter((entry) => alive(entry)),
      queue: this.state.queue.filter((entry) => !gone.has(entry.id)) }, new Set(), context.busy)
    if (ended.length || gone.size || served.offered.length || served.granted.size) this.commit(served.state)
    return { offered: served.offered, expired, ended, dropped }
  }

  // ---- Owner (Devices view) actions ----

  /** Moves a request before another one, or to the end when `before` is omitted. */
  reorder(entryId: string, before?: string): void {
    const entry = this.state.queue.find((candidate) => candidate.id === entryId)
    if (!entry) throw new DeviceLockError(404, 'That request is no longer queued')
    const rest = this.state.queue.filter((candidate) => candidate.id !== entryId)
    const index = before === undefined ? rest.length : rest.findIndex((candidate) => candidate.id === before)
    if (index < 0) throw new DeviceLockError(404, 'The target request is no longer queued')
    this.commit({ ...this.state, queue: [...rest.slice(0, index), entry, ...rest.slice(index)] })
  }

  setPaused(resourceId: string, paused: boolean, busy?: BusyCheck): QueueEntry[] {
    if (!this.resource(resourceId)) throw new DeviceLockError(404, `No device lock named ${resourceId}`)
    const others = this.state.paused.filter((entry) => entry !== resourceId)
    const served = this.pump({ ...this.state, paused: paused ? [...others, resourceId] : others }, new Set(), busy)
    this.commit(served.state)
    return served.offered
  }

  /** Ends someone else's lock (the user's Release button). */
  forceRelease(resourceId: string, busy?: BusyCheck): { released: DeviceHolder[]; offered: QueueEntry[] } {
    const released = this.state.holders.filter((entry) => entry.resourceId === resourceId)
    if (!released.length) throw new DeviceLockError(404, `${resourceId} is not held`)
    const served = this.pump({ ...this.state, holders: this.state.holders.filter((entry) => !released.includes(entry)) }, new Set(), busy)
    this.commit(served.state)
    return { released, offered: served.offered }
  }

  /** Removes a request (or withdraws its offer) from the queue. */
  remove(entryId: string, busy?: BusyCheck): { removed: QueueEntry; offered: QueueEntry[] } {
    const removed = this.state.queue.find((entry) => entry.id === entryId)
    if (!removed) throw new DeviceLockError(404, 'That request is no longer queued')
    const served = this.pump({ ...this.state, queue: this.state.queue.filter((entry) => entry !== removed) }, new Set(), busy)
    this.commit(served.state)
    return { removed, offered: served.offered }
  }

  /** Serves the queue: each free, unpaused resource goes to the first request that wants it. */
  private pump(state: DeviceLockSnapshot, grantNow: Set<string>, busy: BusyCheck | undefined): { state: DeviceLockSnapshot; offered: QueueEntry[]; granted: Map<string, DeviceHolder> } {
    let { holders, queue } = state
    const offered: QueueEntry[] = [], granted = new Map<string, DeviceHolder>()
    for (const resource of state.resources) {
      if (state.paused.includes(resource.id) || holders.some((entry) => entry.resourceId === resource.id) ||
        queue.some((entry) => entry.offer?.resourceId === resource.id)) continue
      const next = queue.find((entry) => !entry.offer && entry.resourceIds.includes(resource.id))
      if (!next || busy?.(resource)) continue
      if (next.mode === 'wait' || grantNow.has(next.id)) {
        const holder = this.holderFor(next, resource.id)
        holders = [...holders, holder]
        granted.set(next.id, holder)
        queue = queue.filter((entry) => entry.id !== next.id)
      } else {
        const entry = { ...next, offer: { resourceId: resource.id, at: this.now() } }
        queue = queue.map((candidate) => candidate.id === next.id ? entry : candidate)
        offered.push(entry)
      }
    }
    return { state: { ...state, holders, queue }, offered, granted }
  }

  private holderFor(entry: QueueEntry, resourceId: string): DeviceHolder {
    return { paneId: entry.paneId, sessionName: entry.sessionName, ...(entry.as ? { as: entry.as } : {}), ...(entry.pid ? { pid: entry.pid } : {}),
      resourceId, task: entry.task, ...(entry.estimateMs ? { estimateMs: entry.estimateMs } : {}), acquiredAt: this.now(), entryId: entry.id }
  }

  private queued(entry: QueueEntry): LockResult {
    if (entry.offer) return { status: 'offered', entry: { ...entry }, resource: this.resource(entry.offer.resourceId)! }
    return { status: 'queued', entry: { ...entry }, position: this.position(entry) }
  }

  private load(path: string): void {
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8'))
      if (parsed?.version !== 1) return
      const resources: DeviceResource[] = []
      for (const value of Array.isArray(parsed.resources) ? parsed.resources : []) {
        try { const resource = parseResource(value); if (!resources.some((entry) => entry.id === resource.id)) resources.push(resource) } catch { /* skip */ }
      }
      const known = new Set(resources.map((entry) => entry.id))
      const holders: DeviceHolder[] = []
      for (const value of Array.isArray(parsed.holders) ? parsed.holders : []) {
        try {
          if (!known.has(value.resourceId) || !Number.isFinite(value.acquiredAt)) continue
          holders.push({ ...parseOwner(value), resourceId: value.resourceId, task: text(value.task, 'task', 300)!,
            ...(parseEstimate(value.estimateMs) ? { estimateMs: parseEstimate(value.estimateMs) } : {}), acquiredAt: Math.min(value.acquiredAt, this.now()),
            ...(typeof value.entryId === 'string' ? { entryId: value.entryId } : {}) })
        } catch { /* skip */ }
      }
      const queue: QueueEntry[] = []
      for (const value of Array.isArray(parsed.queue) ? parsed.queue : []) {
        try {
          if (typeof value.id !== 'string' || typeof value.request !== 'string' || !Array.isArray(value.resourceIds) || !Number.isFinite(value.enqueuedAt)) continue
          const resourceIds = value.resourceIds.filter((id: unknown) => typeof id === 'string' && known.has(id))
          if (!resourceIds.length) continue
          const offer = value.offer && known.has(value.offer.resourceId) && Number.isFinite(value.offer.at) ? { resourceId: value.offer.resourceId as string, at: Math.min(value.offer.at, this.now()) } : undefined
          queue.push({ ...parseOwner(value), id: value.id, request: value.request, resourceIds, task: text(value.task, 'task', 300)!,
            ...(parseEstimate(value.estimateMs) ? { estimateMs: parseEstimate(value.estimateMs) } : {}), mode: value.mode === 'wait' ? 'wait' : 'notify',
            enqueuedAt: Math.min(value.enqueuedAt, this.now()), ...(offer ? { offer } : {}) })
        } catch { /* skip */ }
      }
      const paused = (Array.isArray(parsed.paused) ? parsed.paused : []).filter((id: unknown): id is string => typeof id === 'string' && known.has(id))
      this.state = { resources, holders, queue, paused }
    } catch { /* Missing or corrupt state starts empty. */ }
  }

  private commit(state: DeviceLockSnapshot): void {
    if (this.statePath) {
      mkdirSync(dirname(this.statePath), { recursive: true, mode: 0o700 })
      const temporary = `${this.statePath}.${process.pid}.tmp`
      writeFileSync(temporary, JSON.stringify({ version: 1, ...state }, null, 2), { mode: 0o600 })
      renameSync(temporary, this.statePath)
    }
    this.state = state
    this.revision++
    for (const listener of this.listeners) {
      try { listener() } catch (error) { console.warn('[device-locks] change listener failed', error) }
    }
  }
}
