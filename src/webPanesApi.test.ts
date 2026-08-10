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
    expect(JSON.parse(String(calls[3][1].body))).toEqual({})
  })

  it('updates an answer and note using the expected revision', async () => {
    const fetcher = vi.fn(async () => jsonResponse(200, { revision: 4, notes: [], knownUpTo: 1, dropped: 0 }))
    const api = createWebPanesApi('token', fetcher as unknown as typeof fetch)

    await expect(api.updatePendingNote('w/id', 7, 3, { answer: 'Team', note: 'Need SSO' })).resolves.toEqual({
      revision: 4,
      notes: [],
      knownUpTo: 1,
      dropped: 0,
    })

    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/web-panes/w%2Fid/pending/7')
    expect(init.method).toBe('PATCH')
    expect(JSON.parse(String(init.body))).toEqual({ expectedRevision: 3, answer: 'Team', note: 'Need SSO' })
  })

  it('uploads an attachment as the raw file with binary headers', async () => {
    const fetcher = vi.fn(async () => jsonResponse(200, { notes: [], knownUpTo: 1, dropped: 0 }))
    const api = createWebPanesApi('token', fetcher as unknown as typeof fetch)
    const file = new File(['image bytes'], 'résumé #1.png', { type: 'image/png' })

    await api.uploadPendingAttachment('w/id', 7, 3, file)

    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit]
    const headers = new Headers(init.headers)
    expect(url).toBe('/api/web-panes/w%2Fid/pending/7/attachments')
    expect(init.method).toBe('POST')
    expect(init.body).toBe(file)
    expect(headers.get('Accept')).toBe('application/json')
    expect(headers.get('Authorization')).toBe('Bearer token')
    expect(headers.get('Content-Type')).toBe('image/png')
    expect(headers.get('X-Pending-Revision')).toBe('3')
    expect(headers.get('X-File-Name')).toBe('r%C3%A9sum%C3%A9%20%231.png')
  })

  it('removes an encoded attachment using the expected revision header', async () => {
    const fetcher = vi.fn(async () => jsonResponse(200, { notes: [], knownUpTo: 1, dropped: 0 }))
    const api = createWebPanesApi('token', fetcher as unknown as typeof fetch)

    await api.removePendingAttachment('w/id', 7, 3, 'attachment/id.png')

    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/web-panes/w%2Fid/pending/7/attachments/attachment%2Fid.png')
    expect(init.method).toBe('DELETE')
    expect(new Headers(init.headers).get('X-Pending-Revision')).toBe('3')
  })

  it('sends only selected pending note ids when provided', async () => {
    const fetcher = vi.fn(async () => jsonResponse(200, { notes: [], knownUpTo: 2, dropped: 0 }))
    const api = createWebPanesApi('token', fetcher as unknown as typeof fetch)

    await api.sendPendingNotes('w-11111111', [2, 4] as const)

    const [, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit]
    expect(JSON.parse(String(init.body))).toEqual({ ids: [2, 4] })
  })

  it('builds encoded same-origin attachment URLs and omits an empty token', () => {
    expect(createWebPanesApi('token/value').pendingAttachmentUrl('w/id', 'attachment/id.png')).toBe(
      '/api/web-panes/w%2Fid/attachments/attachment%2Fid.png?token=token%2Fvalue',
    )
    expect(createWebPanesApi('').pendingAttachmentUrl('w/id', 'attachment/id.png')).toBe(
      '/api/web-panes/w%2Fid/attachments/attachment%2Fid.png',
    )
  })

  it('retains optional snapshot and pending-note fields without adding absent revisions', async () => {
    const note = {
      id: 1,
      revision: 2,
      selector: '#a',
      tag: 'button',
      rect: { x: 0, y: 0, width: 1, height: 1 },
      comment: 'Which plan?: Team\n\nNote: Need SSO',
      response: { question: 'Which plan?', answer: 'Team', note: 'Need SSO' },
      attachments: [{ id: 'image.png', name: 'image.png', contentType: 'image/png', size: 12 }],
    }
    const fetcher = vi.fn(async () => jsonResponse(200, { revision: 8, notes: [note], knownUpTo: 1, dropped: 0 }))
    const api = createWebPanesApi('', fetcher as unknown as typeof fetch)

    const snapshot = await api.pendingNotes('w-11111111')
    expect(snapshot).toEqual({ revision: 8, notes: [note], knownUpTo: 1, dropped: 0 })
    expect(snapshot.notes[0]).toEqual(note)
  })

  it('surfaces the server error message on a failed send', async () => {
    const fetcher = vi.fn(async () => jsonResponse(429, { error: 'queue full' }))
    const api = createWebPanesApi('token', fetcher as unknown as typeof fetch)
    await expect(api.sendPendingNotes('w-11111111')).rejects.toThrowError('queue full')
  })

  it('decodes server JSON errors from attachment uploads', async () => {
    const fetcher = vi.fn(async () => jsonResponse(415, { error: 'Only PNG, JPEG, GIF, and WebP images are supported' }))
    const api = createWebPanesApi('token', fetcher as unknown as typeof fetch)
    const file = new File(['text'], 'notes.txt', { type: 'text/plain' })

    await expect(api.uploadPendingAttachment('w-11111111', 1, 1, file)).rejects.toThrowError(
      'Only PNG, JPEG, GIF, and WebP images are supported',
    )
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
