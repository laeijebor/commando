import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import type { Duplex } from 'node:stream'
import type { TmuxPane } from '../shared/protocol.js'
import { SessionIdeService } from './session-ides.js'

export function idePathId(pathname: string): string | null {
  return /^\/ide\/(ide-[a-f0-9]{16})\//.exec(pathname)?.[1] ?? null
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
  response.end(JSON.stringify(body))
}

export class SessionIdeApi {
  private readonly origins = new Map<string, { server: Server; port: number; sockets: Set<Socket>; parents: Set<string> }>()
  private readonly startingOrigins = new Map<string, Promise<number>>()

  constructor(private readonly dependencies: {
    service: SessionIdeService
    currentSessionIds: () => string[]
    currentPanes: () => TmuxPane[]
    refresh: () => Promise<unknown>
    validRequest?: (request: IncomingMessage) => boolean
  }) {}

  /** Browser settings/IndexedDB are origin-scoped, not URL-path-scoped. */
  private editorPort(id: string, parent: string): Promise<number> {
    const existing = this.origins.get(id)
    if (existing) { existing.parents.add(parent); return Promise.resolve(existing.port) }
    const pending = this.startingOrigins.get(id)
    if (pending) return pending.then((port) => { this.origins.get(id)?.parents.add(parent); return port })
    const task = (async () => {
      const sockets = new Set<Socket>()
      const server = createServer((request, response) => {
        const url = this.originRequest(request, id)
        if (!url) { json(response, 401, { error: 'Unauthorized IDE request' }); return }
        this.proxy(request, response, url, id)
      })
      server.on('connection', (socket) => {
        sockets.add(socket)
        socket.on('close', () => sockets.delete(socket))
      })
      server.on('upgrade', (request, socket, head) => {
        const url = this.originRequest(request, id)
        if (!url) { socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n'); return }
        this.upgrade(request, socket, head, url, id)
      })
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', resolve)
      })
      const port = (server.address() as AddressInfo).port
      if (!this.dependencies.service.get(id)) { server.close(); throw new Error('IDE detached during initialization') }
      this.origins.set(id, { server, port, sockets, parents: new Set([parent]) })
      return port
    })().finally(() => this.startingOrigins.delete(id))
    this.startingOrigins.set(id, task)
    return task
  }

  private originRequest(request: IncomingMessage, id: string): URL | null {
    if (this.dependencies.validRequest && !this.dependencies.validRequest(request)) return null
    try {
      const url = new URL(request.url ?? '', 'http://127.0.0.1')
      const host = new URL(`http://${request.headers.host}`)
      if (!['127.0.0.1', 'localhost'].includes(host.hostname) || idePathId(url.pathname) !== id ||
        !this.dependencies.service.authorized(id, request.headers.cookie)) return null
      return url
    } catch { return null }
  }

  retainOrigins(): void {
    for (const [id, origin] of this.origins) {
      if (this.dependencies.service.get(id)) continue
      this.origins.delete(id)
      for (const socket of origin.sockets) socket.destroy()
      origin.server.close()
    }
  }

  close(): void {
    for (const origin of this.origins.values()) {
      for (const socket of origin.sockets) socket.destroy()
      origin.server.close()
    }
    this.origins.clear()
  }

  /** Owner authentication and host/origin checks are enforced by the caller. */
  async handle(request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean> {
    if (!url.pathname.startsWith('/api/ides')) return false
    try {
      if (url.pathname === '/api/ides' && request.method === 'GET') {
        json(response, 200, { ides: this.dependencies.service.list() })
        return true
      }
      const match = /^\/api\/ides\/sessions\/([^/]+)$/.exec(url.pathname)
      if (!match) { json(response, 404, { error: 'Not found' }); return true }
      const sessionId = decodeURIComponent(match[1])
      if (!/^\$\d+$/.test(sessionId)) { json(response, 400, { error: 'Invalid session id' }); return true }
      if (request.method === 'DELETE') {
        await this.dependencies.service.detach(sessionId)
        json(response, 200, { ok: true })
        return true
      }
      if (request.method !== 'POST') { response.setHeader('Allow', 'POST, DELETE'); json(response, 405, { error: 'Method not allowed' }); return true }
      await this.dependencies.refresh()
      if (!this.dependencies.currentSessionIds().includes(sessionId)) { json(response, 404, { error: 'Session no longer exists' }); return true }
      if (request.headers['content-type']?.split(';')[0] !== 'application/json') { json(response, 415, { error: 'Content-Type must be application/json' }); return true }
      let text = ''
      for await (const chunk of request) {
        text += chunk.toString()
        if (Buffer.byteLength(text) > 4096) { json(response, 413, { error: 'Request too large' }); return true }
      }
      let body: { paneId?: unknown }
      try {
        body = JSON.parse(text)
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error()
      } catch { json(response, 400, { error: 'Invalid JSON object' }); return true }
      const panes = this.dependencies.currentPanes().filter((pane) => pane.sessionId === sessionId)
      const pane = body.paneId === undefined ? panes.find((value) => value.repo) ?? panes[0] : panes.find((value) => value.id === body.paneId)
      if (!pane) { json(response, 400, { error: 'Choose a pane in this session to open its workspace' }); return true }
      const workspacePath = pane.repo?.worktreeRoot ?? pane.repo?.root ?? pane.path
      const ide = await this.dependencies.service.attach(sessionId, workspacePath)
      // A session removed while code-server started must not leave an orphan attachment.
      await this.dependencies.refresh()
      if (!this.dependencies.currentSessionIds().includes(sessionId)) {
        await this.dependencies.service.detach(sessionId)
        json(response, 404, { error: 'Session closed during IDE startup' })
        return true
      }
      response.setHeader('Set-Cookie', this.dependencies.service.cookie(ide.id, Boolean((request.socket as { encrypted?: boolean }).encrypted)))
      const host = new URL(`http://${request.headers.host}`).hostname
      // Local clients get a distinct authenticated proxy origin per worktree.
      // Remote deployments retain the main proxy until per-origin routing is configured.
      const editor = ['127.0.0.1', 'localhost'].includes(host)
        ? { ...ide, url: `http://${host}:${await this.editorPort(ide.id, new URL(request.headers.origin ?? `http://${request.headers.host}`).origin)}${ide.url}` }
        : ide
      json(response, 200, { ide: editor })
    } catch (error) { json(response, 502, { error: error instanceof Error ? error.message : 'Unable to open IDE' }) }
    return true
  }

  private target(id: string, url: URL): string {
    return `${url.pathname.slice(`/ide/${id}`.length)}${url.search}`
  }

  proxy(request: IncomingMessage, response: ServerResponse, url: URL, id: string): void {
    const socketPath = this.dependencies.service.socketPath(id)
    if (!socketPath) { json(response, 503, { error: 'IDE is not ready. Reopen it from the session menu.' }); return }
    const headers = { ...request.headers }
    delete headers.authorization
    delete headers.cookie
    const upstream = httpRequest({ socketPath, path: this.target(id, url), method: request.method, headers }, (remote) => {
      const outgoing = { ...remote.headers }
      // code-server uses relative paths under sub-path proxies; rewrite absolute redirects.
      if (outgoing.location?.startsWith('/')) outgoing.location = `/ide/${id}${outgoing.location}`
      const policy = String(outgoing['content-security-policy'] ?? '').split(';').filter((directive) => !/^\s*frame-ancestors\b/.test(directive)).join(';')
      const parents = [...(this.origins.get(id)?.parents ?? [])].join(' ')
      outgoing['content-security-policy'] = `${policy}; frame-ancestors 'self' ${parents}`.trim()
      delete outgoing['x-frame-options']
      delete outgoing['set-cookie']
      response.writeHead(remote.statusCode ?? 502, outgoing)
      remote.pipe(response)
    })
    upstream.on('error', () => { if (!response.headersSent) json(response, 502, { error: 'IDE connection lost' }); else response.destroy() })
    response.on('close', () => upstream.destroy())
    request.pipe(upstream)
  }

  upgrade(request: IncomingMessage, socket: Duplex, head: Buffer, url: URL, id: string): void {
    const socketPath = this.dependencies.service.socketPath(id)
    if (!socketPath) { socket.end('HTTP/1.1 503 Service Unavailable\r\n\r\n'); return }
    const headers = { ...request.headers }
    delete headers.authorization
    delete headers.cookie
    const upstream = httpRequest({ socketPath, path: this.target(id, url), headers })
    upstream.on('upgrade', (remote, peer, upstreamHead) => {
      socket.write(`HTTP/1.1 101 Switching Protocols\r\n${Object.entries(remote.headers).map(([key, value]) => `${key}: ${value}\r\n`).join('')}\r\n`)
      if (head.length) peer.write(head)
      if (upstreamHead.length) socket.write(upstreamHead)
      peer.on('error', () => socket.destroy())
      socket.on('error', () => peer.destroy())
      socket.on('close', () => peer.destroy())
      peer.on('close', () => socket.destroy())
      socket.pipe(peer).pipe(socket)
    })
    upstream.on('response', (remote) => { remote.resume(); socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n') })
    upstream.on('error', () => socket.destroy())
    socket.on('close', () => upstream.destroy())
    upstream.end()
  }
}
