import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WebPanesApi } from './web-panes-api.js'
import { WebPaneService } from './web-panes.js'
import { WebPanePendingStore, PendingNotesJournal } from './web-pane-pending.js'
import { WebPaneFeedbackStore } from './web-pane-feedback.js'
import { FeedbackJournal } from './web-pane-feedback-journal.js'
import { CanvasThreadsStore } from './canvas-threads.js'

const token = 'agent-hook-token-at-least-32-characters'
const canvas = { frameId: 'settings', point: { x: 5, y: 7 }, label: 'Row', labelId: 'row', frameTitle: 'Settings', section: 'Accounts', ticket: 'APP-1', status: 'ready-for-dev', focus: 1, interactive: true }
const note = { selector: '#row', tag: 'button', text: 'Row', rect: { x: 2, y: 3, width: 10, height: 20 }, comment: 'Fix row', canvas, pageUrl: 'http://localhost/Settings.html' }
let dir: string, service: WebPaneService, api: WebPanesApi, pending: WebPanePendingStore, feedback: WebPaneFeedbackStore, threads: CanvasThreadsStore, id: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'canvas-note-api-'))
  service = new WebPaneService(join(dir, 'panes.json'))
  id = service.open({ url: 'http://localhost/board/', anchorPaneId: '%1', sessionId: '$1', windowId: '@1', openedBy: 'user', content: { kind: 'canvas', artifactId: '0123456789abcdef', manifest: 'canvas.json' } }).id
  pending = new WebPanePendingStore(new PendingNotesJournal({ dir }))
  feedback = new WebPaneFeedbackStore(new FeedbackJournal({ dir }))
  threads = new CanvasThreadsStore(join(dir, 'threads.json'))
  api = new WebPanesApi({ service, agentToken: token, ownerAuthorized: async (req) => req.headers['x-owner'] === 'yes', paneForId: () => undefined, onChange: vi.fn(), onPendingChanged: vi.fn(), pending, feedback, canvasThreads: threads, attachmentStore: {} as never, agentRequests: {} as never })
})
afterEach(async () => { await service.flush(); rmSync(dir, { recursive: true, force: true }) })
async function request(action: string, body?: unknown, auth: 'owner' | 'agent' | 'none' = 'owner', method = body === undefined ? 'GET' : 'POST') {
  const req = Readable.from(body === undefined ? [] : [JSON.stringify(body)]) as unknown as IncomingMessage
  req.method = method
  req.headers = { 'content-type': 'application/json', ...(auth === 'owner' ? { 'x-owner': 'yes' } : auth === 'agent' ? { authorization: `Bearer ${token}` } : {}) }
  const writeHead = vi.fn(), end = vi.fn(), setHeader = vi.fn()
  await api.handle(req, { writeHead, end, setHeader } as unknown as ServerResponse, new URL(`/api/web-panes/${id}/${action}`, 'http://localhost'))
  return { status: writeHead.mock.calls[0][0], body: JSON.parse(end.mock.calls[0][0]), setHeader }
}
describe('canvas pending/feedback/thread routes without sockets', () => {
  it('queues context, sends only selected revisions, delivers context and exposes threads to both callers', async () => {
    const queued = await request('pending', { note })
    expect(queued.status).toBe(200)
    expect(queued.body.notes[0].canvas).toEqual(canvas)
    expect(threads.list(id)).toEqual([])
    const second = await request('pending', { note: { ...note, comment: 'Another' } })
    const sent = await request('pending/send', { items: [{ id: 1, revision: 1 }], expectedQueueRevision: second.body.revision })
    expect(sent.status).toBe(200)
    expect(sent.body.notes.map((n: { id: number }) => n.id)).toEqual([2])
    const delivered = await request('feedback', undefined, 'agent')
    expect(delivered.body.notes[0]).toMatchObject({ canvas, comment: 'Fix row', pageUrl: note.pageUrl })
    for (const auth of ['owner', 'agent'] as const) {
      const result = await request('threads', undefined, auth)
      expect(result.status).toBe(200)
      expect(result.body.threads[0]).toMatchObject({ frameId: 'settings', point: canvas.point, messages: [{ author: 'user', text: 'Fix row', at: expect.any(Number) }] })
    }
    expect((await request('threads', undefined, 'none')).status).toBe(401)
    expect((await request('threads', {}, 'owner')).status).toBe(405)
    expect((await request('pending', undefined, 'agent')).status).toBe(403)
    const current = pending.snapshot(id)
    expect((await request('pending/send', { items: current.notes.map((n) => ({ id: n.id, revision: n.revision })), expectedQueueRevision: current.revision })).status).toBe(200)
    expect(threads.list(id)).toHaveLength(2)
    const drained = await feedback.drain(id, 0)
    await feedback.drain(id, 0, { cursor: drained.cursor })
    expect(threads.list(id)).toHaveLength(2)
    service.close(id); threads.retain(new Set())
    expect((await request('threads')).status).toBe(404)
  })
  it.each([{ frameId: '../bad' }, { point: { x: 1e7, y: 0 } }, { point: { x: '10', y: 0 } }, { label: 'x'.repeat(257) }, { labelId: false }, { focus: -1 }, { interactive: 'true' }, { status: 'bad' }])('rejects malformed canvas fields %j in pending and direct feedback', async (change) => {
    const malformed = { ...note, canvas: { ...canvas, ...change } }
    expect((await request('pending', { note: malformed })).status).toBe(400)
    expect((await request('feedback', { notes: [{ ...malformed, capturedAt: 1 }] })).status).toBe(400)
    expect(pending.list(id)).toEqual([])
  })
  it('guards stale queues and stale item revisions without creating sent pins', async () => {
    await request('pending', { note })
    expect((await request('pending/send', { items: [{ id: 1, revision: 1 }], expectedQueueRevision: 0 })).status).toBe(409)
    expect((await request('pending/send', { items: [{ id: 1, revision: 2 }], expectedQueueRevision: 1 })).status).toBe(409)
    expect(threads.list(id)).toEqual([])
    expect(pending.list(id)).toHaveLength(1)
  })
  it('queues SDK responses with frame context and preserves it when replacing an answer', async () => {
    const body = { pageUrl: note.pageUrl, canvas, response: { question: 'Ship?', answer: 'Yes', queueKey: 'ship' } }
    expect((await request('pending/response', body)).status).toBe(200)
    expect((await request('pending/response', { ...body, response: { ...body.response, answer: 'No' } })).body.notes[0]).toMatchObject({ canvas, revision: 2 })
    await request('pending/send', { items: [{ id: 1, revision: 2 }], expectedQueueRevision: 2 })
    expect((await request('feedback', undefined, 'agent')).body.notes[0].canvas).toEqual(canvas)
    expect(threads.list(id)).toHaveLength(1)
    expect((await request('pending/response', { ...body, canvas: { frameId: 'settings' } })).status).toBe(400)
  })
  it('retries a thread persistence failure without duplicating journal delivery or threads', async () => {
    await request('pending', { note })
    const record = vi.spyOn(threads, 'record').mockImplementationOnce(() => { throw new Error('thread disk failure') })
    expect((await request('pending/send', { items: [{ id: 1, revision: 1 }] })).status).toBe(500)
    expect(pending.list(id)).toHaveLength(1)
    expect(threads.list(id)).toEqual([])
    expect((await feedback.drain(id, 0)).notes).toHaveLength(1)
    record.mockRestore()
    expect((await request('pending/send', { items: [{ id: 1, revision: 1 }] })).status).toBe(200)
    expect((await feedback.drain(id, 0)).notes).toHaveLength(1)
    expect(threads.list(id)).toHaveLength(1)
    expect(pending.list(id)).toEqual([])
  })
  it('does not create threads when feedback enqueue fails, and creates them on direct owner feedback', async () => {
    await request('pending', { note })
    const enqueue = vi.spyOn(feedback, 'enqueue').mockImplementationOnce(() => { throw new Error('disk failure') })
    expect((await request('pending/send', { items: [{ id: 1, revision: 1 }] })).status).toBe(500)
    expect(threads.list(id)).toEqual([]); expect(pending.list(id)).toHaveLength(1)
    enqueue.mockRestore()
    expect((await request('feedback', { notes: [{ ...note, capturedAt: 1 }] })).status).toBe(200)
    expect(threads.list(id)).toHaveLength(1)
  })
})
