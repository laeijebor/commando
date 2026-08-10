import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { MAX_PENDING_NOTES } from '../shared/protocol.js'
import { MAX_RESPONSE_NOTE } from '../shared/redline-response.js'
import { WebPanesApi } from './web-panes-api.js'
import { WebPaneAttachmentStore } from './web-pane-attachments.js'
import { FeedbackJournal } from './web-pane-feedback-journal.js'
import { WebPaneFeedbackStore } from './web-pane-feedback.js'
import { PendingNotesJournal, WebPanePendingStore } from './web-pane-pending.js'
import { WebPaneService } from './web-panes.js'

const AGENT_TOKEN = 'agent-hook-token-with-at-least-32-characters'
const servers: Server[] = []
const services: WebPaneService[] = []
const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
  // Persistence is queued asynchronously; settle it before deleting the
  // directories or an in-flight temp file races the rm.
  await Promise.all(services.splice(0).map((service) => service.flush()))
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

async function createService(): Promise<WebPaneService> {
  const directory = await mkdtemp(join(tmpdir(), 'commando-web-panes-api-'))
  temporaryDirectories.push(directory)
  const service = new WebPaneService(join(directory, 'web-panes.json'))
  services.push(service)
  return service
}

type Overrides = Partial<ConstructorParameters<typeof WebPanesApi>[0]>

async function startApi(service: WebPaneService, overrides: Overrides = {}): Promise<{
  baseUrl: string
  onChange: ReturnType<typeof vi.fn>
  onPendingChanged: ReturnType<typeof vi.fn>
  feedback: WebPaneFeedbackStore
  pending: WebPanePendingStore
  attachmentStore: WebPaneAttachmentStore
}> {
  const onChange = vi.fn()
  const onPendingChanged = vi.fn()
  const journalDir = mkdtempSync(join(tmpdir(), 'commando-feedback-api-journal-'))
  temporaryDirectories.push(journalDir)
  const attachmentStore = overrides.attachmentStore ?? new WebPaneAttachmentStore({ dir: join(journalDir, 'attachments') })
  const feedback = overrides.feedback ?? new WebPaneFeedbackStore(
    new FeedbackJournal({ dir: journalDir }),
    () => onChange(),
    Date.now,
    (attachmentId) => attachmentStore.remove(attachmentId),
  )
  const pending = overrides.pending ?? new WebPanePendingStore(
    new PendingNotesJournal({ dir: journalDir }),
    (attachmentId) => attachmentStore.remove(attachmentId),
  )
  const api = new WebPanesApi({
    service,
    agentToken: AGENT_TOKEN,
    ownerAuthorized: async (request) => request.headers['x-test-owner'] === 'yes',
    paneForId: (paneId) =>
      paneId === '%12'
        ? { id: '%12', sessionId: '$1', windowId: '@3', width: 190, height: 55 }
        : undefined,
    agentLabel: (paneId) => (paneId === '%12' ? 'claude · gizmo' : undefined),
    onChange,
    onPendingChanged,
    ...overrides,
    feedback,
    pending,
    attachmentStore,
  })
  const server = createServer((request, response) => {
    void api.handle(request, response, new URL(request.url ?? '/', 'http://127.0.0.1'))
  })
  servers.push(server)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return {
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    onChange,
    onPendingChanged,
    feedback,
    pending,
    attachmentStore,
  }
}

function post(baseUrl: string, path: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
}

const agentAuth = { Authorization: `Bearer ${AGENT_TOKEN}` }
const ownerAuth = { 'x-test-owner': 'yes' }
const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01])

function uploadAttachment(baseUrl: string, paneId: string, noteId: number, revision: number, headers: Record<string, string> = {}) {
  return fetch(`${baseUrl}/api/web-panes/${paneId}/pending/${noteId}/attachments`, {
    method: 'POST',
    headers: {
      ...ownerAuth,
      'Content-Type': 'image/png',
      'X-Pending-Revision': String(revision),
      ...headers,
    },
    body: pngBytes,
  })
}

describe('web panes API', () => {
  it('rejects unauthenticated requests', async () => {
    const { baseUrl } = await startApi(await createService())
    const response = await post(baseUrl, '/api/web-panes', { url: 'http://localhost:5173/', anchor: '%12' })
    expect(response.status).toBe(401)
  })

  it('rejects a wrong bearer token', async () => {
    const { baseUrl } = await startApi(await createService())
    const response = await post(
      baseUrl,
      '/api/web-panes',
      { url: 'http://localhost:5173/', anchor: '%12' },
      { Authorization: 'Bearer wrong-token-that-is-long-enough-to-check' },
    )
    expect(response.status).toBe(401)
  })

  it('lets an agent open a localhost tile beside its own pane', async () => {
    const service = await createService()
    const { baseUrl, onChange } = await startApi(service)
    const response = await post(
      baseUrl,
      '/api/web-panes',
      { url: 'http://127.0.0.1:41300/plan', anchor: '%12', placement: 'right' },
      agentAuth,
    )

    expect(response.status).toBe(201)
    const body = await response.json() as { webPaneId: string; beside: string; status: string }
    expect(body).toMatchObject({ ok: true, beside: '%12', status: 'open' })
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(service.get(body.webPaneId)).toMatchObject({
      openedBy: 'agent',
      openerLabel: 'claude · gizmo',
      placement: 'right',
    })
  })

  it('resolves an omitted placement from the anchor pane geometry', async () => {
    const service = await createService()
    // Tall anchor (95 < 2×55): auto must resolve to a below split — and to a
    // concrete value, so clients never re-derive it from live geometry.
    const { baseUrl } = await startApi(service, {
      paneForId: (paneId) =>
        paneId === '%12'
          ? { id: '%12', sessionId: '$1', windowId: '@3', width: 95, height: 55 }
          : undefined,
    })
    const response = await post(
      baseUrl,
      '/api/web-panes',
      { url: 'http://127.0.0.1:41300/plan', anchor: '%12' },
      agentAuth,
    )

    expect(response.status).toBe(201)
    const body = await response.json() as { webPaneId: string }
    expect(service.get(body.webPaneId)?.placement).toBe('below')
  })

  it('marks agent-opened external urls pending and lets only the owner confirm', async () => {
    const service = await createService()
    const { baseUrl } = await startApi(service)
    const opened = await post(
      baseUrl,
      '/api/web-panes',
      { url: 'https://reactnative.dev/docs/flatlist', anchor: '%12' },
      agentAuth,
    )
    expect(opened.status).toBe(201)
    const { webPaneId, status } = await opened.json() as { webPaneId: string; status: string }
    expect(status).toBe('pending')

    const agentConfirm = await post(baseUrl, `/api/web-panes/${webPaneId}/confirm`, { allowOrigin: true }, agentAuth)
    expect(agentConfirm.status).toBe(403)
    expect(service.get(webPaneId)?.status).toBe('pending')

    const ownerConfirm = await post(baseUrl, `/api/web-panes/${webPaneId}/confirm`, { allowOrigin: true }, ownerAuth)
    expect(ownerConfirm.status).toBe(200)
    expect(service.get(webPaneId)?.status).toBe('open')
  })

  it('404s for an unknown anchor pane and validates the body', async () => {
    const { baseUrl } = await startApi(await createService())
    const missingAnchor = await post(
      baseUrl,
      '/api/web-panes',
      { url: 'http://localhost:5173/', anchor: '%99' },
      agentAuth,
    )
    expect(missingAnchor.status).toBe(404)

    const badAnchor = await post(
      baseUrl,
      '/api/web-panes',
      { url: 'http://localhost:5173/', anchor: 'nope' },
      agentAuth,
    )
    expect(badAnchor.status).toBe(400)

    const badUrl = await post(baseUrl, '/api/web-panes', { url: 'ftp://x/', anchor: '%12' }, agentAuth)
    expect(badUrl.status).toBe(400)

    const badPlacement = await post(
      baseUrl,
      '/api/web-panes',
      { url: 'http://localhost:5173/', anchor: '%12', placement: 'left' },
      agentAuth,
    )
    expect(badPlacement.status).toBe(400)
  })

  it('lists and deletes tiles', async () => {
    const service = await createService()
    const { baseUrl, onChange } = await startApi(service)
    const opened = await post(baseUrl, '/api/web-panes', { url: 'http://localhost:5173/', anchor: '%12' }, agentAuth)
    const { webPaneId } = await opened.json() as { webPaneId: string }

    const listed = await fetch(`${baseUrl}/api/web-panes`, { headers: ownerAuth })
    expect(listed.status).toBe(200)
    await expect(listed.json()).resolves.toMatchObject({ webPanes: [{ id: webPaneId }] })

    const deleted = await fetch(`${baseUrl}/api/web-panes/${webPaneId}`, { method: 'DELETE', headers: agentAuth })
    expect(deleted.status).toBe(200)
    expect(service.list()).toHaveLength(0)
    expect(onChange).toHaveBeenCalledTimes(2)

    const again = await fetch(`${baseUrl}/api/web-panes/${webPaneId}`, { method: 'DELETE', headers: agentAuth })
    expect(again.status).toBe(404)
  })

  it('accepts an engine on open and validates it', async () => {
    const service = await createService()
    const { baseUrl } = await startApi(service)
    const opened = await post(
      baseUrl,
      '/api/web-panes',
      { url: 'http://localhost:5173/', anchor: '%12', engine: 'chromium' },
      agentAuth,
    )
    expect(opened.status).toBe(201)
    const body = await opened.json() as { webPaneId: string; engine: string }
    expect(body.engine).toBe('chromium')
    expect(service.get(body.webPaneId)?.engine).toBe('chromium')

    const bad = await post(
      baseUrl,
      '/api/web-panes',
      { url: 'http://localhost:5173/', anchor: '%12', engine: 'gecko' },
      agentAuth,
    )
    expect(bad.status).toBe(400)
  })

  it('serves cdp coordinates for open chromium tiles only', async () => {
    const service = await createService()
    const cdpInfo = vi.fn().mockResolvedValue({
      target: 'ws://127.0.0.1:9223/devtools/page/ABC',
      devtoolsFrontendUrl: 'http://127.0.0.1:9223/devtools/inspector.html?ws=…',
    })
    const { baseUrl } = await startApi(service, { cdpInfo })

    const missing = await fetch(`${baseUrl}/api/web-panes/w-00000000/cdp`, { headers: agentAuth })
    expect(missing.status).toBe(404)

    const webkitPane = service.open({
      url: 'http://localhost:5173/', anchorPaneId: '%12', sessionId: '$1', windowId: '@3',
      openedBy: 'agent',
    })
    const wrongEngine = await fetch(`${baseUrl}/api/web-panes/${webkitPane.id}/cdp`, { headers: agentAuth })
    expect(wrongEngine.status).toBe(409)

    const pendingPane = service.open({
      url: 'https://reactnative.dev/docs', anchorPaneId: '%12', sessionId: '$1', windowId: '@3',
      engine: 'chromium', openedBy: 'agent',
    })
    const pendingResponse = await fetch(`${baseUrl}/api/web-panes/${pendingPane.id}/cdp`, { headers: agentAuth })
    expect(pendingResponse.status).toBe(409)

    const chromiumPane = service.open({
      url: 'http://localhost:5173/', anchorPaneId: '%12', sessionId: '$1', windowId: '@3',
      engine: 'chromium', openedBy: 'agent',
    })
    const unauthenticated = await fetch(`${baseUrl}/api/web-panes/${chromiumPane.id}/cdp`)
    expect(unauthenticated.status).toBe(401)

    const ok = await fetch(`${baseUrl}/api/web-panes/${chromiumPane.id}/cdp`, { headers: agentAuth })
    expect(ok.status).toBe(200)
    await expect(ok.json()).resolves.toMatchObject({
      webPaneId: chromiumPane.id,
      target: 'ws://127.0.0.1:9223/devtools/page/ABC',
    })
    expect(cdpInfo).toHaveBeenCalledWith(chromiumPane.id)
  })

  it('503s cdp lookups when no chromium engine is configured', async () => {
    const service = await createService()
    const { baseUrl } = await startApi(service)
    const pane = service.open({
      url: 'http://localhost:5173/', anchorPaneId: '%12', sessionId: '$1', windowId: '@3',
      engine: 'chromium', openedBy: 'agent',
    })
    const response = await fetch(`${baseUrl}/api/web-panes/${pane.id}/cdp`, { headers: agentAuth })
    expect(response.status).toBe(503)
  })

  it('rate limits rapid open requests', async () => {
    const { TokenBucketRateLimiter } = await import('./client-messages.js')
    const { baseUrl } = await startApi(await createService(), {
      openLimiter: new TokenBucketRateLimiter(2, 0.0001),
    })
    const open = () => post(baseUrl, '/api/web-panes', { url: 'http://localhost:5173/', anchor: '%12' }, agentAuth)
    expect((await open()).status).toBe(201)
    expect((await open()).status).toBe(201)
    expect((await open()).status).toBe(429)
  })

  it('moves a tile to a new anchor with the previewed placement', async () => {
    const service = await createService()
    const { baseUrl, onChange } = await startApi(service, {
      paneForId: (paneId) =>
        paneId === '%12'
          ? { id: '%12', sessionId: '$1', windowId: '@3', width: 190, height: 55 }
          : paneId === '%40'
            ? { id: '%40', sessionId: '$1', windowId: '@3', width: 95, height: 55 }
            : undefined,
    })
    const opened = service.open({
      url: 'http://localhost:5173/',
      anchorPaneId: '%12',
      sessionId: '$1',
      windowId: '@3',
      openedBy: 'user',
    })

    const response = await post(
      baseUrl,
      `/api/web-panes/${opened.id}/move`,
      { anchor: '%40', placement: 'below' },
      ownerAuth,
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      ok: true,
      webPaneId: opened.id,
      beside: '%40',
      placement: 'below',
    })
    expect(service.get(opened.id)).toMatchObject({ anchorPaneId: '%40', placement: 'below' })
    expect(onChange).toHaveBeenCalledTimes(1)
  })

  it('rejects a move whose target anchor lives in another window', async () => {
    const service = await createService()
    const { baseUrl } = await startApi(service, {
      paneForId: (paneId) =>
        paneId === '%12'
          ? { id: '%12', sessionId: '$1', windowId: '@3', width: 190, height: 55 }
          : paneId === '%50'
            ? { id: '%50', sessionId: '$1', windowId: '@9', width: 190, height: 55 }
            : undefined,
    })
    const opened = service.open({
      url: 'http://localhost:5173/',
      anchorPaneId: '%12',
      sessionId: '$1',
      windowId: '@3',
      openedBy: 'user',
    })

    const response = await post(
      baseUrl,
      `/api/web-panes/${opened.id}/move`,
      { anchor: '%50', placement: 'right' },
      ownerAuth,
    )
    expect(response.status).toBe(400)
    expect(service.get(opened.id)?.anchorPaneId).toBe('%12')
  })

  it('rejects a move to an unknown anchor pane or with a bad placement', async () => {
    const service = await createService()
    const { baseUrl } = await startApi(service)
    const opened = service.open({
      url: 'http://localhost:5173/',
      anchorPaneId: '%12',
      sessionId: '$1',
      windowId: '@3',
      openedBy: 'user',
    })

    const unknownAnchor = await post(
      baseUrl,
      `/api/web-panes/${opened.id}/move`,
      { anchor: '%99', placement: 'right' },
      ownerAuth,
    )
    expect(unknownAnchor.status).toBe(404)

    const autoPlacement = await post(
      baseUrl,
      `/api/web-panes/${opened.id}/move`,
      { anchor: '%12', placement: 'auto' },
      ownerAuth,
    )
    expect(autoPlacement.status).toBe(400)

    const unauthenticated = await post(
      baseUrl,
      `/api/web-panes/${opened.id}/move`,
      { anchor: '%12', placement: 'right' },
    )
    expect(unauthenticated.status).toBe(401)
  })

  it('navigates a tile to a new url and syncs the engine when it stays open', async () => {
    const service = await createService()
    const onConfirmed = vi.fn()
    const { baseUrl, onChange } = await startApi(service, { onConfirmed })
    const opened = service.open({
      url: 'http://localhost:5173/',
      anchorPaneId: '%12',
      sessionId: '$1',
      windowId: '@3',
      openedBy: 'user',
    })

    const response = await post(
      baseUrl,
      `/api/web-panes/${opened.id}/navigate`,
      { url: 'http://127.0.0.1:4310/report' },
      ownerAuth,
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      ok: true,
      webPaneId: opened.id,
      status: 'open',
      url: 'http://127.0.0.1:4310/report',
    })
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onConfirmed).toHaveBeenCalledTimes(1)
  })

  it('navigating to an unconfirmed external origin pends without engine sync', async () => {
    const service = await createService()
    const onConfirmed = vi.fn()
    const { baseUrl } = await startApi(service, { onConfirmed })
    const opened = service.open({
      url: 'http://localhost:5173/',
      anchorPaneId: '%12',
      sessionId: '$1',
      windowId: '@3',
      openedBy: 'user',
    })

    const response = await post(
      baseUrl,
      `/api/web-panes/${opened.id}/navigate`,
      { url: 'https://reactnative.dev/docs' },
      ownerAuth,
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ status: 'pending' })
    expect(onConfirmed).not.toHaveBeenCalled()
  })

  it('navigate requires auth and a string url', async () => {
    const service = await createService()
    const { baseUrl } = await startApi(service)
    const opened = service.open({
      url: 'http://localhost:5173/',
      anchorPaneId: '%12',
      sessionId: '$1',
      windowId: '@3',
      openedBy: 'user',
    })

    expect((await post(baseUrl, `/api/web-panes/${opened.id}/navigate`, { url: 'http://localhost:1/' })).status).toBe(401)
    expect((await post(baseUrl, `/api/web-panes/${opened.id}/navigate`, { url: 42 }, ownerAuth)).status).toBe(400)
  })

  it('attributes an agent-driven navigate to the agent, not the tile owner', async () => {
    const service = await createService()
    const { baseUrl } = await startApi(service)
    const opened = service.open({
      url: 'http://localhost:5173/',
      anchorPaneId: '%12',
      sessionId: '$1',
      windowId: '@3',
      openedBy: 'user',
    })

    const response = await post(
      baseUrl,
      `/api/web-panes/${opened.id}/navigate`,
      { url: 'https://reactnative.dev/docs' },
      agentAuth,
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ status: 'pending' })
    expect(service.get(opened.id)).toMatchObject({
      openedBy: 'agent',
      openerLabel: 'claude · gizmo',
    })
  })

  it('attributes an owner-driven navigate to the user', async () => {
    const service = await createService()
    const { baseUrl } = await startApi(service)
    const opened = service.open({
      url: 'http://localhost:5173/',
      anchorPaneId: '%12',
      sessionId: '$1',
      windowId: '@3',
      openedBy: 'agent',
      openerLabel: 'claude · gizmo',
    })

    const response = await post(
      baseUrl,
      `/api/web-panes/${opened.id}/navigate`,
      { url: 'https://reactnative.dev/docs' },
      ownerAuth,
    )
    expect(response.status).toBe(200)
    const stored = service.get(opened.id)
    expect(stored?.openedBy).toBe('user')
    expect(stored?.openerLabel).toBeUndefined()
  })
})

async function openChromiumPane(service: WebPaneService): Promise<string> {
  return service.open({
    url: 'http://127.0.0.1:5173/',
    anchorPaneId: '%12',
    sessionId: '$1',
    windowId: '@3',
    engine: 'chromium',
    openedBy: 'agent',
  }).id
}

function feedbackNote(comment = 'make this button larger') {
  return {
    selector: '#root > button',
    tag: 'button',
    rect: { x: 1, y: 2, width: 30, height: 10 },
    comment,
    pageUrl: 'http://127.0.0.1:5173/',
    capturedAt: 1_000,
  }
}

describe('feedback routes', () => {
  it('owner submits, agent drains, and onChange fires on the drain', async () => {
    const service = await createService()
    const { baseUrl, onChange } = await startApi(service)
    const id = await openChromiumPane(service)
    const posted = await post(baseUrl, `/api/web-panes/${id}/feedback`, { notes: [feedbackNote()] }, ownerAuth)
    expect(posted.status).toBe(200)
    onChange.mockClear()
    const drained = await fetch(`${baseUrl}/api/web-panes/${id}/feedback?wait=0`, { headers: agentAuth })
    expect(drained.status).toBe(200)
    const body = await drained.json() as { cursor: number; notes: { id?: number }[] }
    expect(body.notes).toHaveLength(1)
    expect(body.notes[0]?.id).toBe(1)
    expect(onChange).toHaveBeenCalled()
    // Without the cursor the same notes come back (lost-response recovery)...
    const retry = await fetch(`${baseUrl}/api/web-panes/${id}/feedback?wait=0`, { headers: agentAuth })
    expect(((await retry.json()) as { notes: unknown[] }).notes).toHaveLength(1)
    // ...and passing it back acknowledges them.
    const acked = await fetch(`${baseUrl}/api/web-panes/${id}/feedback?wait=0&cursor=${body.cursor}`, { headers: agentAuth })
    expect(((await acked.json()) as { notes: unknown[] }).notes).toHaveLength(0)
  })

  it('serves a closed tile\'s unacked answers, then 404s once they are acked', async () => {
    const service = await createService()
    const { baseUrl } = await startApi(service)
    const id = await openChromiumPane(service)
    await post(baseUrl, `/api/web-panes/${id}/feedback`, { notes: [feedbackNote('survives close')] }, ownerAuth)
    service.close(id)
    const drained = await fetch(`${baseUrl}/api/web-panes/${id}/feedback?wait=0`, { headers: agentAuth })
    expect(drained.status).toBe(200)
    const body = await drained.json() as { cursor: number; notes: { comment: string }[] }
    expect(body.notes.map((note) => note.comment)).toEqual(['survives close'])
    const after = await fetch(`${baseUrl}/api/web-panes/${id}/feedback?wait=0&cursor=${body.cursor}`, { headers: agentAuth })
    expect(after.status).toBe(404)
  })

  it('rejects a malformed cursor', async () => {
    const service = await createService()
    const { baseUrl } = await startApi(service)
    const id = await openChromiumPane(service)
    expect((await fetch(`${baseUrl}/api/web-panes/${id}/feedback?wait=0&cursor=-1`, { headers: agentAuth })).status).toBe(400)
    expect((await fetch(`${baseUrl}/api/web-panes/${id}/feedback?wait=0&cursor=abc`, { headers: agentAuth })).status).toBe(400)
  })

  it('long-poll wakes when the owner submits mid-wait', async () => {
    const service = await createService()
    const { baseUrl } = await startApi(service)
    const id = await openChromiumPane(service)
    const pending = fetch(`${baseUrl}/api/web-panes/${id}/feedback?wait=10`, { headers: agentAuth })
    await new Promise((resolve) => setTimeout(resolve, 100))
    await post(baseUrl, `/api/web-panes/${id}/feedback`, { notes: [feedbackNote()] }, ownerAuth)
    const body = await (await pending).json() as { notes: unknown[] }
    expect(body.notes).toHaveLength(1)
  })

  it('rejects agents submitting and owners draining', async () => {
    const service = await createService()
    const { baseUrl } = await startApi(service)
    const id = await openChromiumPane(service)
    const submit = await post(baseUrl, `/api/web-panes/${id}/feedback`, { notes: [feedbackNote()] }, agentAuth)
    expect(submit.status).toBe(403)
    const drain = await fetch(`${baseUrl}/api/web-panes/${id}/feedback?wait=0`, { headers: { 'x-test-owner': 'yes' } })
    expect(drain.status).toBe(403)
  })

  it('rejects malformed notes, unknown panes, and bad wait values', async () => {
    const service = await createService()
    const { baseUrl } = await startApi(service)
    const id = await openChromiumPane(service)
    expect((await post(baseUrl, `/api/web-panes/${id}/feedback`, { notes: [] }, ownerAuth)).status).toBe(400)
    expect((await post(baseUrl, `/api/web-panes/${id}/feedback`, { notes: [{ comment: 'no selector' }] }, ownerAuth)).status).toBe(400)
    expect((await post(baseUrl, `/api/web-panes/${id}/feedback`, { notes: [{ ...feedbackNote(), comment: 'x'.repeat(5000) }] }, ownerAuth)).status).toBe(400)
    expect((await post(baseUrl, '/api/web-panes/w-00000000/feedback', { notes: [feedbackNote()] }, ownerAuth)).status).toBe(404)
    expect((await fetch(`${baseUrl}/api/web-panes/${id}/feedback?wait=999`, { headers: agentAuth })).status).toBe(400)
  })

  it('returns 429 once the tile queue is full', async () => {
    const service = await createService()
    const { baseUrl } = await startApi(service)
    const id = await openChromiumPane(service)
    for (let i = 0; i < 5; i += 1) {
      const batch = Array.from({ length: 10 }, () => feedbackNote(`note ${i}`))
      expect((await post(baseUrl, `/api/web-panes/${id}/feedback`, { notes: batch }, ownerAuth)).status).toBe(200)
    }
    expect((await post(baseUrl, `/api/web-panes/${id}/feedback`, { notes: [feedbackNote()] }, ownerAuth)).status).toBe(429)
  })

  it('accepts a note carrying a structured response', async () => {
    const service = await createService()
    const { baseUrl } = await startApi(service)
    const id = await openChromiumPane(service)
    const response = { question: 'Which plan?', answer: 'Pro', note: 'For the launch', data: { choice: 'Pro' } }
    const posted = await post(baseUrl, `/api/web-panes/${id}/feedback`, { notes: [{ ...feedbackNote(), response }] }, ownerAuth)
    expect(posted.status).toBe(200)
    const drained = await fetch(`${baseUrl}/api/web-panes/${id}/feedback?wait=0`, { headers: agentAuth })
    expect(drained.status).toBe(200)
    const body = await drained.json() as { notes: Array<{ response?: unknown }> }
    expect(body.notes).toHaveLength(1)
    expect(body.notes[0]?.response).toEqual(response)
  })

  it('rejects a note whose response is malformed', async () => {
    const service = await createService()
    const { baseUrl } = await startApi(service)
    const id = await openChromiumPane(service)
    expect((await post(
      baseUrl, `/api/web-panes/${id}/feedback`,
      { notes: [{ ...feedbackNote(), response: { question: '', answer: 'Pro' } }] }, ownerAuth,
    )).status).toBe(400)
    expect((await post(
      baseUrl, `/api/web-panes/${id}/feedback`,
      { notes: [{ ...feedbackNote(), response: { question: 'q', answer: 'a', data: 'x'.repeat(5000) } }] }, ownerAuth,
    )).status).toBe(400)
    expect((await post(
      baseUrl, `/api/web-panes/${id}/feedback`,
      { notes: [{ ...feedbackNote(), response: { question: 'q', answer: 'a', note: 'x'.repeat(MAX_RESPONSE_NOTE + 1) } }] }, ownerAuth,
    )).status).toBe(400)
    expect((await post(
      baseUrl, `/api/web-panes/${id}/feedback`,
      { notes: [{ ...feedbackNote(), response: 'not an object' }] }, ownerAuth,
    )).status).toBe(400)
  })
})

function pendingNoteBody(comment = 'align this') {
  return {
    note: {
      selector: '#root > button',
      tag: 'button',
      rect: { x: 1, y: 2, width: 30, height: 10 },
      comment,
    },
  }
}

describe('pending note routes', () => {
  it('owner queues, lists, and removes pending notes; broadcasts fire', async () => {
    const service = await createService()
    const { baseUrl, onPendingChanged } = await startApi(service)
    const id = await openChromiumPane(service)

    const added = await post(baseUrl, `/api/web-panes/${id}/pending`, pendingNoteBody(), ownerAuth)
    expect(added.status).toBe(200)
    const addedBody = await added.json() as { notes: Array<{ id: number; comment: string }>; knownUpTo: number }
    expect(addedBody.notes).toMatchObject([{ id: 1, comment: 'align this' }])
    expect(addedBody.knownUpTo).toBe(1)
    expect(onPendingChanged).toHaveBeenCalledWith(id, expect.objectContaining({ notes: addedBody.notes }))

    const listed = await fetch(`${baseUrl}/api/web-panes/${id}/pending`, { headers: ownerAuth })
    expect(listed.status).toBe(200)
    expect(((await listed.json()) as { notes: unknown[] }).notes).toHaveLength(1)

    const removed = await fetch(`${baseUrl}/api/web-panes/${id}/pending/1`, {
      method: 'DELETE',
      headers: ownerAuth,
    })
    expect(removed.status).toBe(200)
    expect(((await removed.json()) as { notes: unknown[] }).notes).toHaveLength(0)
  })

  it('accepts a queued note carrying a response and queueKey (restore path)', async () => {
    const service = await createService()
    const { baseUrl } = await startApi(service)
    const id = await openChromiumPane(service)
    const body = pendingNoteBody()
    const note = {
      ...body.note,
      queueKey: 'q1',
      response: { question: 'Which plan?', answer: 'Pro', note: 'For the launch', data: { choice: 'Pro' } },
    }
    const added = await post(baseUrl, `/api/web-panes/${id}/pending`, { note }, ownerAuth)
    expect(added.status).toBe(200)
    const addedBody = await added.json() as { notes: Array<{ queueKey?: string; response?: unknown }> }
    expect(addedBody.notes[0]?.queueKey).toBe('q1')
    expect(addedBody.notes[0]?.response).toEqual({
      question: 'Which plan?',
      answer: 'Pro',
      note: 'For the launch',
      data: { choice: 'Pro' },
    })
  })

  it('updates pending answers and notes with optimistic revisions', async () => {
    const service = await createService()
    const { baseUrl, onPendingChanged } = await startApi(service)
    const id = await openChromiumPane(service)
    const input = pendingNoteBody()
    await post(baseUrl, `/api/web-panes/${id}/pending`, {
      note: {
        ...input.note,
        response: { question: 'Which plan?', answer: 'Pro' },
      },
    }, ownerAuth)

    const updated = await fetch(`${baseUrl}/api/web-panes/${id}/pending/1`, {
      method: 'PATCH',
      headers: { ...ownerAuth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ expectedRevision: 1, answer: 'Team', note: 'Need SSO' }),
    })
    expect(updated.status).toBe(200)
    const body = await updated.json() as { notes: Array<{ revision?: number; comment: string; response?: unknown }> }
    expect(body.notes[0]).toMatchObject({
      revision: 2,
      comment: 'Which plan?: Team\n\nNote: Need SSO',
      response: { question: 'Which plan?', answer: 'Team', note: 'Need SSO' },
    })
    expect(onPendingChanged).toHaveBeenLastCalledWith(id, expect.objectContaining({ notes: body.notes }))

    const stale = await fetch(`${baseUrl}/api/web-panes/${id}/pending/1`, {
      method: 'PATCH',
      headers: { ...ownerAuth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ expectedRevision: 1, answer: 'Enterprise' }),
    })
    expect(stale.status).toBe(409)
    expect((await fetch(`${baseUrl}/api/web-panes/${id}/pending/1`, {
      method: 'PATCH',
      headers: { ...agentAuth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ expectedRevision: 2, answer: 'Enterprise' }),
    })).status).toBe(403)
    expect((await fetch(`${baseUrl}/api/web-panes/${id}/pending/1`, {
      method: 'PATCH',
      headers: { ...ownerAuth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ expectedRevision: 0, answer: 'Enterprise' }),
    })).status).toBe(400)
  })

  it('uploads, privately previews, and detaches an image from a pending note', async () => {
    const service = await createService()
    const { baseUrl, attachmentStore, onPendingChanged } = await startApi(service)
    const id = await openChromiumPane(service)
    await post(baseUrl, `/api/web-panes/${id}/pending`, pendingNoteBody(), ownerAuth)

    const uploaded = await uploadAttachment(baseUrl, id, 1, 1, { 'X-File-Name': '../screen.png' })
    expect(uploaded.status).toBe(200)
    const body = await uploaded.json() as {
      notes: Array<{ revision?: number; attachments?: Array<{ id: string; name: string; contentType: string; size: number }> }>
    }
    const attachment = body.notes[0]?.attachments?.[0]
    expect(body.notes[0]?.revision).toBe(2)
    expect(attachment).toMatchObject({ name: 'screen.png', contentType: 'image/png', size: pngBytes.length })
    expect(onPendingChanged).toHaveBeenLastCalledWith(id, expect.objectContaining({ notes: body.notes }))

    const path = `/api/web-panes/${id}/attachments/${attachment?.id}`
    const preview = await fetch(`${baseUrl}${path}`, { headers: ownerAuth })
    expect(preview.status).toBe(200)
    expect(Buffer.from(await preview.arrayBuffer())).toEqual(pngBytes)
    expect(preview.headers.get('cache-control')).toBe('private, no-store')
    expect(preview.headers.get('content-security-policy')).toBe('sandbox')
    expect(preview.headers.get('x-content-type-options')).toBe('nosniff')
    expect((await fetch(`${baseUrl}${path}`, { headers: agentAuth })).status).toBe(404)

    const detached = await fetch(`${baseUrl}/api/web-panes/${id}/pending/1/attachments/${attachment?.id}`, {
      method: 'DELETE',
      headers: { ...ownerAuth, 'X-Pending-Revision': '2' },
    })
    expect(detached.status).toBe(200)
    expect(((await detached.json()) as { notes: Array<{ attachments?: unknown[] }> }).notes[0]?.attachments).toEqual([])
    expect(attachmentStore.listIds()).toEqual([])
    expect((await fetch(`${baseUrl}${path}`, { headers: ownerAuth })).status).toBe(404)
  })

  it('keeps sent attachments available to agents after close and removes them on ack', async () => {
    const service = await createService()
    const { baseUrl, attachmentStore } = await startApi(service)
    const id = await openChromiumPane(service)
    await post(baseUrl, `/api/web-panes/${id}/pending`, pendingNoteBody(), ownerAuth)
    const uploaded = await uploadAttachment(baseUrl, id, 1, 1)
    const attachmentId = ((await uploaded.json()) as {
      notes: Array<{ attachments?: Array<{ id: string }> }>
    }).notes[0]?.attachments?.[0]?.id
    await post(baseUrl, `/api/web-panes/${id}/pending/send`, { ids: [1] }, ownerAuth)
    const path = `/api/web-panes/${id}/attachments/${attachmentId}`
    expect((await fetch(`${baseUrl}${path}`, { headers: ownerAuth })).status).toBe(200)
    expect((await fetch(`${baseUrl}${path}`, { headers: agentAuth })).status).toBe(200)

    service.close(id)
    expect((await fetch(`${baseUrl}${path}`, { headers: agentAuth })).status).toBe(200)
    const drained = await fetch(`${baseUrl}/api/web-panes/${id}/feedback?wait=0`, { headers: agentAuth })
    const { cursor } = await drained.json() as { cursor: number }
    const acked = await fetch(`${baseUrl}/api/web-panes/${id}/feedback?wait=0&cursor=${cursor}`, { headers: agentAuth })
    expect(acked.status).toBe(404)
    expect(attachmentStore.listIds()).toEqual([])
    expect((await fetch(`${baseUrl}${path}`, { headers: agentAuth })).status).toBe(404)
  })

  it('rolls back saved bytes when attach fails and validates upload headers and content', async () => {
    const service = await createService()
    const { baseUrl, attachmentStore } = await startApi(service)
    const id = await openChromiumPane(service)
    await post(baseUrl, `/api/web-panes/${id}/pending`, pendingNoteBody(), ownerAuth)

    expect((await uploadAttachment(baseUrl, id, 1, 9)).status).toBe(409)
    expect(attachmentStore.listIds()).toEqual([])
    expect((await fetch(`${baseUrl}/api/web-panes/${id}/pending/1/attachments`, {
      method: 'POST',
      headers: { ...ownerAuth, 'Content-Type': 'image/png' },
      body: pngBytes,
    })).status).toBe(400)
    expect((await fetch(`${baseUrl}/api/web-panes/${id}/pending/1/attachments`, {
      method: 'POST',
      headers: { ...agentAuth, 'Content-Type': 'image/png', 'X-Pending-Revision': '1' },
      body: pngBytes,
    })).status).toBe(403)
    expect((await uploadAttachment(baseUrl, id, 1, 1, { 'Content-Type': 'text/plain' })).status).toBe(415)
    expect(attachmentStore.listIds()).toEqual([])
  })

  it('send moves pending notes into the feedback queue with the pane url stamped', async () => {
    const service = await createService()
    const { baseUrl, onChange, onPendingChanged } = await startApi(service)
    const id = await openChromiumPane(service)
    await post(baseUrl, `/api/web-panes/${id}/pending`, pendingNoteBody('first'), ownerAuth)
    await post(baseUrl, `/api/web-panes/${id}/pending`, pendingNoteBody('second'), ownerAuth)
    onChange.mockClear()
    onPendingChanged.mockClear()

    const sent = await post(baseUrl, `/api/web-panes/${id}/pending/send`, {}, ownerAuth)
    expect(sent.status).toBe(200)
    const sentBody = await sent.json() as { queued: number; notes: unknown[] }
    expect(sentBody.notes).toHaveLength(0)
    expect(sentBody.queued).toBe(2)
    expect(onChange).toHaveBeenCalled()
    expect(onPendingChanged).toHaveBeenCalledWith(id, expect.objectContaining({ notes: [] }))

    const drained = await fetch(`${baseUrl}/api/web-panes/${id}/feedback?wait=0`, { headers: agentAuth })
    const drainedBody = await drained.json() as { notes: Array<{ comment: string; pageUrl: string; capturedAt: number }> }
    expect(drainedBody.notes.map((note) => note.comment)).toEqual(['first', 'second'])
    expect(drainedBody.notes[0]?.pageUrl).toBe('http://127.0.0.1:5173/')
    expect(drainedBody.notes[0]?.capturedAt).toBeGreaterThan(0)
  })

  it('send with ids moves only those notes', async () => {
    const service = await createService()
    const { baseUrl } = await startApi(service)
    const id = await openChromiumPane(service)
    await post(baseUrl, `/api/web-panes/${id}/pending`, pendingNoteBody('keep'), ownerAuth)
    await post(baseUrl, `/api/web-panes/${id}/pending`, pendingNoteBody('go'), ownerAuth)
    const sent = await post(baseUrl, `/api/web-panes/${id}/pending/send`, { ids: [2] }, ownerAuth)
    const sentBody = await sent.json() as { notes: Array<{ comment: string }> }
    expect(sentBody.notes.map((note) => note.comment)).toEqual(['keep'])
  })

  it('a full feedback queue leaves pending untouched', async () => {
    const service = await createService()
    const { baseUrl } = await startApi(service)
    const id = await openChromiumPane(service)
    for (let index = 0; index < 5; index += 1) {
      const batch = Array.from({ length: 10 }, () => feedbackNote())
      await post(baseUrl, `/api/web-panes/${id}/feedback`, { notes: batch }, ownerAuth)
    }
    await post(baseUrl, `/api/web-panes/${id}/pending`, pendingNoteBody('stays'), ownerAuth)
    const sent = await post(baseUrl, `/api/web-panes/${id}/pending/send`, {}, ownerAuth)
    expect(sent.status).toBe(429)
    const listed = await fetch(`${baseUrl}/api/web-panes/${id}/pending`, { headers: ownerAuth })
    expect(((await listed.json()) as { notes: Array<{ comment: string }> }).notes.map((note) => note.comment)).toEqual(['stays'])
  })

  it('reopening the same URL inherits the closed tile\'s unsent pills', async () => {
    const service = await createService()
    const { baseUrl, pending } = await startApi(service)
    const first = await openChromiumPane(service)
    await post(baseUrl, `/api/web-panes/${first}/pending`, pendingNoteBody('survives the close'), ownerAuth)
    service.close(first)
    pending.retain(new Set(service.list().map((pane) => pane.id)))

    const reopened = await post(
      baseUrl,
      '/api/web-panes',
      { url: 'http://127.0.0.1:5173/', anchor: '%12', engine: 'chromium' },
      ownerAuth,
    )
    const { webPaneId } = await reopened.json() as { webPaneId: string }
    const listed = await fetch(`${baseUrl}/api/web-panes/${webPaneId}/pending`, { headers: ownerAuth })
    const body = await listed.json() as { notes: Array<{ comment: string }> }
    expect(body.notes.map((note) => note.comment)).toEqual(['survives the close'])
  })

  it('surfaces capped page answers, then clears the notice on dismiss', async () => {
    const service = await createService()
    const { baseUrl, pending } = await startApi(service)
    const id = await openChromiumPane(service)
    // Cap drops only happen on the binding path, which writes to the store
    // directly rather than through HTTP.
    for (let index = 0; index < MAX_PENDING_NOTES + 2; index += 1) {
      pending.addResponse(id, 'http://127.0.0.1:5173/', { question: 'q', answer: `a${index}` })
    }
    const listed = await fetch(`${baseUrl}/api/web-panes/${id}/pending`, { headers: ownerAuth })
    const body = await listed.json() as { notes: unknown[]; dropped: number }
    expect(body.notes).toHaveLength(MAX_PENDING_NOTES)
    expect(body.dropped).toBe(2)

    const dismissed = await post(baseUrl, `/api/web-panes/${id}/pending/dropped`, {}, ownerAuth)
    expect(dismissed.status).toBe(200)
    const after = await dismissed.json() as { notes: unknown[]; dropped: number }
    expect(after.dropped).toBe(0)
    expect(after.notes).toHaveLength(MAX_PENDING_NOTES)
  })

  it('rejects agents, unknown panes, malformed notes, and bad ids', async () => {
    const service = await createService()
    const { baseUrl } = await startApi(service)
    const id = await openChromiumPane(service)
    expect((await post(baseUrl, `/api/web-panes/${id}/pending`, pendingNoteBody(), agentAuth)).status).toBe(403)
    expect((await fetch(`${baseUrl}/api/web-panes/${id}/pending`, { headers: agentAuth })).status).toBe(403)
    expect((await post(baseUrl, '/api/web-panes/w-00000000/pending', pendingNoteBody(), ownerAuth)).status).toBe(404)
    expect((await post(baseUrl, `/api/web-panes/${id}/pending`, { note: { comment: 'no selector' } }, ownerAuth)).status).toBe(400)
    expect((await post(baseUrl, `/api/web-panes/${id}/pending/send`, { ids: ['x'] }, ownerAuth)).status).toBe(400)
    expect((await fetch(`${baseUrl}/api/web-panes/${id}/pending/nope`, { method: 'DELETE', headers: ownerAuth })).status).toBe(404)
  })
})
