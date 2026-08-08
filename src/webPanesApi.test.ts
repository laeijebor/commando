import { describe, expect, it, vi } from 'vitest'
import { createWebPanesApi } from './webPanesApi'

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('submitFeedback', () => {
  it('POSTs notes to the feedback route', async () => {
    const fetcher = vi.fn(async () => jsonResponse(200, { ok: true }))
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
    const fetcher = vi.fn(async () => jsonResponse(429, { error: 'queue full' }))
    const api = createWebPanesApi('token', fetcher as unknown as typeof fetch)
    await expect(api.submitFeedback('w-11111111', [])).rejects.toThrowError('queue full')
  })
})

describe('pending note routes', () => {
  it('drives GET/POST/DELETE/send against the pending endpoints and returns the queue', async () => {
    const notes = [{ id: 1, selector: '#a', tag: 'div', rect: { x: 0, y: 0, width: 1, height: 1 }, comment: 'c' }]
    const fetcher = vi.fn(async () => jsonResponse(200, { ok: true, notes, knownUpTo: 1, dropped: 0 }))
    const api = createWebPanesApi('token', fetcher as unknown as typeof fetch)

    const snapshot = { notes, knownUpTo: 1, dropped: 0 }
    expect(await api.pendingNotes('w-11111111')).toEqual(snapshot)
    expect(await api.addPendingNote('w-11111111', { selector: '#a', tag: 'div', rect: { x: 0, y: 0, width: 1, height: 1 }, comment: 'c' })).toEqual(snapshot)
    expect(await api.removePendingNote('w-11111111', 1)).toEqual(snapshot)
    expect(await api.sendPendingNotes('w-11111111')).toEqual(snapshot)

    const calls = fetcher.mock.calls as unknown as [string, RequestInit][]
    expect(calls.map(([url, init]) => `${init.method} ${url}`)).toEqual([
      'GET /api/web-panes/w-11111111/pending',
      'POST /api/web-panes/w-11111111/pending',
      'DELETE /api/web-panes/w-11111111/pending/1',
      'POST /api/web-panes/w-11111111/pending/send',
    ])
    expect(JSON.parse(String(calls[1][1].body))).toEqual({
      note: { selector: '#a', tag: 'div', rect: { x: 0, y: 0, width: 1, height: 1 }, comment: 'c' },
    })
  })

  it('surfaces the server error message on a failed send', async () => {
    const fetcher = vi.fn(async () => jsonResponse(429, { error: 'queue full' }))
    const api = createWebPanesApi('token', fetcher as unknown as typeof fetch)
    await expect(api.sendPendingNotes('w-11111111')).rejects.toThrowError('queue full')
  })
})

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

describe('webPanesApi.navigate', () => {
  it('posts the url to the navigate endpoint', async () => {
    const fetcher = vi.fn(async () => jsonResponse(200, { ok: true }))
    const api = createWebPanesApi('tok', fetcher as unknown as typeof fetch)

    await api.navigate('w-0badcafe', 'http://localhost:4310/report')

    const [path, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit]
    expect(path).toBe('/api/web-panes/w-0badcafe/navigate')
    expect(init.method).toBe('POST')
    expect(init.body).toBe(JSON.stringify({ url: 'http://localhost:4310/report' }))
  })
})
