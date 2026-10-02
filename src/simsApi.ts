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
    slim: async (udid: string): Promise<void> => { await request(`/${encodeURIComponent(udid)}/slim`, 'POST') },
    open: async (udid: string): Promise<SimOpenResult> => (await request(`/${encodeURIComponent(udid)}/open`, 'POST')).json(),
  }
}

export type SimsApiClient = ReturnType<typeof createSimsApi>
