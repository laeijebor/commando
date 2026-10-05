import { createServer, type Server } from 'node:http'
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { WebSocket, WebSocketServer } from 'ws'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { SessionIde, TmuxPane } from '../shared/protocol.js'
import { SessionIdeService } from './session-ides.js'
import { idePathId, SessionIdeApi } from './session-ides-api.js'

let directory: string
let base: string
let server: Server
let upstream: Server
let service: SessionIdeService
let api: SessionIdeApi
let upstreamSockets: WebSocketServer
let sessions: string[]
let panes: TmuxPane[]
const refresh = vi.fn<() => Promise<void>>()

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ia-'))
  await mkdir(join(directory, 'src'))
  sessions = ['$1', '$2']
  panes = [
    { id: '%1', sessionId: '$1', path: join(directory, 'src'), repo: { root: directory, worktreeRoot: directory } },
    { id: '%2', sessionId: '$2', path: directory },
  ] as TmuxPane[]
  refresh.mockReset().mockResolvedValue(undefined)
  upstream = createServer((req, res) => {
    if (req.url === '/redirect') { res.writeHead(302, { Location: '/destination' }); res.end(); return }
    res.setHeader('X-Frame-Options', 'DENY')
    res.end(JSON.stringify({ path: req.url, authorization: req.headers.authorization, cookie: req.headers.cookie }))
  })
  upstreamSockets = new WebSocketServer({ server: upstream })
  upstreamSockets.on('connection', (ws) => ws.on('message', (data) => ws.send(data)))
  const socketPath = join(directory, 's')
  await new Promise<void>((resolve) => upstream.listen(socketPath, resolve))
  service = new SessionIdeService({ launch: async () => ({ socketPath, stop: async () => {} }) })
  api = new SessionIdeApi({ service, currentSessionIds: () => sessions, currentPanes: () => panes, refresh })
  server = createServer((req, res) => {
    const url = new URL(req.url!, 'http://localhost')
    const id = idePathId(url.pathname)
    if (id) {
      if (!service.authorized(id, req.headers.cookie)) { res.writeHead(401); res.end(); return }
      api.proxy(req, res, url, id)
      return
    }
    if (req.headers.authorization !== 'Bearer owner') { res.writeHead(401); res.end(); return }
    void api.handle(req, res, url)
  })
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url!, 'http://localhost')
    const id = idePathId(url.pathname)
    if (!id || !service.authorized(id, req.headers.cookie)) { socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n'); return }
    api.upgrade(req, socket, head, url, id)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterEach(async () => {
  api.close()
  await service.close()
  for (const client of upstreamSockets.clients) client.terminate()
  upstreamSockets.close()
  server.closeAllConnections()
  upstream.closeAllConnections()
  await Promise.all([server, upstream].map((value) => new Promise<void>((resolve) => value.close(() => resolve()))))
  await rm(directory, { recursive: true, force: true })
})
const open = (sessionId = '$1', body: unknown = {}) => fetch(`${base}/api/ides/sessions/${encodeURIComponent(sessionId)}`, {
  method: 'POST', headers: { Authorization: 'Bearer owner', 'Content-Type': 'application/json' }, body: JSON.stringify(body),
})

it('opens the pane’s worktree root, ignores arbitrary filesystem paths and reuses the existing IDE', async () => {
  const first = await open('$1', { paneId: '%1', workspacePath: '/etc' })
  expect(first.status).toBe(200)
  const { ide } = await first.json() as { ide: SessionIde }
  expect(ide.workspacePath).toBe(await realpath(directory))
  expect(first.headers.get('set-cookie')).toContain('HttpOnly; SameSite=Strict')
  expect(new URL(ide.url).hostname).toBe('127.0.0.1')
  const second = await open('$2')
  const reused = (await second.json()).ide
  expect(reused.id).toBe(ide.id)
  expect(reused.url).toBe(ide.url)
  expect(service.list()).toHaveLength(1)
})

it('uses a distinct authenticated browser origin for each workspace', async () => {
  panes[1].path = join(directory, 'src')
  const first = await open('$1')
  const second = await open('$2')
  const { ide: a } = await first.json() as { ide: SessionIde }
  const { ide: b } = await second.json() as { ide: SessionIde }
  expect(new URL(a.url).origin).not.toBe(new URL(b.url).origin)
  const cookie = first.headers.get('set-cookie')!.split(';')[0]
  expect((await fetch(a.url, { headers: { Cookie: cookie } })).status).toBe(200)
  expect((await fetch(b.url, { headers: { Cookie: cookie } })).status).toBe(401)
  await service.detach('$1')
  api.retainOrigins()
  await expect(fetch(a.url, { headers: { Cookie: cookie } })).rejects.toThrow()
})

it('rejects unknown sessions, cross-session panes and malformed bodies', async () => {
  expect((await open('$99')).status).toBe(404)
  expect((await open('$1', { paneId: '%2' })).status).toBe(400)
  expect((await open('$1', [])).status).toBe(400)
  expect((await open('$1', { padding: 'x'.repeat(5000) })).status).toBe(413)
  expect(service.list()).toEqual([])
})

it('does not retain an attachment if its session closes during startup', async () => {
  refresh.mockImplementation(async () => { if (refresh.mock.calls.length === 2) sessions = ['$2'] })
  expect((await open()).status).toBe(404)
  expect(service.list()).toEqual([])
})

it('proxies authenticated sub-path requests and strips Commando credentials upstream', async () => {
  const opened = await open()
  const { ide } = await opened.json() as { ide: SessionIde }
  const cookie = opened.headers.get('set-cookie')!.split(';')[0]
  expect((await fetch(`${base}/ide/${ide.id}/show`)).status).toBe(401)
  const proxied = await fetch(`${base}/ide/${ide.id}/show?test=1`, { headers: { Cookie: cookie, Authorization: 'Bearer owner' } })
  expect(await proxied.json()).toEqual({ path: '/show?test=1' })
  expect(proxied.headers.get('x-frame-options')).toBeNull()
  expect(proxied.headers.get('content-security-policy')).toContain("frame-ancestors 'self'")
  const redirect = await fetch(`${base}/ide/${ide.id}/redirect`, { headers: { Cookie: cookie }, redirect: 'manual' })
  expect(redirect.headers.get('location')).toBe(`/ide/${ide.id}/destination`)
  await fetch(`${base}/api/ides/sessions/%241`, { method: 'DELETE', headers: { Authorization: 'Bearer owner' } })
  expect((await fetch(`${base}/ide/${ide.id}/show`, { headers: { Cookie: cookie } })).status).toBe(401)
})

it('relays editor WebSockets over the private socket', async () => {
  const opened = await open()
  const { ide } = await opened.json() as { ide: SessionIde }
  const cookie = opened.headers.get('set-cookie')!.split(';')[0]
  const ws = new WebSocket(`${base.replace('http:', 'ws:')}/ide/${ide.id}/?reconnection=true`, { headers: { Cookie: cookie } })
  const result = await new Promise<string>((resolve, reject) => {
    ws.once('error', reject)
    ws.once('open', () => ws.send('editor-message'))
    ws.once('message', (data) => resolve(data.toString()))
  })
  expect(result).toBe('editor-message')
  ws.terminate()
})
