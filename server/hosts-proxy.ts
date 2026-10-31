import type { ClientRequest, IncomingMessage, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocket, WebSocketServer } from 'ws'
import type { HostAuthorization } from './hosts-api.js'
import { HostError, HostRegistry } from './hosts.js'
import { cleanHeaders, CONNECT_TIMEOUT_MS, hostFailure, hostLookupFor, HOST_RESPONSE_SECURITY, IDLE_TIMEOUT_MS, remoteRequest } from './hosts-transport.js'
import { MAX_CLIENT_MESSAGE_BYTES } from './client-messages.js'
import { MAX_CHAT_HISTORY_BYTES } from './chat-replay.js'
import { HostWsForwarder } from './hosts-ws.js'

// Allow the daemon's 64 MiB chat replay plus JSON/envelope overhead.
const MAX_REMOTE_MESSAGE_BYTES = MAX_CHAT_HISTORY_BYTES + 16 * 1024 * 1024

/** Match only the two explicitly delegated namespaces. Never resolve a client
 * supplied absolute URL or a second host-relative path against the target. */
export function hostProxyRoute(url: URL): { id: string; path: string; ws: boolean } | null {
  const match = /^\/h\/([a-z0-9]+(?:-[a-z0-9]+)*)\/(api\/.*|ws)$/.exec(url.pathname)
  if (!match) return null
  const query = new URLSearchParams(url.search)
  query.delete('token') // Local authentication belongs to this daemon only.
  return { id: match[1], path: `/${match[2]}${query.size ? `?${query}` : ''}`, ws: match[2] === 'ws' }
}

function rejectUpgrade(socket: Duplex, status: number, code: string): void {
  if (socket.destroyed || socket.writableEnded) return
  const body = JSON.stringify({ error: code, code })
  socket.end(`HTTP/1.1 ${status} ${status === 401 ? 'Unauthorized' : status === 404 ? 'Not Found' : 'Bad Gateway'}\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Security-Policy: ${HOST_RESPONSE_SECURITY['Content-Security-Policy']}\r\nX-Content-Type-Options: nosniff\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`)
}

export class HostsProxy {
  private readonly requests = new Set<ClientRequest>()
  private readonly sockets = new Set<WebSocket>()
  private readonly pendingUpgrades = new Set<Duplex>()
  private readonly protocols = new WeakMap<IncomingMessage, string>()
  private readonly server = new WebSocketServer({ noServer: true, maxPayload: MAX_CLIENT_MESSAGE_BYTES, perMessageDeflate: false,
    handleProtocols: (_protocols, request) => this.protocols.get(request) || false })
  private closed = false
  constructor(private readonly registry: HostRegistry, private readonly ownerAuthorized: HostAuthorization) {
    this.server.on('headers', (headers) => {
      for (const [name, value] of Object.entries(HOST_RESPONSE_SECURITY)) headers.push(`${name}: ${value}`)
    })
  }

  async handle(request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean> {
    if (url.pathname !== '/h' && !url.pathname.startsWith('/h/')) return false
    try {
      const route = hostProxyRoute(url)
      if (!route || route.ws) throw new HostError(404, 'not_found', 'Host route does not exist')
      if (!(await this.ownerAuthorized(request, url))) throw new HostError(401, 'unauthorized', 'Owner authorization required')
      const host = this.registry.get(route.id)
      if (this.closed) throw new Error('Proxy stopped')
      const target = new URL(host.baseUrl)
      const headers = cleanHeaders(request.headers, true)
      headers.host = target.host
      headers.authorization = `Bearer ${host.token}`
      const remote = remoteRequest(target, { method: request.method, path: route.path, headers })
      this.requests.add(remote)
      remote.once('close', () => this.requests.delete(remote))
      const abort = () => remote.destroy()
      request.once('aborted', abort)
      request.once('error', abort)
      response.once('close', abort)
      remote.once('error', () => hostFailure(response, new HostError(502, 'host_unreachable', 'Remote host is unavailable')))
      remote.once('response', (upstream) => {
        upstream.once('error', () => hostFailure(response, new HostError(502, 'host_unreachable', 'Remote response interrupted')))
        response.writeHead(upstream.statusCode ?? 502, { ...cleanHeaders(upstream.headers, false), ...HOST_RESPONSE_SECURITY })
        upstream.pipe(response)
        response.once('close', () => upstream.destroy())
      })
      request.pipe(remote)
    } catch (error) { hostFailure(response, error) }
    return true
  }

  async upgrade(request: IncomingMessage, socket: Duplex, head: Buffer, url: URL): Promise<void> {
    const route = hostProxyRoute(url)
    if (!route?.ws) { rejectUpgrade(socket, 404, 'not_found'); return }
    try {
      if (!(await this.ownerAuthorized(request, url))) { rejectUpgrade(socket, 401, 'unauthorized'); return }
      const host = this.registry.get(route.id)
      if (this.closed || socket.destroyed) throw new Error('Proxy stopped')
      const target = new URL(route.path, host.baseUrl)
      target.protocol = target.protocol === 'https:' ? 'wss:' : 'ws:'
      const headers = cleanHeaders(request.headers, true)
      headers.host = target.host; headers.authorization = `Bearer ${host.token}`
      const protocols = (request.headers['sec-websocket-protocol'] ?? '').split(',').map((value) => value.trim()).filter((value) => value && value !== 'commando-auth' && !value.startsWith('commando-auth.'))
      const remote = new WebSocket(target, protocols, { headers, followRedirects: false, handshakeTimeout: CONNECT_TIMEOUT_MS,
        maxPayload: MAX_REMOTE_MESSAGE_BYTES, perMessageDeflate: false, lookup: hostLookupFor(target) })
      this.sockets.add(remote); this.pendingUpgrades.add(socket)
      let local: WebSocket | undefined
      const abort = () => remote.terminate()
      socket.once('close', abort)
      socket.once('error', abort)
      remote.once('close', () => { this.sockets.delete(remote); this.pendingUpgrades.delete(socket) })
      remote.on('error', () => {
        if (!local) rejectUpgrade(socket, 502, 'host_unreachable')
      })
      remote.once('unexpected-response', (_request, response) => {
        response.destroy()
        rejectUpgrade(socket, 502, response.statusCode === 401 || response.statusCode === 403 ? 'host_unauthorized' : 'host_unreachable')
        remote.terminate()
      })
      remote.once('open', () => {
        if (this.closed || socket.destroyed) { remote.terminate(); return }
        this.pendingUpgrades.delete(socket)
        try {
          // Mirror the upstream application protocol. An auth-only offer is
          // consumed locally and never sent to the remote daemon.
          this.protocols.set(request, remote.protocol || (protocols.length === 0 ? request.headers['sec-websocket-protocol']?.split(',')[0].trim() ?? '' : ''))
          this.server.handleUpgrade(request, socket, head, (client) => {
            socket.off('close', abort)
            socket.off('error', abort)
            local = client
            this.sockets.add(client)
            client.once('close', () => this.sockets.delete(client))
            this.bridge(client, remote)
          })
        } catch { remote.terminate(); socket.destroy() }
      })
    } catch (error) {
      rejectUpgrade(socket, error instanceof HostError ? error.status : 502, error instanceof HostError ? error.code : 'host_unreachable')
    }
  }

  private bridge(a: WebSocket, b: WebSocket): void {
    const forwarders = [new HostWsForwarder(a, b), new HostWsForwarder(b, a)]
    const alive = new Set([a, b])
    const timer = setInterval(() => {
      // Pausing reception also pauses control frames. A large replay flushing
      // to a slow client must not be mistaken for a missed heartbeat. Each
      // forwarder separately terminates peers whose paused backlog stalls.
      if (forwarders.some((forwarder) => forwarder.isPaused)) { alive.add(a); alive.add(b); return }
      if (alive.size !== 2) { a.terminate(); b.terminate(); return }
      alive.clear()
      for (const socket of [a, b]) if (socket.readyState === WebSocket.OPEN) socket.ping()
    }, IDLE_TIMEOUT_MS)
    timer.unref()
    a.on('pong', () => { alive.add(a) })
    b.on('pong', () => { alive.add(b) })
    for (const [source, destination] of [[a, b], [b, a]]) {
      source.once('close', (code, reason) => {
        clearInterval(timer)
        if (destination.readyState === WebSocket.OPEN || destination.readyState === WebSocket.CONNECTING) {
          if (code === 1006 || code === 1005 || code === 1015) destination.terminate()
          else destination.close(code, reason)
        }
      })
      source.on('error', () => {
        // ws may already be sending a protocol-error close (e.g. 1009). Let it
        // flush that frame before tearing down its peer.
        if (source.readyState === WebSocket.OPEN) source.close(1011, 'Proxy transport error')
        if (destination.readyState === WebSocket.OPEN) destination.close(1011, 'Proxy transport error')
      })
    }
  }

  close(): void {
    this.closed = true
    for (const request of this.requests) request.destroy()
    for (const socket of this.sockets) socket.terminate()
    for (const socket of this.pendingUpgrades) socket.destroy()
    this.server.close()
  }
}
