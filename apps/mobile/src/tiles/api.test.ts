import type { Host } from '../hosts/types'
import {
  addPendingNote,
  closeTile,
  confirmTile,
  dismissDroppedAnswers,
  fetchPendingNotes,
  openTile,
  removePendingNote,
  sendPendingNotes,
  sendPendingNotesAndBuild,
  toPendingSnapshot,
  updatePendingNote,
} from './api'

const HOST: Host = {
  id: 'h1',
  name: 'studio',
  baseUrl: 'http://studio.tail-1a2b.ts.net:4310',
  auth: { kind: 'token', token: 'secret-token' },
}

type Call = { url: string; method: string; body: unknown; headers: Record<string, string> }

let calls: Call[] = []

function respond(body: unknown, status = 200): void {
  globalThis.fetch = jest.fn(async (url: unknown, init: unknown) => {
    const request = (init ?? {}) as { method?: string; body?: string; headers?: Record<string, string> }
    calls.push({
      url: String(url),
      method: request.method ?? 'GET',
      body: request.body === undefined ? undefined : JSON.parse(request.body),
      headers: request.headers ?? {},
    })
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })
  }) as unknown as typeof fetch
}

const SNAPSHOT_BODY = {
  ok: true,
  webPaneId: 'w-0badcafe',
  revision: 7,
  notes: [],
  knownUpTo: 4,
  dropped: 0,
}

beforeEach(() => {
  calls = []
  respond(SNAPSHOT_BODY)
})

describe('opening and closing tiles', () => {
  it('opens a chromium tile beside the anchor pane', async () => {
    respond({ ok: true, webPaneId: 'w-0badcafe', status: 'open', engine: 'chromium' })
    await openTile(HOST, { url: 'http://127.0.0.1:4310/redline/x.html', anchor: '%14' })
    expect(calls[0]).toMatchObject({
      url: 'http://studio.tail-1a2b.ts.net:4310/api/web-panes',
      method: 'POST',
      body: { url: 'http://127.0.0.1:4310/redline/x.html', anchor: '%14', engine: 'chromium' },
    })
  })

  it('sends the owner token the host was configured with', async () => {
    respond({ ok: true, webPaneId: 'w-0badcafe', status: 'open', engine: 'chromium' })
    await openTile(HOST, { url: 'http://x/', anchor: '%14' })
    expect(calls[0]?.headers.Authorization).toBe('Bearer secret-token')
  })

  it('confirms a pending origin, with or without the allowlist', async () => {
    respond({ ok: true, webPaneId: 'w-0badcafe', status: 'open' })
    await confirmTile(HOST, 'w-0badcafe', true)
    expect(calls[0]).toMatchObject({
      url: 'http://studio.tail-1a2b.ts.net:4310/api/web-panes/w-0badcafe/confirm',
      method: 'POST',
      body: { allowOrigin: true },
    })
  })

  it('closes a tile with DELETE', async () => {
    respond({ ok: true, webPaneId: 'w-0badcafe' })
    await closeTile(HOST, 'w-0badcafe')
    expect(calls[0]).toMatchObject({
      url: 'http://studio.tail-1a2b.ts.net:4310/api/web-panes/w-0badcafe',
      method: 'DELETE',
    })
  })

  it('reports the daemon error text rather than a status code', async () => {
    respond({ error: 'Anchor tmux pane does not exist' }, 404)
    await expect(openTile(HOST, { url: 'http://x/', anchor: '%99' }))
      .rejects.toThrow('Anchor tmux pane does not exist')
  })
})

describe('the pending queue', () => {
  it('reads the queue', async () => {
    const snapshot = await fetchPendingNotes(HOST, 'w-0badcafe')
    expect(calls[0]).toMatchObject({
      url: 'http://studio.tail-1a2b.ts.net:4310/api/web-panes/w-0badcafe/pending',
      method: 'GET',
    })
    expect(snapshot).toMatchObject({ revision: 7, knownUpTo: 4, dropped: 0, notes: [] })
  })

  it('queues an annotation under a note envelope', async () => {
    await addPendingNote(HOST, 'w-0badcafe', {
      selector: '#candidate-inbox',
      tag: 'section',
      rect: { x: 1, y: 2, width: 3, height: 4 },
      comment: 'Make the needs-you row taller',
      pageUrl: 'http://127.0.0.1:4310/redline/x.html',
    })
    expect(calls[0]).toMatchObject({
      url: 'http://studio.tail-1a2b.ts.net:4310/api/web-panes/w-0badcafe/pending',
      method: 'POST',
      body: {
        note: {
          selector: '#candidate-inbox',
          tag: 'section',
          comment: 'Make the needs-you row taller',
          pageUrl: 'http://127.0.0.1:4310/redline/x.html',
        },
      },
    })
  })

  it('patches an item with the revision the draft was based on', async () => {
    await updatePendingNote(HOST, 'w-0badcafe', 3, 2, { answer: 'Both, toggle', note: 'with a default' })
    expect(calls[0]).toMatchObject({
      url: 'http://studio.tail-1a2b.ts.net:4310/api/web-panes/w-0badcafe/pending/3',
      method: 'PATCH',
      body: { expectedRevision: 2, answer: 'Both, toggle', note: 'with a default' },
    })
  })

  it('removes an item with DELETE', async () => {
    await removePendingNote(HOST, 'w-0badcafe', 3)
    expect(calls[0]).toMatchObject({
      url: 'http://studio.tail-1a2b.ts.net:4310/api/web-panes/w-0badcafe/pending/3',
      method: 'DELETE',
    })
  })

  it('sends everything with the queue revision the strip was rendered from', async () => {
    await sendPendingNotes(HOST, 'w-0badcafe', { expectedQueueRevision: 7 })
    expect(calls[0]).toMatchObject({
      url: 'http://studio.tail-1a2b.ts.net:4310/api/web-panes/w-0badcafe/pending/send',
      method: 'POST',
      body: { expectedQueueRevision: 7 },
    })
    expect(calls[0]?.body).not.toHaveProperty('items')
  })

  it('sends one item as an id and revision pair', async () => {
    await sendPendingNotes(HOST, 'w-0badcafe', {
      targets: [{ id: 3, revision: 2 }],
      expectedQueueRevision: 7,
    })
    expect(calls[0]?.body).toEqual({ items: [{ id: 3, revision: 2 }], expectedQueueRevision: 7 })
  })

  it('uses the send-build route for the build handoff', async () => {
    respond({ ...SNAPSHOT_BODY, intent: 'build' })
    await sendPendingNotesAndBuild(HOST, 'w-0badcafe', { expectedQueueRevision: 7 })
    expect(calls[0]).toMatchObject({
      url: 'http://studio.tail-1a2b.ts.net:4310/api/web-panes/w-0badcafe/pending/send-build',
      method: 'POST',
      body: { expectedQueueRevision: 7 },
    })
  })

  it('refuses a build the daemon did not acknowledge', async () => {
    respond(SNAPSHOT_BODY)
    await expect(sendPendingNotesAndBuild(HOST, 'w-0badcafe', { expectedQueueRevision: 7 }))
      .rejects.toThrow(/did not acknowledge the build handoff/)
  })

  it('acknowledges dropped answers', async () => {
    await dismissDroppedAnswers(HOST, 'w-0badcafe')
    expect(calls[0]).toMatchObject({
      url: 'http://studio.tail-1a2b.ts.net:4310/api/web-panes/w-0badcafe/pending/dropped',
      method: 'POST',
    })
  })
})

describe('snapshot normalisation', () => {
  it('treats a missing watermark as everything being unknown', () => {
    expect(toPendingSnapshot({ notes: [] }).knownUpTo).toBe(Number.POSITIVE_INFINITY)
  })

  it('survives a body that is not a snapshot at all', () => {
    expect(toPendingSnapshot(null)).toEqual({ notes: [], knownUpTo: Number.POSITIVE_INFINITY, dropped: 0 })
  })
})
