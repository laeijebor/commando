import { PassThrough } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebPaneAgentRequests } from './web-pane-agent-requests.js'
import { WebPanesApi } from './web-panes-api.js'
import { WebPaneService } from './web-panes.js'

const U = 'AAAAAAAA-1111-1111-1111-111111111111'
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'commando-simulator-api-'))
  const service = new WebPaneService(join(directory, 'tiles.json'))
  cleanups.push(async () => { await service.flush(); await rm(directory, { recursive: true, force: true }) })
  const change = vi.fn()
  type Dependencies = ConstructorParameters<typeof WebPanesApi>[0]
  const api = new WebPanesApi({ service, agentToken: 'a'.repeat(32), ownerAuthorized: async (request) => request.headers.authorization === 'Bearer owner',
    paneForId: (id) => id === '%12' || id === '%13' ? { id, sessionId: '$1', windowId: '@3', width: 180, height: 50 } : undefined,
    onChange: change,
    // Simulator routes never need a browser feedback queue or attachments.
    feedback: {} as Dependencies['feedback'], pending: {} as Dependencies['pending'], attachmentStore: {} as Dependencies['attachmentStore'], agentRequests: new WebPaneAgentRequests(),
  })
  const request = async (body: unknown, method = 'POST', path = '/api/web-panes', authorized: boolean | 'agent' = true) => {
    const incoming = new PassThrough() as unknown as IncomingMessage
    incoming.method = method; incoming.headers = { 'content-type': 'application/json', ...(authorized ? { authorization: authorized === 'agent' ? `Bearer ${'a'.repeat(32)}` : 'Bearer owner' } : {}) }
    const response = new PassThrough() as unknown as ServerResponse
    const chunks: Buffer[] = []; response.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
    response.writeHead = vi.fn().mockReturnValue(response); response.setHeader = vi.fn().mockReturnValue(response)
    const requestStream = incoming as unknown as PassThrough
    requestStream.end(JSON.stringify(body))
    await api.handle(incoming, response, new URL(path, 'http://localhost'))
    return { status: vi.mocked(response.writeHead).mock.calls[0][0], body: JSON.parse(Buffer.concat(chunks).toString()) }
  }
  return { request, service, change }
}

describe('simulator tile API without a listener', () => {
  it('uses owner authorization, anchors and broadcasts built-in content; reopens the existing tile and closes it', async () => {
    const { request, service, change } = await setup()
    const body = { anchor: '%12', content: { kind: 'simulator', udid: U.toLowerCase() } }
    expect((await request(body, 'POST', '/api/web-panes', false)).status).toBe(401)
    const opened = await request(body)
    expect(opened.status).toBe(201)
    expect(service.get(opened.body.webPaneId)).toMatchObject({ content: { kind: 'simulator', udid: U }, url: '', anchorPaneId: '%12', status: 'open' })
    const repeated = await request({ ...body, anchor: '%13' })
    expect(repeated.body.webPaneId).toBe(opened.body.webPaneId)
    expect(service.list()).toHaveLength(1); expect(change).toHaveBeenCalledTimes(2)
    expect((await request({}, 'DELETE', `/api/web-panes/${opened.body.webPaneId}`)).status).toBe(200)
    expect(service.list()).toEqual([])
  })
  it('rejects malformed simulator content and missing anchors', async () => {
    const { request } = await setup()
    for (const content of [{ kind: 'simulator', udid: 'bad' }, { kind: 'unknown', udid: U }, [], null, { kind: 'simulator', udid: 2 }]) expect((await request({ anchor: '%12', content })).status).toBe(400)
    expect((await request({ anchor: '%99', content: { kind: 'simulator', udid: U } })).status).toBe(404)
  })
})


describe('panel tab actions without a listener', () => {
  it('authenticates owner-only selection and seen actions and broadcasts the new state', async () => {
    const { request, service, change } = await setup()
    const anchor = { anchorPaneId: '%12', sessionId: '$1', windowId: '@3', openedBy: 'agent' as const }
    const first = service.open({ ...anchor, url: 'http://localhost/first' })
    const second = service.open({ ...anchor, url: 'http://localhost/second' })
    for (const action of ['active-tab', 'seen']) {
      const path = `/api/web-panes/${second.id}/${action}`
      expect((await request({}, 'POST', path, false)).status).toBe(401)
      expect((await request({}, 'POST', path, 'agent')).status).toBe(403)
      expect((await request({}, 'GET', path)).status).toBe(405)
      expect((await request({}, 'POST', `/api/web-panes/w-00000000/${action}`)).status).toBe(404)
    }
    expect(change).not.toHaveBeenCalled()
    expect((await request({}, 'POST', `/api/web-panes/${second.id}/seen`)).status).toBe(200)
    expect(service.get(second.id)?.unseen).toBe(false)
    expect(service.list().find((pane) => pane.activeTab)?.id).toBe(first.id)
    expect((await request({}, 'POST', `/api/web-panes/${second.id}/active-tab`)).status).toBe(200)
    expect(service.list().find((pane) => pane.activeTab)?.id).toBe(second.id)
    expect(change).toHaveBeenCalledTimes(2)
    const split = service.open({ ...anchor, url: 'http://localhost/split', dock: 'split' })
    expect((await request({}, 'POST', `/api/web-panes/${split.id}/active-tab`)).status).toBe(409)
  })
})

describe('showLeasedSimulator', () => {
  it('opens an unseen agent tab in the leasing pane and takes the tile from a previous holder', async () => {
    const { service } = await setup()
    const first = service.showLeasedSimulator(U.toLowerCase(), { anchorPaneId: '%12', sessionId: '$1', windowId: '@3', openerLabel: 'claude' })
    expect(first).toMatchObject({ content: { kind: 'simulator', udid: U }, anchorPaneId: '%12', dock: 'panel', unseen: true, openedBy: 'agent', openerLabel: 'claude' })
    expect(service.showLeasedSimulator(U, { anchorPaneId: '%12', sessionId: '$1', windowId: '@3' }).id).toBe(first.id)
    const moved = service.showLeasedSimulator(U, { anchorPaneId: '%20', sessionId: '$2', windowId: '@5' })
    expect(moved.id).not.toBe(first.id)
    expect(service.list()).toEqual([expect.objectContaining({ id: moved.id, anchorPaneId: '%20', sessionId: '$2' })])
  })
})
