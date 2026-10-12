import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RedlineApi } from './redline-api.js'
import { RedlineArtifactRegistry } from './redline-artifacts.js'
import { WebPaneService } from './web-panes.js'
import { WebPanesApi } from './web-panes-api.js'

const token = 'test-agent-hook-token-at-least-32-characters'
let dir: string
let service: WebPaneService
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'canvas-api-')); service = new WebPaneService(join(dir, 'panes.json')) })
afterEach(async () => { await service.flush(); await rm(dir, { recursive: true, force: true }) })
async function request(api: RedlineApi | WebPanesApi, path: string, options: { body?: unknown; auth?: 'agent' | 'owner' | 'none'; method?: string } = {}) {
  const req = Readable.from(options.body ? [JSON.stringify(options.body)] : []) as unknown as IncomingMessage
  req.method = options.method ?? (options.body ? 'POST' : 'GET')
  req.headers = { 'content-type': 'application/json', ...(options.auth === 'none' ? {} : options.auth === 'owner' ? { 'x-owner': 'yes' } : { authorization: `Bearer ${token}` }) }
  const writeHead = vi.fn(), end = vi.fn()
  const res = { writeHead, end, setHeader: vi.fn() } as unknown as ServerResponse
  await api.handle(req, res, new URL(path, 'http://localhost'))
  return { status: writeHead.mock.calls[0][0], body: JSON.parse(end.mock.calls[0][0]) }
}
describe('canvas validation endpoint', () => {
  const setup = () => {
    const artifacts = new RedlineArtifactRegistry(), { id } = artifacts.register(dir)
    const api = new RedlineApi({ agentToken: token, ownerAuthorized: async (req) => req.headers['x-owner'] === 'yes', artifacts, baseUrl: 'http://localhost' })
    return { api, id }
  }
  it('authenticates agents and owners, uses the registered static tree, and returns shared validation errors', async () => {
    await writeFile(join(dir, 'canvas.json'), JSON.stringify({ title: 'Board', frames: [{ id: 'f', title: 'Frame', src: '../out', x: 0, y: 0 }] }))
    const { api, id } = setup(), path = `/api/redline/artifacts/${id}/canvas`
    expect((await request(api, path, { auth: 'none' })).status).toBe(401)
    for (const auth of ['agent', 'owner'] as const) {
      const result = await request(api, path, { auth })
      expect(result.status).toBe(200)
      expect(result.body.errors).toEqual(['frames[0].src: must be a relative path inside the canvas folder'])
      expect(result.body.manifest.title).toBe('Board')
    }
  })
  it('supports a custom manifest, reports missing/invalid JSON, and confines paths including symlinks', async () => {
    const { api, id } = setup(), path = `/api/redline/artifacts/${id}/canvas`
    expect((await request(api, path)).body.errors).toEqual(['canvas.json: not found'])
    await writeFile(join(dir, 'board.json'), '{')
    expect((await request(api, path + '?manifest=board.json')).body.errors).toEqual(['canvas.json: must be valid JSON'])
    expect((await request(api, path + '?manifest=../out')).status).toBe(400)
    await symlink('/etc/passwd', join(dir, 'escape.json'))
    expect((await request(api, path + '?manifest=escape.json')).status).toBe(404)
    expect((await request(api, path, { method: 'POST' })).status).toBe(405)
  })
})
describe('canvas content API', () => {
  const setup = () => new WebPanesApi({
    service, agentToken: token, ownerAuthorized: async (req) => req.headers['x-owner'] === 'yes',
    paneForId: (id) => id === '%12' || id === '%13' ? { id, sessionId: '$1', windowId: '@1', width: 180, height: 50 } : undefined,
    onChange: vi.fn(), feedback: {} as never, pending: {} as never, attachmentStore: {} as never, agentRequests: {} as never,
  })
  const content = { kind: 'canvas', artifactId: '0123456789abcdef' }
  it('defaults manifest, forces webkit panel, and reuses/activates per anchor', async () => {
    const api = setup(), body = { url: 'http://localhost/redline/artifacts/0123456789abcdef/', anchor: '%12', engine: 'chromium', content }
    const first = await request(api, '/api/web-panes', { body })
    expect(first.status).toBe(201)
    const pane = service.get(first.body.webPaneId)!
    expect(pane).toMatchObject({ dock: 'panel', engine: 'webkit', content: { ...content, manifest: 'canvas.json' } })
    const other = service.open({ url: 'http://localhost/other', anchorPaneId: '%12', sessionId: '$1', windowId: '@1', openedBy: 'user' })
    service.setActiveTab(other.id)
    const reused = await request(api, '/api/web-panes', { body })
    expect(reused.body.webPaneId).toBe(pane.id)
    expect(service.list().find((tab) => tab.activeTab)?.id).toBe(pane.id)
    const second = await request(api, '/api/web-panes', { body: { ...body, anchor: '%13' }, auth: 'owner' })
    expect(second.body.webPaneId).not.toBe(pane.id)
  })
  it.each([null, { kind: 'canvas' }, { ...content, artifactId: '../escape' }, { ...content, manifest: '/escape' }, { ...content, manifest: 2 }])('rejects invalid canvas content %j', async (content) => {
    expect((await request(setup(), '/api/web-panes', { body: { url: 'http://localhost/', anchor: '%12', content } })).status).toBe(400)
    expect(service.list()).toEqual([])
  })
})
