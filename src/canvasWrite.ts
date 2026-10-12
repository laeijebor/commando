import type { CanvasMove, CanvasStatusChange, CanvasWriteResult } from '../shared/canvas-manifest'

export async function writeCanvasLayout(artifactId: string, manifest: string, expectedHash: string, change: { moves: CanvasMove[] } | { statuses: CanvasStatusChange[] }, token: string): Promise<CanvasWriteResult> {
  const response = await fetch(`/api/redline/artifacts/${encodeURIComponent(artifactId)}/canvas/${'moves' in change ? 'frames' : 'sections'}`, {
    method: 'PATCH', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ manifest, expectedHash, ...change }),
  })
  const body = await response.json()
  if (!response.ok) throw Object.assign(new Error(body?.error || `Canvas write failed (${response.status})`), { status: response.status })
  return body as CanvasWriteResult
}
