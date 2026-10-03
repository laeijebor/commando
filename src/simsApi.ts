import type { SimOpenResult, SimWallDevice } from '../shared/protocol'

const LISTING_STORAGE_KEY = 'commando.sims-listing'
export type CachedSimSnapshot = { url: string; at: number }
export const simsCache = {
  listing: undefined as SimWallDevice[] | undefined,
  snapshots: new Map<string, CachedSimSnapshot>(),
}

// Each eligible card joins the queue; only its first member owns the timer/fetch.
const snapshotPollers = new Map<string, Map<symbol, () => () => void>>()
const pollingCleanup = new Map<string, () => void>()
const snapshotSubscribers = new Map<string, Set<(frame: CachedSimSnapshot) => void>>()

export function subscribeSimSnapshot(udid: string, listener: (frame: CachedSimSnapshot) => void): () => void {
  const listeners = snapshotSubscribers.get(udid) ?? new Set()
  listeners.add(listener)
  snapshotSubscribers.set(udid, listeners)
  const frame = simsCache.snapshots.get(udid)
  if (frame) listener(frame)
  return () => {
    listeners.delete(listener)
    if (!listeners.size) snapshotSubscribers.delete(udid)
  }
}

export function cacheSimSnapshot(udid: string, frame: CachedSimSnapshot): void {
  const previous = simsCache.snapshots.get(udid)
  simsCache.snapshots.set(udid, frame)
  for (const listener of snapshotSubscribers.get(udid) ?? []) listener(frame)
  if (previous && previous.url !== frame.url) URL.revokeObjectURL(previous.url)
}

export function claimSimSnapshotPolling(udid: string, start: () => () => void): () => void {
  const members = snapshotPollers.get(udid) ?? new Map()
  const id = Symbol()
  members.set(id, start)
  snapshotPollers.set(udid, members)
  if (members.size === 1) pollingCleanup.set(udid, start())
  return () => {
    const owned = members.keys().next().value === id
    members.delete(id)
    if (owned) {
      pollingCleanup.get(udid)?.()
      pollingCleanup.delete(udid)
      // A regroup can remove both copies in the same commit. Wait for those
      // cleanups before transferring ownership to avoid a fetch that is aborted immediately.
      queueMicrotask(() => {
        if (snapshotPollers.get(udid) !== members || pollingCleanup.has(udid)) return
        const next = members.values().next().value
        if (next) pollingCleanup.set(udid, next())
      })
    }
    if (!members.size) snapshotPollers.delete(udid)
  }
}

export function readCachedSims(): SimWallDevice[] | undefined {
  if (simsCache.listing) return simsCache.listing
  try {
    const stored: unknown = JSON.parse(window.localStorage.getItem(LISTING_STORAGE_KEY) ?? 'null')
    if (Array.isArray(stored) && stored.every((sim) => sim && typeof sim.udid === 'string'
      && typeof sim.name === 'string' && typeof sim.deviceModel === 'string'
      && typeof sim.runtime === 'string' && ['slim', 'unslimmed', 'unknown'].includes(sim.slim)
      && (sim.endedLease === undefined || sim.endedLease === null || (typeof sim.endedLease === 'object'
        && typeof sim.endedLease.sessionName === 'string' && typeof sim.endedLease.task === 'string'
        && typeof sim.endedLease.label === 'string' && Number.isFinite(sim.endedLease.endedAt)
        && ['pane-closed', 'released'].includes(sim.endedLease.reason)))
      && (sim.lease === null || (sim.lease && typeof sim.lease.sessionName === 'string')))) {
      simsCache.listing = stored
    }
  } catch { /* Storage may be unavailable or malformed. */ }
  return simsCache.listing
}

export function cacheSims(sims: SimWallDevice[]): void {
  simsCache.listing = sims
  const udids = new Set(sims.map((sim) => sim.udid))
  for (const [udid, frame] of simsCache.snapshots) {
    if (!udids.has(udid)) { URL.revokeObjectURL(frame.url); simsCache.snapshots.delete(udid) }
  }
  try { window.localStorage.setItem(LISTING_STORAGE_KEY, JSON.stringify(sims)) } catch { /* Storage may be unavailable. */ }
}

export function createSimsApi(token: string, fetcher: typeof fetch = fetch) {
  const request = async (path: string, method: 'GET' | 'POST', signal?: AbortSignal) => {
    const response = await fetcher(`/api/sims${path}`, {
      method, signal, credentials: 'same-origin', cache: 'no-store',
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    })
    if (!response.ok) {
      const body = await response.json().catch(() => null) as { error?: string } | null
      throw new Error(body?.error ?? `Simulator request failed (${response.status})`)
    }
    return response
  }
  return {
    show: async (udid: string, anchor: string): Promise<{ webPaneId: string }> => {
      const response = await fetcher('/api/web-panes', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ content: { kind: 'simulator', udid }, anchor }),
      })
      if (!response.ok) {
        const body = await response.json().catch(() => null) as { error?: string } | null
        throw new Error(body?.error ?? `Simulator tile request failed (${response.status})`)
      }
      return response.json()
    },
    list: async (signal?: AbortSignal): Promise<SimWallDevice[]> => (await (await request('', 'GET', signal)).json()).sims,
    /** The listing plus whether the daemon answered from cache while refreshing. */
    listing: async (signal?: AbortSignal): Promise<{ sims: SimWallDevice[]; stale: boolean }> => {
      const payload = await (await request('', 'GET', signal)).json() as { sims: SimWallDevice[]; stale?: boolean }
      return { sims: payload.sims, stale: payload.stale === true }
    },
    snapshot: async (udid: string, signal: AbortSignal): Promise<Blob> => (await request(`/${encodeURIComponent(udid)}/snapshot.jpg`, 'GET', signal)).blob(),
    snapshotFrame: async (udid: string, signal: AbortSignal): Promise<{ blob: Blob; at: number }> => {
      const response = await request(`/${encodeURIComponent(udid)}/snapshot.jpg`, 'GET', signal)
      const header = response.headers.get('X-Commando-Snapshot-At')
      const at = header === null ? NaN : Number(header)
      return { blob: await response.blob(), at: Number.isFinite(at) ? at : Date.now() }
    },
    slim: async (udid: string): Promise<void> => { await request(`/${encodeURIComponent(udid)}/slim`, 'POST') },
    open: async (udid: string): Promise<SimOpenResult> => (await request(`/${encodeURIComponent(udid)}/open`, 'POST')).json(),
  }
}

export type SimsApiClient = ReturnType<typeof createSimsApi>
