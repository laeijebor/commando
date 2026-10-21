import type { CanvasMove, CanvasStatusChange, CanvasWriteResult } from '../shared/canvas-manifest'

export type CanvasLayoutChange = { moves: CanvasMove[] } | { notes: CanvasMove[] } | { statuses: CanvasStatusChange[] }

export async function writeCanvasLayout(artifactId: string, manifest: string, expectedHash: string, change: CanvasLayoutChange, token: string): Promise<CanvasWriteResult> {
  const kind = 'statuses' in change ? 'sections' : 'notes' in change ? 'annotations' : 'frames'
  const response = await canvasRequest(`/api/redline/artifacts/${encodeURIComponent(artifactId)}/canvas/${kind}`, token, {
    method: 'PATCH', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ manifest, expectedHash, ...('notes' in change ? { moves: change.notes } : change) }),
  }, 'Canvas write failed')
  const body = await response.json()
  return body as CanvasWriteResult
}

/** Canvas API transport owns owner auth and consistent server/fallback errors. */
export async function canvasRequest(url: string, token: string | undefined, init: RequestInit = {}, failure = 'Canvas request failed'): Promise<Response> {
  const response = await fetch(url, token === undefined ? init : { ...init, credentials: 'same-origin',
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...init.headers },
  })
  if (!response.ok) {
    let body: { error?: string } = {}
    try { body = await response.json() } catch { /* Non-JSON failures use the status fallback. */ }
    throw Object.assign(new Error(body?.error || `${failure} (${response.status})`), { status: response.status })
  }
  return response
}
