import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RedlineApi } from './redline-api.js'
import { RedlineArtifactRegistry } from './redline-artifacts.js'

let dir: string, id: string, api: RedlineApi
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'canvas-static-'))
  const artifacts = new RedlineArtifactRegistry()
  id = artifacts.register(dir).id
  api = new RedlineApi({ artifacts, baseUrl: 'http://localhost:4310', agentToken: 'agent-token-with-at-least-32-characters', ownerAuthorized: async () => false })
})
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })
async function get(path: string, method = 'GET') {
  const writeHead = vi.fn(), end = vi.fn(), setHeader = vi.fn()
  const handled = await api.handle({ method, headers: {} } as IncomingMessage, { writeHead, end, setHeader } as unknown as ServerResponse, new URL(path, 'http://localhost:4310'))
  return { handled, status: writeHead.mock.calls[0]?.[0], headers: writeHead.mock.calls[0]?.[1], body: end.mock.calls[0]?.[0], setHeader }
}
const script = '<script src="/redline/canvas-frame.js" data-canvas-frame="settings_1-2"></script>'
describe('canvas static serving without sockets', () => {
  it('serves the frame script as unauthenticated JavaScript and rejects other methods', async () => {
    const result = await get('/redline/canvas-frame.js')
    expect(result.status).toBe(200)
    expect(result.headers['Content-Type']).toMatch(/^text\/javascript/)
    expect(result.body.toString()).toContain('commando-canvas-frame')
    expect((await get('/redline/canvas-frame.js', 'POST')).status).toBe(405)
  })
  it.each(['<html><body>héllo</body></html>', '<body>héllo</BODY >', 'héllo'])('injects only opted-in registered HTML, preserves reload and byte length: %s', async (html) => {
    await writeFile(join(dir, 'index.html'), html)
    const path = `/redline/artifacts/${id}/index.html`
    const original = await get(path)
    expect(original.body.toString()).toBe(html)
    const result = await get(path + '?canvas-frame=settings_1-2&canvas-reload=3')
    const expected = /<\/body\s*>/i.test(html) ? html.replace(/<\/body\s*>/i, (match) => script + match) : html + script
    expect(result.body.toString()).toBe(expected)
    expect(result.headers['Content-Length']).toBe(Buffer.byteLength(expected))
    expect(result.headers['Cache-Control']).toBe('no-store')
    expect((await get(path)).body.toString()).toBe(html)
    await writeFile(join(dir, 'index.html'), '<body>new</body>')
    expect((await get(path + '?canvas-frame=settings_1-2')).body.toString()).toBe('<body>new' + script + '</body>')
  })
  it('leaves non-HTML intact and confines requests to registered files', async () => {
    await writeFile(join(dir, 'asset.js'), 'const x = "</body>"')
    expect((await get(`/redline/artifacts/${id}/asset.js?canvas-frame=f`)).body.toString()).toBe('const x = "</body>"')
    expect((await get('/redline/artifacts/0000000000000000/index.html?canvas-frame=f')).status).toBe(404)
    expect((await get('/redline/design/default.css?canvas-frame=f')).body.toString()).not.toContain('data-canvas-frame')
  })
  it('inserts before the final body close when an earlier script contains that string', async () => {
    const html = '<body><script>const template = "</body>"</script>hi</body>'
    await writeFile(join(dir, 'index.html'), html)
    expect((await get(`/redline/artifacts/${id}/?canvas-frame=settings_1-2`)).body.toString()).toBe('<body><script>const template = "</body>"</script>hi' + script + '</body>')
  })
  it.each(['', 'a'.repeat(65), '<script>', 'space name', 'é', 'a/b'])('rejects invalid frame id %j', async (frameId) => {
    await writeFile(join(dir, 'index.html'), '<body>hi</body>')
    expect((await get(`/redline/artifacts/${id}/?canvas-frame=${encodeURIComponent(frameId)}`)).status).toBe(400)
  })
  it('accepts the 64-character boundary', async () => {
    await writeFile(join(dir, 'index.html'), '<body>hi</body>')
    expect((await get(`/redline/artifacts/${id}/?canvas-frame=${'a'.repeat(64)}`)).status).toBe(200)
  })
})
