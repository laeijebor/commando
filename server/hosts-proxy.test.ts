import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, request as httpRequest, type IncomingHttpHeaders, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket, WebSocketServer } from 'ws'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HostsApi } from './hosts-api.js'
import { HostsHealthMonitor, probeHost } from './hosts-health.js'
import { HostsProxy } from './hosts-proxy.js'
import { HostRegistry } from './hosts.js'
import { authorizeBearerOrSession } from './pairing-auth.js'
import { PairingRegistry, requestMatchesBearer } from './pairing.js'
import { MAX_CLIENT_MESSAGE_BYTES } from './client-messages.js'

const LARGE_RESPONSE_BYTES = 20 * 1024 * 1024
const LARGE_WS_BYTES = 6 * 1024 * 1024
const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const task of cleanup.splice(0).reverse()) await task() })
async function listen(server: Server): Promise<string> {
  cleanup.push(async () => {
    server.closeAllConnections()
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()))
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() })
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Expected TCP address')
  return `http://127.0.0.1:${address.port}`
}

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'commando-hosts-proxy-'))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  let redirectHits = 0
  let wsHeaders: IncomingHttpHeaders = {}
  let wsPath = ''
  const behavior = { publicHealth: false, redirectHealth: false }
  const remoteWs = new WebSocketServer({ noServer: true })
  const remote = createServer((request, response) => {
    const url = new URL(request.url!, 'http://localhost')
    if (request.headers.authorization !== 'Bearer remote-secret' && !(behavior.publicHealth && url.pathname === '/api/health')) { response.writeHead(401); response.end(); return }
    if (url.pathname === '/api/health' && behavior.redirectHealth) { response.writeHead(302, { Location: '/api/redirected' }); response.end(); return }
    if (url.pathname === '/api/health') { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ ok: true, version: 'test-version' })); return }
    if (url.pathname === '/api/snapshot') { response.end('{}'); return }
    if (url.pathname === '/api/redirect') { response.writeHead(302, { Location: '/api/redirected', 'Set-Cookie': 'remote=secret' }); response.end(); return }
    if (url.pathname === '/api/redirected') { redirectHits++; response.end('redirect followed'); return }
    if (url.pathname === '/api/chat/images/video') {
      if (request.headers.range !== 'bytes=10-19') { response.writeHead(416); response.end(); return }
      response.writeHead(206, { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Content-Range': `bytes 10-19/${LARGE_RESPONSE_BYTES}`, 'Content-Length': 10 })
      response.end(Buffer.alloc(10, 'v')); return
    }
    if (url.pathname === '/api/large' || url.pathname === '/api/chunked-large') {
      response.writeHead(200, { 'Content-Type': 'application/octet-stream', ...(url.pathname === '/api/large' ? { 'Content-Length': LARGE_RESPONSE_BYTES } : {}) })
      let sent = 0
      const chunk = Buffer.alloc(1024 * 1024)
      const write = () => {
        while (!response.destroyed && sent < LARGE_RESPONSE_BYTES / chunk.length) { sent++; if (!response.write(chunk)) { response.once('drain', write); return } }
        if (!response.destroyed) response.end()
      }
      write(); return
    }
    if (url.pathname === '/api/events') { response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Set-Cookie': 'remote=secret' }); response.write('data: first\n\n'); setImmediate(() => response.end('data: second\n\n')); return }
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      response.writeHead(207, { 'Content-Type': 'application/json', 'Set-Cookie': ['remote=secret'], Connection: 'x-response-private', 'X-Response-Private': 'hidden', 'Content-Security-Policy': "default-src *; script-src * 'unsafe-inline'", 'X-Content-Type-Options': 'unsafe' })
      response.end(JSON.stringify({ headers: request.headers, path: request.url, method: request.method, body: Buffer.concat(chunks).toString() }))
    })
  })
  remote.on('upgrade', (request, socket, head) => {
    if (request.headers.authorization !== 'Bearer remote-secret') { socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); return }
    wsHeaders = request.headers; wsPath = request.url!
    remoteWs.handleUpgrade(request, socket, head, (ws) => remoteWs.emit('connection', ws, request))
  })
  remoteWs.on('connection', (ws) => {
    ws.on('error', () => {})
    ws.on('message', (data, binary) => {
      if (data.toString() === 'large-remote') { ws.send(Buffer.alloc(LARGE_WS_BYTES, 'x')); return }
      if (data.toString() === 'close-remote') ws.close(4001, 'remote closed')
      else ws.send(data, { binary })
    })
  })
  const remoteOrigin = await listen(remote)
  cleanup.push(() => { for (const socket of remoteWs.clients) socket.terminate(); remoteWs.close() })
  const registry = new HostRegistry(join(directory, 'hosts.json'))
  const host = registry.add({ name: 'Hub', baseUrl: remoteOrigin, token: 'remote-secret' })
  const monitor = new HostsHealthMonitor(registry)
  const paired = new PairingRegistry(join(directory, 'paired.json'))
  const { code } = paired.createCode()
  const device = await paired.claim({ code, deviceName: 'Phone', platform: 'ios' }, 'Local')
  const authorized = (request: Parameters<typeof authorizeBearerOrSession>[0], url: URL) => authorizeBearerOrSession(request, url,
    () => requestMatchesBearer(request, url, (token) => token === 'owner-token'), async () => request.headers.cookie === 'owner=valid')
  const proxy = new HostsProxy(registry, authorized)
  const api = new HostsApi(registry, monitor, authorized)
  const local = createServer((request, response) => {
    const url = new URL(request.url!, 'http://localhost')
    void (async () => {
      if (await proxy.handle(request, response, url)) return
      if (await api.handle(request, response, url)) return
      response.writeHead(404); response.end()
    })()
  })
  local.on('upgrade', (request, socket, head) => { void proxy.upgrade(request, socket, head, new URL(request.url!, 'http://localhost')) })
  const origin = await listen(local)
  cleanup.push(() => { monitor.stop(); proxy.close() })
  const fetchProxy = (path: string, options: RequestInit = {}) => fetch(`${origin}/h/${host.id}${path}`, { ...options, headers: { Authorization: 'Bearer owner-token', ...options.headers } })
  const connect = async (query = '') => {
    const ws = new WebSocket(`${origin.replace('http', 'ws')}/h/${host.id}/ws${query}`, ['commando', 'commando-auth.owner-token'], {
      headers: { Authorization: 'Bearer owner-token', Cookie: 'owner=valid', Origin: 'http://local-browser', Referer: 'http://local-browser/page', 'X-Private': 'hidden' },
      finishRequest(request) {
        // ws generates Connection: Upgrade after merging options.headers.
        // Set the nominated hop header after that step so it reaches the proxy.
        request.setHeader('Connection', 'Upgrade, x-private')
        request.end()
      },
    })
    cleanup.push(() => ws.terminate())
    await once(ws, 'open')
    return ws
  }
  return { host, registry, origin, remote, remoteOrigin, remoteWs, proxy, device, fetchProxy, connect, behavior, redirectHits: () => redirectHits, wsHeaders: () => wsHeaders, wsPath: () => wsPath }
}

// These integration tests intentionally bind only ephemeral loopback sockets.
// Restricted sandboxes may return listen EPERM; run this suite on the host then.
describe('remote host HTTP and WebSocket integration', () => {
  let context: Awaited<ReturnType<typeof setup>>
  beforeEach(async () => { context = await setup() })

  it('streams methods and bodies, injects remote auth and Host, strips credentials and hop headers', async () => {
    // Use node:http here: fetch disallows arbitrary Connection header values.
    const response = await new Promise<{ status: number; headers: IncomingHttpHeaders; body: string }>((resolve, reject) => {
      const request = httpRequest(`${context.origin}/h/${context.host.id}/api/echo?token=owner-token&arg=1`, {
        method: 'PATCH', headers: { Authorization: 'Bearer owner-token', Cookie: 'local=secret', Origin: 'http://local-browser', Referer: 'http://local-browser/path', Connection: 'x-private', 'X-Private': 'hidden', 'Content-Type': 'text/plain' },
      }, (incoming) => {
        const chunks: Buffer[] = []
        incoming.on('data', (chunk: Buffer) => chunks.push(chunk))
        incoming.once('error', reject)
        incoming.once('end', () => resolve({ status: incoming.statusCode!, headers: incoming.headers, body: Buffer.concat(chunks).toString() }))
      })
      request.once('error', reject)
      request.end('request body')
    })
    expect(response.status).toBe(207)
    expect(response.headers['set-cookie']).toBeUndefined()
    expect(response.headers['x-response-private']).toBeUndefined()
    expect(response.headers['content-security-policy']).toBe("sandbox; default-src 'none'")
    expect(response.headers['x-content-type-options']).toBe('nosniff')
    const result = JSON.parse(response.body)
    expect(result).toMatchObject({ method: 'PATCH', body: 'request body', path: '/api/echo?arg=1', headers: { authorization: 'Bearer remote-secret', host: new URL(context.remoteOrigin).host, 'content-type': 'text/plain' } })
    for (const header of ['cookie', 'origin', 'referer', 'x-private']) expect(result.headers[header]).toBeUndefined()
  })
  it('returns redirects verbatim without following them or passing Set-Cookie', async () => {
    const response = await context.fetchProxy('/api/redirect', { redirect: 'manual' })
    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe('/api/redirected')
    expect(response.headers.get('set-cookie')).toBeNull()
    expect(context.redirectHits()).toBe(0)
    expect(response.headers.get('content-security-policy')).toBe("sandbox; default-src 'none'")
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
  })
  it('keeps SSE content and framing', async () => {
    const response = await context.fetchProxy('/api/events')
    expect(response.headers.get('content-type')).toBe('text/event-stream')
    expect(response.headers.get('set-cookie')).toBeNull()
    expect(await response.text()).toBe('data: first\n\ndata: second\n\n')
  })
  it('streams responses larger than 16 MiB with and without Content-Length', async () => {
    for (const path of ['/api/large', '/api/chunked-large']) {
      const response = await context.fetchProxy(path)
      expect(response.status).toBe(200)
      let size = 0
      for await (const chunk of response.body!) size += chunk.byteLength
      expect(size).toBe(LARGE_RESPONSE_BYTES)
    }
  })
  it('forwards video Range requests and preserves the 206 response headers and bytes', async () => {
    const response = await context.fetchProxy('/api/chat/images/video', { headers: { Range: 'bytes=10-19' } })
    expect(response.status).toBe(206)
    expect(response.headers.get('content-type')).toBe('video/mp4')
    expect(response.headers.get('accept-ranges')).toBe('bytes')
    expect(response.headers.get('content-range')).toBe(`bytes 10-19/${LARGE_RESPONSE_BYTES}`)
    expect(response.headers.get('content-length')).toBe('10')
    expect(response.headers.get('content-security-policy')).toBe("sandbox; default-src 'none'")
    expect(await response.text()).toBe('v'.repeat(10))
  })
  it('maps a down host to a JSON 502', async () => {
    await new Promise<void>((resolve) => context.remote.close(() => resolve()))
    const response = await context.fetchProxy('/api/echo')
    expect(response.status).toBe(502)
    expect(await response.json()).toMatchObject({ code: 'host_unreachable' })
  })
  it('requires owner authorization and rejects hook and paired tokens despite a valid owner cookie', async () => {
    for (const headers of [{}, { Authorization: 'Bearer hook-token', Cookie: 'owner=valid' }, { Authorization: `Bearer ${context.device.token}` }, { Authorization: `Bearer ${context.device.token}`, Cookie: 'owner=valid' }] as Record<string, string>[]) {
      for (const path of [`/h/${context.host.id}/api/echo`, '/api/hosts']) {
        expect((await fetch(`${context.origin}${path}`, { headers })).status).toBe(401)
      }
    }
    expect((await fetch(`${context.origin}/h/${context.host.id}/api/echo`, { headers: { Cookie: 'owner=valid' } })).status).toBe(207)
  })
  it('returns 404 for unknown hosts and all non-API host paths', async () => {
    for (const path of ['/private', '/api', '/ws', '/api/../../private', '/h/another/api/x']) expect((await context.fetchProxy(path)).status).toBe(404)
    expect((await fetch(`${context.origin}/h/missing/api/echo`, { headers: { Authorization: 'Bearer owner-token' } })).status).toBe(404)
  })
  it('probes both health and protected endpoints and classifies failures', async () => {
    expect(await probeHost(context.host)).toMatchObject({ state: 'online', version: 'test-version' })
    expect(await probeHost({ ...context.host, token: 'hook-token' })).toMatchObject({ state: 'unauthorized' })
    context.behavior.publicHealth = true
    expect(await probeHost({ ...context.host, token: 'hook-token' })).toMatchObject({ state: 'unauthorized' }) // protected endpoint still rejects
    context.behavior.redirectHealth = true
    expect(await probeHost(context.host)).toMatchObject({ state: 'offline' })
    expect(context.redirectHits()).toBe(0)
    context.behavior.redirectHealth = false
    const response = await fetch(`${context.origin}/api/hosts`, { method: 'POST', headers: { Authorization: 'Bearer owner-token', 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Second', baseUrl: context.remoteOrigin, token: 'remote-secret' }) })
    expect(response.status).toBe(201)
    expect(JSON.stringify(await response.json())).not.toContain('remote-secret')
    await new Promise<void>((resolve) => context.remote.close(() => resolve()))
    expect(await probeHost(context.host)).toMatchObject({ state: 'offline' })
  })
  it('round-trips text and binary WS messages without local credentials or browser headers', async () => {
    const ws = await context.connect('?token=owner-token&arg=1')
    expect(ws.protocol).toBe('commando')
    const text = once(ws, 'message'); ws.send('hello')
    expect((await text)[0].toString()).toBe('hello')
    const binary = once(ws, 'message'); ws.send(Buffer.from([1, 2, 3]))
    expect(await binary).toEqual([Buffer.from([1, 2, 3]), true])
    expect(context.wsHeaders()).toMatchObject({ authorization: 'Bearer remote-secret', host: new URL(context.remoteOrigin).host, 'sec-websocket-protocol': 'commando', connection: 'Upgrade', upgrade: 'websocket' })
    for (const header of ['cookie', 'origin', 'referer', 'x-private']) expect(context.wsHeaders()[header]).toBeUndefined()
    expect(context.wsPath()).toBe('/ws?arg=1')
  })
  it('forwards a hub replay frame larger than 4 MiB', async () => {
    const ws = await context.connect()
    const message = once(ws, 'message')
    ws.send('large-remote')
    const [data, binary] = await message
    expect(binary).toBe(true)
    expect(data.length).toBe(LARGE_WS_BYTES)
    expect(data[0]).toBe('x'.charCodeAt(0))
    expect(ws.readyState).toBe(WebSocket.OPEN)
  })
  it('propagates remote close code and reason', async () => {
    const ws = await context.connect()
    const closed = once(ws, 'close'); ws.send('close-remote')
    const [code, reason] = await closed
    expect(code).toBe(4001); expect(reason.toString()).toBe('remote closed')
  })
  it('propagates browser close code and reason', async () => {
    const ws = await context.connect()
    const remote = [...context.remoteWs.clients][0]
    const closed = once(remote, 'close'); ws.close(4002, 'browser closed')
    const [code, reason] = await closed
    expect(code).toBe(4002); expect(reason.toString()).toBe('browser closed')
  })
  it('rejects unauthorized and non-WS upgrades before connecting remotely', async () => {
    for (const [path, token, status] of [['/ws', 'hook-token', 401], ['/ws', context.device.token, 401], ['/private', 'owner-token', 404]] as const) {
      const ws = new WebSocket(`${context.origin.replace('http', 'ws')}/h/${context.host.id}${path}`, { headers: { Authorization: `Bearer ${token}`, Cookie: 'owner=valid' } })
      ws.on('error', () => {})
      cleanup.push(() => ws.terminate())
      const response = new Promise<number>((resolve) => ws.once('unexpected-response', (_request, response) => { response.resume(); resolve(response.statusCode!) }))
      expect(await response).toBe(status)
    }
    expect(context.remoteWs.clients.size).toBe(0)
  })
  it('keeps the daemon client input limit and tears down both transports on shutdown', async () => {
    const ws = await context.connect()
    const closed = once(ws, 'close'); ws.send(Buffer.alloc(MAX_CLIENT_MESSAGE_BYTES + 1))
    expect((await closed)[0]).toBe(1009)
    const second = await context.connect()
    const secondClosed = once(second, 'close')
    context.proxy.close()
    await secondClosed
  })
})
