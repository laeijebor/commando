import type { GuideSnapshot } from '../shared/guide'

export type GuideApi = {
  load(webPaneId: string): Promise<GuideSnapshot>
  mark(webPaneId: string, change: { id: string; checked?: boolean; note?: string }): Promise<GuideSnapshot>
  update(webPaneId: string): Promise<GuideSnapshot>
  cancelUpdate(webPaneId: string): Promise<GuideSnapshot>
  reset(webPaneId: string): Promise<GuideSnapshot>
}

export function createGuideApi(token: string, fetcher: typeof fetch = fetch): GuideApi {
  const request = async (webPaneId: string, path: string, init: RequestInit = {}): Promise<GuideSnapshot> => {
    const response = await fetcher(`/api/web-panes/${encodeURIComponent(webPaneId)}/guide${path}`, {
      ...init,
      credentials: 'same-origin',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    })
    const body = await response.json().catch(() => null) as { guide?: GuideSnapshot; error?: string } | null
    if (!response.ok || !body?.guide) throw new Error(body?.error ?? `Guide request failed (${response.status})`)
    return body.guide
  }
  return {
    load: (id) => request(id, ''),
    mark: (id, change) => request(id, '/steps', { method: 'POST', body: JSON.stringify(change) }),
    update: (id) => request(id, '/update', { method: 'POST', body: '{}' }),
    cancelUpdate: (id) => request(id, '/update', { method: 'DELETE' }),
    reset: (id) => request(id, '/reset', { method: 'POST', body: '{}' }),
  }
}
