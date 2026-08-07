import { describe, expect, it, vi } from 'vitest'
import { createWebPanesApi } from './webPanesApi'

describe('submitFeedback', () => {
  it('POSTs notes to the feedback route', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }))
    const api = createWebPanesApi('token', fetcher as unknown as typeof fetch)
    const note = {
      selector: '#a', tag: 'div', rect: { x: 0, y: 0, width: 1, height: 1 },
      comment: 'c', pageUrl: 'http://127.0.0.1:5173/', capturedAt: 1,
    }
    await api.submitFeedback('w-11111111', [note])
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/web-panes/w-11111111/feedback')
    expect(init.method).toBe('POST')
    expect(JSON.parse(String(init.body))).toEqual({ notes: [note] })
  })

  it('surfaces the server error message', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ error: 'queue full' }), { status: 429 }))
    const api = createWebPanesApi('token', fetcher as unknown as typeof fetch)
    await expect(api.submitFeedback('w-11111111', [])).rejects.toThrowError('queue full')
  })
})
