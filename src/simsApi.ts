import type { SimOpenResult, SimWallDevice } from '../shared/protocol'

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
    // The /api alias also reaches the daemon through the development proxy.
    viewUrl: (udid: string): string => {
      const url = new URL(`/api/sims/${encodeURIComponent(udid)}/view`, window.location.href)
      if (token) url.searchParams.set('token', token)
      return url.toString()
    },
    list: async (signal?: AbortSignal): Promise<SimWallDevice[]> => (await (await request('', 'GET', signal)).json()).sims,
    snapshot: async (udid: string, signal: AbortSignal): Promise<Blob> => (await request(`/${encodeURIComponent(udid)}/snapshot.jpg`, 'GET', signal)).blob(),
    slim: async (udid: string): Promise<void> => { await request(`/${encodeURIComponent(udid)}/slim`, 'POST') },
    open: async (udid: string): Promise<SimOpenResult> => (await request(`/${encodeURIComponent(udid)}/open`, 'POST')).json(),
  }
}

export type SimsApiClient = ReturnType<typeof createSimsApi>
