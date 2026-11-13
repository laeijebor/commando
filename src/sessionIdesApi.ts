import type { SessionIde } from '../shared/protocol'

export function createSessionIdesApi(token: string, fetcher: typeof fetch = fetch) {
  const request = async (sessionId: string, method: 'POST' | 'DELETE', paneId?: string) => {
    const response = await fetcher(`/api/ides/sessions/${encodeURIComponent(sessionId)}`, {
      method,
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(method === 'POST' ? { body: JSON.stringify(paneId ? { paneId } : {}) } : {}),
    })
    const body = await response.json() as { ide?: SessionIde; error?: string }
    if (!response.ok) throw new Error(body.error ?? `IDE request failed (${response.status})`)
    return body
  }
  return {
    open: async (sessionId: string, paneId?: string): Promise<SessionIde> => {
      const body = await request(sessionId, 'POST', paneId)
      if (!body.ide) throw new Error('The daemon did not return an IDE attachment')
      return body.ide
    },
    detach: async (sessionId: string): Promise<void> => { await request(sessionId, 'DELETE') },
    /** Opens a file in the session's already-loaded IDE window. */
    openFile: async (sessionId: string, path: string): Promise<void> => {
      const response = await fetcher(`/api/ides/sessions/${encodeURIComponent(sessionId)}/files`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ path }),
      })
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { error?: string }
        throw new Error(body.error ?? `Unable to open file in IDE (${response.status})`)
      }
    },
  }
}
