import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebPanesApi } from './web-panes-api.js'
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
}> {
  const onChange = vi.fn()
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
    ...overrides,
  })
  const server = createServer((request, response) => {
    void api.handle(request, response, new URL(request.url ?? '/', 'http://127.0.0.1'))
  })
  servers.push(server)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, onChange }
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
})
