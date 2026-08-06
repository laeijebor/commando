import { describe, expect, it, vi } from 'vitest'
import { createWebPanesApi } from './webPanesApi'

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('webPanesApi.move', () => {
  it('posts the anchor and placement to the move endpoint', async () => {
    const fetcher = vi.fn(async () => jsonResponse(200, { ok: true }))
    const api = createWebPanesApi('tok', fetcher as unknown as typeof fetch)

    await api.move('w-0badcafe', '%40', 'below')

    expect(fetcher).toHaveBeenCalledTimes(1)
    const [path, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit]
    expect(path).toBe('/api/web-panes/w-0badcafe/move')
    expect(init.method).toBe('POST')
    expect(init.body).toBe(JSON.stringify({ anchor: '%40', placement: 'below' }))
  })

  it('surfaces the server error message', async () => {
    const fetcher = vi.fn(async () =>
      jsonResponse(400, { error: 'Web panes can only move within their window' }))
    const api = createWebPanesApi('tok', fetcher as unknown as typeof fetch)

    await expect(api.move('w-0badcafe', '%40', 'right')).rejects.toThrow(/within their window/)
  })
})
