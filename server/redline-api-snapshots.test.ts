import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RedlineApi } from './redline-api.js'
import { RedlineArtifactRegistry } from './redline-artifacts.js'
import { CanvasSnapshotsStore } from './canvas-snapshots.js'
import { ChromiumEngine } from './chromium-engine.js'
import { WebPaneError } from './web-panes.js'

const token = 'agent-token-with-at-least-32-characters'
let dir: string, artifact: string, id: string, registry: RedlineArtifactRegistry, snapshots: CanvasSnapshotsStore, api: RedlineApi
let screenshot: ReturnType<typeof vi.fn<(url: string, w: number, h: number) => Promise<Buffer>>>
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'snapshot-routes-')); artifact = join(dir, 'artifact'); mkdirSync(artifact)
  registry = new RedlineArtifactRegistry(); id = registry.register(artifact).id
  writeFileSync(join(artifact, 'canvas.json'), JSON.stringify({ title: 'Board', frames: [{ id: 'f', title: 'Frame', src: 'Frame one.html', x: 0, y: 0, w: 390, h: 844 }] }))
  writeFileSync(join(artifact, 'Frame one.html'), '<body>round one</body>')
  snapshots = new CanvasSnapshotsStore(registry, join(dir, 'snapshots')); screenshot = vi.fn()
  api = new RedlineApi({ artifacts: registry, snapshots, screenshot, baseUrl: 'http://localhost:4310', agentToken: token, ownerAuthorized: async (req) => req.headers['x-owner'] === 'yes' })
})
afterEach(() => { rmSync(dir, { recursive: true, force: true }); vi.restoreAllMocks() })
async function request(path: string, auth: 'owner' | 'agent' | 'none' = 'owner', method = 'GET') {
  const writeHead = vi.fn(), end = vi.fn(), setHeader = vi.fn()
  await api.handle({ method, headers: auth === 'owner' ? { 'x-owner': 'yes' } : auth === 'agent' ? { authorization: `Bearer ${token}` } : {} } as unknown as IncomingMessage,
    { writeHead, end, setHeader } as unknown as ServerResponse, new URL(path, 'http://localhost:4310'))
  return { status: writeHead.mock.calls[0][0], headers: writeHead.mock.calls[0][1], body: end.mock.calls[0][0] }
}
describe('snapshot history API and static serving', () => {
  it('requires owner or agent, lists newest first and checks artifacts/methods', async () => {
    const first = snapshots.capture(id, 'canvas.json', 3)!
    writeFileSync(join(artifact, 'Frame one.html'), '<body>round two</body>'); const second = snapshots.capture(id)!
    const path = `/api/redline/artifacts/${id}/canvas/snapshots`
    for (const auth of ['agent', 'owner'] as const) {
      const result = await request(path, auth)
      expect(result.status).toBe(200); expect(JSON.parse(result.body)).toEqual({ snapshots: [second, first] }); expect(result.headers['Cache-Control']).toBe('no-store')
    }
    expect((await request(path, 'none')).status).toBe(401)
    expect((await request(path, 'owner', 'POST')).status).toBe(405)
    expect((await request('/api/redline/artifacts/0000000000000000/canvas/snapshots')).status).toBe(404)
  })
  it('serves immutable no-store snapshot files with optional frame-script injection and confined paths', async () => {
    writeFileSync(join(artifact, 'index.html'), '<body>index</body>')
    const snapshot = snapshots.capture(id)!, base = `/redline/canvas-snapshots/${id}/${snapshot.id}/`
    writeFileSync(join(artifact, 'Frame one.html'), '<body>updated</body>')
    expect((await request(base, 'none')).body.toString()).toBe('<body>index</body>')
    const result = await request(`${base}Frame%20one.html?canvas-frame=f`, 'none')
    expect(result.status).toBe(200); expect(result.body.toString()).toBe('<body>round one<script src="/redline/canvas-frame.js" data-canvas-frame="f"></script></body>')
    expect(result.headers['Content-Length']).toBe(result.body.length); expect(result.headers['Cache-Control']).toBe('no-store')
    expect((await request(`${base}Frame%20one.html`, 'none')).body.toString()).toBe('<body>round one</body>')
    expect((await request(`${base}canvas.json?canvas-frame=f`, 'none')).headers['Content-Type']).toMatch(/json/)
    for (const path of ['missing', '%2e%2e%2fmeta.json', '%2fetc%2fpasswd', '%00', '.hash']) expect((await request(base + path, 'none')).status).toBe(404)
    expect((await request(`${base}Frame%20one.html?canvas-frame=bad%2Fid`, 'none')).status).toBe(400)
    expect((await request(base + 'canvas.json', 'none', 'POST')).status).toBe(405)
    symlinkSync(join(artifact, 'Frame one.html'), join(snapshots.root, id, snapshot.id, 'files', 'link'))
    expect((await request(base + 'link', 'none')).status).toBe(404)
    expect((await request(`/api/redline/artifacts/${id}`, 'agent', 'DELETE')).status).toBe(200)
    expect((await request(base + 'canvas.json', 'none')).status).toBe(404)
    expect(snapshots.list(id)).toEqual([])
  })
})
describe('PNG export route', () => {
  const route = () => `/api/redline/artifacts/${id}/canvas/frames/f.png?manifest=canvas.json`
  it('accepts only owner auth and guards missing frames/manifests and invalid paths', async () => {
    expect((await request(route(), 'agent')).status).toBe(401); expect((await request(route(), 'none')).status).toBe(401)
    expect(screenshot).not.toHaveBeenCalled()
    expect((await request(route(), 'owner', 'POST')).status).toBe(405)
    expect((await request(route().replace('/f.png', '/missing.png'))).status).toBe(404)
    expect((await request(route().replace('manifest=canvas.json', 'manifest=missing.json'))).status).toBe(404)
    expect((await request(route().replace('manifest=canvas.json', 'manifest=../canvas.json'))).status).toBe(400)
    rmSync(join(artifact, 'Frame one.html')); expect((await request(route())).status).toBe(404)
  })
  it('returns a clear 503 when no Chromium is available and preserves timeout errors', async () => {
    screenshot.mockRejectedValueOnce(new WebPaneError(503, 'No Chromium-family browser found. Install Google Chrome or set COMMANDO_CHROMIUM_PATH.'))
    const result = await request(route())
    expect(result.status).toBe(503); expect(JSON.parse(result.body).error).toContain('COMMANDO_CHROMIUM_PATH')
    screenshot.mockRejectedValueOnce(new WebPaneError(504, 'PNG export timed out after 15s'))
    expect((await request(route())).status).toBe(504)
    api = new RedlineApi({ artifacts: registry, baseUrl: 'http://localhost:4310', agentToken: token, ownerAuthorized: async () => true })
    expect((await request(route())).status).toBe(503)
  })
  it('returns image/png through the engine with fake CDP at frame dimensions and no injection query', async () => {
    const engine = new ChromiumEngine({ classify: () => ({ kind: 'open' }), onExternalNavigation: vi.fn() })
    const closeTarget = vi.fn(), png = Buffer.from('fake-png')
    vi.spyOn(engine as unknown as { ensureBrowser: () => Promise<unknown> }, 'ensureBrowser').mockResolvedValue({ launch: { port: 9222 }, cdp: { send: async () => ({ targetId: 'export' }), sendAndForget: closeTarget } })
    let load: () => void = () => {}
    const page = { on: (_event: string, handler: (params: Record<string, unknown>) => void) => { load = () => handler({}) }, close: vi.fn(), send: vi.fn(async (method: string) => {
      if (method === 'Page.navigate') load()
      return method === 'Page.captureScreenshot' ? { data: png.toString('base64') } : {}
    }) }
    screenshot.mockImplementation((url, w, h) => engine.screenshot(url, w, h, async () => page))
    const result = await request(route())
    expect(screenshot).toHaveBeenCalledWith(`http://localhost:4310/redline/artifacts/${id}/Frame%20one.html`, 390, 844)
    expect(result.status).toBe(200); expect(result.body).toEqual(png); expect(result.headers['Content-Type']).toBe('image/png')
    expect(result.headers['Cache-Control']).toBe('no-store'); expect(closeTarget).toHaveBeenCalledOnce(); expect(page.close).toHaveBeenCalledOnce()
  })
})
