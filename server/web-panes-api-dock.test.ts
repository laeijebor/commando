import { IncomingMessage, type ServerResponse } from 'node:http'
import { Socket } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebPanesApi } from './web-panes-api.js'
import { WebPaneService } from './web-panes.js'
import { WebPaneAgentRequests } from './web-pane-agent-requests.js'
import { WebPaneAttachmentStore } from './web-pane-attachments.js'
import { FeedbackJournal } from './web-pane-feedback-journal.js'
import { WebPaneFeedbackStore } from './web-pane-feedback.js'
import { PendingNotesJournal, WebPanePendingStore } from './web-pane-pending.js'

const agentToken = 'agent-hook-token-with-at-least-32-characters'
const fixtures: { service: WebPaneService; directory: string }[] = []
afterEach(async () => {
  for (const { service, directory } of fixtures.splice(0)) {
    await service.flush()
    await rm(directory, { recursive: true, force: true })
  }
})

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'commando-dock-api-'))
  const service = new WebPaneService(join(directory, 'panes.json'))
  fixtures.push({ service, directory })
  const agentRequests = new WebPaneAgentRequests()
  const onChange = vi.fn()
  const onReload = vi.fn()
  const onReopen = vi.fn()
  const api = new WebPanesApi({
    service, agentToken, agentRequests, onChange, onReload, onReopen,
    ownerAuthorized: async (request) => request.headers['x-test-owner'] === 'yes',
    paneForId: (id) => ['%12', '%13'].includes(id) ? { id, sessionId: '$1', windowId: '@3', width: 80, height: 50 } : undefined,
    feedback: new WebPaneFeedbackStore(new FeedbackJournal({ dir: directory })),
    pending: new WebPanePendingStore(new PendingNotesJournal({ dir: directory })),
    attachmentStore: new WebPaneAttachmentStore({ dir: join(directory, 'attachments') }),
  })
  const post = async (path: string, body: unknown, owner = false) => {
    const request = new IncomingMessage(new Socket())
    request.method = 'POST'
    request.headers = { 'content-type': 'application/json', ...(owner ? { 'x-test-owner': 'yes' } : { authorization: `Bearer ${agentToken}` }) }
    request.push(Buffer.from(JSON.stringify(body)))
    request.push(null)
    const response = { writeHead: vi.fn(), end: vi.fn(), setHeader: vi.fn() }
    await api.handle(request, response as unknown as ServerResponse, new URL(path, 'http://localhost'))
    return { status: response.writeHead.mock.calls[0][0], body: JSON.parse(response.end.mock.calls[0][0]) }
  }
  return { service, agentRequests, onChange, onReload, onReopen, post }
}

describe('dock and URL reuse API', () => {
  it('rejects agents and lets the owner split and return using the current anchor geometry', async () => {
    const { service, onChange, post } = await setup()
    const opened = await post('/api/web-panes', { url: 'http://localhost/', anchor: '%12', dock: 'split' })
    const id = opened.body.webPaneId
    expect(service.get(id)?.dock).toBe('panel')
    expect((await post(`/api/web-panes/${id}/dock`, { dock: 'split' })).status).toBe(403)
    expect((await post(`/api/web-panes/${id}/dock`, { dock: 'sideways' }, true)).status).toBe(400)
    expect((await post(`/api/web-panes/${id}/dock`, { dock: 'split', anchorSize: { cols: 0, rows: 50 } }, true)).status).toBe(400)
    expect((await post(`/api/web-panes/${id}/dock`, { dock: 'split' }, true)).status).toBe(200)
    expect(service.get(id)).toMatchObject({ dock: 'split', placement: 'below', layoutState: 'pending', anchorSize: { cols: 80, rows: 50 } })
    const split = service.get(id)
    await post(`/api/web-panes/${id}/dock`, { dock: 'split' }, true)
    expect(service.get(id)).toBe(split)
    await post(`/api/web-panes/${id}/dock`, { dock: 'panel' }, true)
    expect(service.get(id)).toMatchObject({ dock: 'panel', unseen: false, layoutState: 'settled' })
    expect(service.panelActiveTabs()['%12']).toBe(id)
    expect(onChange).toHaveBeenCalledTimes(4)
  })

  it('rejects canvas split requests', async () => {
    const { post } = await setup()
    const opened = await post('/api/web-panes', { url: 'http://localhost/canvas', anchor: '%12', content: { kind: 'canvas', artifactId: '0123456789abcdef', manifest: 'canvas.json' } })
    expect((await post(`/api/web-panes/${opened.body.webPaneId}/dock`, { dock: 'split' }, true)).status).toBe(400)
  })

  it.each(['panel', 'split'] as const)('reuses a normalized URL in the %s and calls the reopen hook with the tile', async (dock) => {
    const { service, agentRequests, onChange, onReload, onReopen, post } = await setup()
    const first = await post('/api/web-panes', { url: 'http://LOCALHOST:80', anchor: '%12', engine: 'chromium' })
    expect(first).toMatchObject({ status: 201, body: { reused: false } })
    const id = first.body.webPaneId
    if (dock === 'split') await post(`/api/web-panes/${id}/dock`, { dock }, true)
    const second = await post('/api/web-panes', { url: 'http://localhost/', anchor: '%12', engine: 'chromium' })
    expect(second).toMatchObject({ status: 200, body: { webPaneId: id, reused: true, beside: '%12', status: 'open', engine: 'chromium' } })
    expect(service.list()).toHaveLength(1)
    expect(service.get(id)).toMatchObject({ dock, unseen: dock === 'panel', openRevision: 1 })
    expect(agentRequests.reloads()[id]).toBe(1)
    expect(onReopen).toHaveBeenCalledExactlyOnceWith(service.get(id))
    expect(onReload).not.toHaveBeenCalled()
    await post(`/api/web-panes/${id}/reload`, {})
    expect(agentRequests.reloads()[id]).toBe(2)
    expect(onReload).toHaveBeenCalledExactlyOnceWith(service.get(id))
    expect(onReopen).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledTimes(dock === 'split' ? 4 : 3)
  })

  it('creates a new tile for another engine or anchor', async () => {
    const { service, post } = await setup()
    const body = { url: 'http://localhost/', anchor: '%12', engine: 'webkit' }
    const first = await post('/api/web-panes', body)
    for (const change of [{ engine: 'chromium' }, { anchor: '%13' }]) {
      const next = await post('/api/web-panes', { ...body, ...change })
      expect(next).toMatchObject({ status: 201, body: { reused: false } })
      expect(next.body.webPaneId).not.toBe(first.body.webPaneId)
    }
    expect(service.list()).toHaveLength(3)
  })

  it('returns pending URL tiles as-is without any reload', async () => {
    const { service, agentRequests, onReload, onReopen, post } = await setup()
    const body = { url: 'https://unconfirmed.example', anchor: '%12' }
    const first = await post('/api/web-panes', body)
    const pane = service.get(first.body.webPaneId)
    const second = await post('/api/web-panes', body)
    expect(second).toMatchObject({ status: 200, body: { reused: true, webPaneId: pane?.id, status: 'pending' } })
    expect(service.get(pane!.id)).toBe(pane)
    expect(agentRequests.reloads()).toEqual({})
    expect(onReload).not.toHaveBeenCalled()
    expect(onReopen).not.toHaveBeenCalled()
  })
})

describe('PR panel selection API', () => {
  it.each(['pr:12', 'pr%3A12'])('accepts %s for an existing pane without a web tile or layout action', async (key) => {
    const { service, post, onChange, onReload, onReopen } = await setup()
    expect((await post(`/api/web-panes/${key}/active-tab`, { anchorPaneId: '%12' }, true)).status).toBe(200)
    expect(service.panelActiveTabs()).toEqual({ '%12': 'pr:12' })
    expect(service.list()).toEqual([])
    expect(onChange).toHaveBeenCalledOnce()
    expect(onReload).not.toHaveBeenCalled()
    expect(onReopen).not.toHaveBeenCalled()
    expect((await post(`/api/web-panes/${key}/active-tab`, { anchorPaneId: '%999' }, true)).status).toBe(404)
  })
  it.each(['pr', 'pr%3A0', 'pr%3A-1', 'pr%3A01', 'pr%3A1x', 'pr%ZZ', 'pr%3A12/dock'])('rejects malformed or non-selection path %s', async (key) => {
    const { post, service } = await setup()
    const path = key.endsWith('/dock') ? key : `${key}/active-tab`
    expect((await post(`/api/web-panes/${path}`, { anchorPaneId: '%12' }, true)).status).toBe(404)
    expect(service.panelActiveTabs()).toEqual({})
  })
})
