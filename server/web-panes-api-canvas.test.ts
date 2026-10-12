import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WebPaneFeedbackNote } from '../shared/protocol.js'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { WebPanesApi } from './web-panes-api.js'
import { WebPaneService } from './web-panes.js'
import { WebPanePendingStore, PendingNotesJournal } from './web-pane-pending.js'
import { WebPaneFeedbackStore } from './web-pane-feedback.js'
import { FeedbackJournal } from './web-pane-feedback-journal.js'
import { CanvasSpotlightStore } from './canvas-spotlight.js'
import { CanvasThreadsStore } from './canvas-threads.js'

const token = 'agent-hook-token-at-least-32-characters'
const canvas = { frameId: 'settings', point: { x: 5, y: 7 }, label: 'Row', labelId: 'row', frameTitle: 'Settings', section: 'Accounts', ticket: 'APP-1', status: 'ready-for-dev', focus: 1, interactive: true }
const note = { selector: '#row', tag: 'button', text: 'Row', rect: { x: 2, y: 3, width: 10, height: 20 }, comment: 'Fix row', canvas, pageUrl: 'http://localhost/Settings.html' }
let spotlight: CanvasSpotlightStore, onCanvasSent: Mock<(id: string, notes: WebPaneFeedbackNote[]) => void>
let dir: string, service: WebPaneService, api: WebPanesApi, pending: WebPanePendingStore, feedback: WebPaneFeedbackStore, threads: CanvasThreadsStore, id: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'canvas-note-api-'))
  service = new WebPaneService(join(dir, 'panes.json'))
  id = service.open({ url: 'http://localhost/board/', anchorPaneId: '%1', sessionId: '$1', windowId: '@1', openedBy: 'user', content: { kind: 'canvas', artifactId: '0123456789abcdef', manifest: 'canvas.json' } }).id
  pending = new WebPanePendingStore(new PendingNotesJournal({ dir }))
  feedback = new WebPaneFeedbackStore(new FeedbackJournal({ dir }))
  threads = new CanvasThreadsStore(join(dir, 'threads.json'))
  spotlight = new CanvasSpotlightStore(); onCanvasSent = vi.fn()
  api = new WebPanesApi({ spotlight, onCanvasSent, service, agentToken: token, ownerAuthorized: async (req) => req.headers['x-owner'] === 'yes', paneForId: () => undefined, onChange: vi.fn(), onPendingChanged: vi.fn(), pending, feedback, canvasThreads: threads, attachmentStore: {} as never, agentRequests: {} as never })
})
afterEach(async () => { await service.flush(); rmSync(dir, { recursive: true, force: true }) })
async function request(action: string, body?: unknown, auth: 'owner' | 'agent' | 'none' = 'owner', method = body === undefined ? 'GET' : 'POST') {
  const req = Readable.from(body === undefined ? [] : [JSON.stringify(body)], { autoDestroy: false }) as unknown as IncomingMessage
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
    expect(onCanvasSent.mock.calls[0][1][0].canvas?.threadId).toBe(threads.list(id)[0].id)
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
  it('agent/owner replies, status, user follow-up context and journal delivery', async () => {
    await request('pending', { note }); await request('pending/send', {})
    const threadId = threads.list(id)[0].id
    const route = `threads/${threadId}`
    expect((await request(`${route}/replies`, { text: 'Done', resolve: true }, 'agent')).status).toBe(200)
    expect(threads.list(id)[0]).toMatchObject({ status: 'resolved', messages: [{ author: 'user', text: 'Fix row' }, { author: 'agent', text: 'Done' }] })
    expect((await request(`${route}/status`, { status: 'open' }, 'owner')).status).toBe(200)
    expect((await request(`${route}/status`, { status: 'resolved' }, 'agent')).status).toBe(200)
    expect((await request(`${route}/replies`, { text: 'Follow-up', author: 'user' })).status).toBe(200)
    const current = threads.list(id)[0]
    expect(current.status).toBe('open')
    expect(current.messages).toHaveLength(3)
    expect(current.messages[2]).toMatchObject({ author: 'user', text: 'Follow-up' })
    expect(pending.list(id)).toEqual([])
    const delivered = await feedback.drain(id, 0)
    expect(delivered.notes[0].canvas?.threadId).toBe(threadId)
    expect(delivered.notes[1]).toMatchObject({ ...note, comment: 'Follow-up', canvas: { ...canvas, threadId } })
    expect(onCanvasSent).toHaveBeenCalledTimes(2)
    expect((await request(`${route}/replies`, { text: 'Owner can act as agent' })).status).toBe(200)
    expect(threads.list(id)[0].messages.at(-1)?.author).toBe('agent')
  })
  it('guards reply and status auth, methods, IDs, bounds and cap', async () => {
    await request('pending', { note }); await request('pending/send', {})
    const threadId = threads.list(id)[0].id, route = `threads/${threadId}`
    expect((await request(`${route}/replies`, { text: 'No' }, 'none')).status).toBe(401)
    expect((await request(`${route}/status`, { status: 'open' }, 'none')).status).toBe(401)
    expect((await request(`${route}/replies`, { text: 'No', author: 'user' }, 'agent')).status).toBe(403)
    for (const body of [{ text: '' }, { text: '  ' }, { text: 'x'.repeat(4097) }, { text: 1 }, { text: 'ok', resolve: 'yes' }, { text: 'ok', author: 'other' }]) {
      expect((await request(`${route}/replies`, body, 'agent')).status).toBe(400)
    }
    expect((await request(`${route}/status`, { status: 'replied' })).status).toBe(400)
    expect((await request(`${route}/replies`, undefined, 'agent')).status).toBe(405)
    expect((await request(`${route}/status`, undefined)).status).toBe(405)
    expect((await request(`threads/ct-${'0'.repeat(24)}/replies`, { text: 'ok' })).status).toBe(404)
    expect((await request(`${route}/replies`, { text: 'x'.repeat(4096) }, 'agent')).status).toBe(200)
    for (let i = 2; i < 200; i++) threads.reply(id, threadId, 'Message')
    expect((await request(`${route}/replies`, { text: 'Full' }, 'agent')).status).toBe(409)
    expect((await request(`${route}/replies`, { text: 'Full', author: 'user' })).status).toBe(409)
    expect(pending.list(id)).toEqual([])
    service.close(id)
    expect((await request(`${route}/status`, { status: 'open' })).status).toBe(404)
  })
  it('long-polls POST and GET spotlight decisions without sockets', async () => {
    const waiting = request('spotlight?wait=1', { label: 'Row' }, 'agent')
    await vi.waitFor(() => expect(spotlight.pending()[id]).toBeDefined())
    const requestId = spotlight.pending()[id].id
    let done = false
    const polling = request(`spotlight-requests/${requestId}?wait=1`, undefined, 'agent').then((result) => { done = true; return result })
    await new Promise((resolve) => setImmediate(resolve))
    expect(done).toBe(false)
    await request(`spotlight-requests/${requestId}`, { decision: 'accept' })
    expect((await waiting).body.decision).toBe('accepted')
    expect((await polling).body.decision).toBe('accepted')
    const next = await request('spotlight', { frame: 'settings' }, 'agent')
    expect((await request(`spotlight-requests/${next.body.requestId}?wait=0.001`, undefined, 'agent')).status).toBe(202)
    expect((await request(`spotlight-requests/${next.body.requestId}?wait=-1`, undefined, 'agent')).status).toBe(400)
  })
  it('spotlight request auth, validation, polling, owner decisions and tab activation', async () => {
    expect((await request('spotlight', { label: 'Row' })).status).toBe(403)
    expect((await request('spotlight', { label: 'Row' }, 'none')).status).toBe(401)
    for (const body of [{}, { label: false }, { label: 'x'.repeat(257) }, { frame: '../bad' }, { message: 'x'.repeat(1025), label: 'Row' }]) {
      expect((await request('spotlight', body, 'agent')).status).toBe(400)
    }
    expect((await request('spotlight?wait=61', { label: 'Row' }, 'agent')).status).toBe(400)
    const result = await request('spotlight', { label: 'Row', frame: 'settings', message: 'Changed' }, 'agent')
    expect(result.status).toBe(202)
    expect(result.body).toMatchObject({ decision: 'pending', request: { label: 'Row', frame: 'settings', message: 'Changed' } })
    const requestId = result.body.requestId
    expect((await request(`spotlight-requests/${requestId}`, undefined, 'agent')).body.decision).toBe('pending')
    expect((await request(`spotlight-requests/${requestId}`, { decision: 'accept' }, 'agent')).status).toBe(403)
    expect((await request(`spotlight-requests/${requestId}`, { decision: 'bad' })).status).toBe(400)
    const active = vi.spyOn(service, 'setActiveTab')
    expect((await request(`spotlight-requests/${requestId}`, { decision: 'accept' })).body.decision).toBe('accepted')
    expect(active).toHaveBeenCalledWith(id)
    expect((await request(`spotlight-requests/${requestId}`, undefined, 'agent')).body.decision).toBe('accepted')
    expect((await request(`spotlight-requests/${requestId}`, { decision: 'dismiss' })).status).toBe(409)
    const next = await request('spotlight', { frame: 'settings' }, 'agent')
    const last = await request('spotlight', { labelId: 'row' }, 'agent')
    expect((await request(`spotlight-requests/${next.body.requestId}`, undefined, 'agent')).body.decision).toBe('superseded')
    expect((await request(`spotlight-requests/${last.body.requestId}`, { decision: 'dismiss' })).body.decision).toBe('dismissed')
    const closed = await request('spotlight', { frame: 'settings' }, 'agent')
    service.close(id); spotlight.retain(new Set())
    expect((await request(`spotlight-requests/${closed.body.requestId}`, undefined, 'agent')).body.decision).toBe('closed')
    expect((await request(`spotlight-requests/sr-00000000`, undefined, 'agent')).status).toBe(404)
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
    expect((await request('feedback', undefined, 'agent')).body.notes[0].canvas).toMatchObject({ ...canvas, threadId: threads.list(id)[0].id })
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
