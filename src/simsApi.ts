import type { SimOpenResult, SimWallDevice } from '../shared/protocol'

const LISTING_STORAGE_KEY = 'commando.sims-listing'
export type CachedSimSnapshot = { url: string; at: number }
export const simsCache = {
  listing: undefined as SimWallDevice[] | undefined,
  snapshots: new Map<string, CachedSimSnapshot>(),
}

export function readCachedSims(): SimWallDevice[] | undefined {
  if (simsCache.listing) return simsCache.listing
  try {
    const stored: unknown = JSON.parse(window.localStorage.getItem(LISTING_STORAGE_KEY) ?? 'null')
    if (Array.isArray(stored) && stored.every((sim) => sim && typeof sim.udid === 'string'
      && typeof sim.name === 'string' && typeof sim.deviceModel === 'string'
      && typeof sim.runtime === 'string' && ['slim', 'unslimmed', 'unknown'].includes(sim.slim)
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
