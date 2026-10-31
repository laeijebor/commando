import { request as httpRequest, type ClientRequest, type IncomingHttpHeaders, type OutgoingHttpHeaders, type ServerResponse } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { lookup, type LookupAddress } from 'node:dns'
import { isIP, type LookupFunction } from 'node:net'
import type { HostErrorResponse } from '../shared/hosts.js'
import { HostError } from './hosts.js'
import { isLoopbackAddress, isTailscaleAddress } from './network-access.js'

export const CONNECT_TIMEOUT_MS = 5_000
export const IDLE_TIMEOUT_MS = 30_000
export const HOST_RESPONSE_SECURITY = {
  'Content-Security-Policy': "sandbox; default-src 'none'",
  'X-Content-Type-Options': 'nosniff',
}
const HOP_HEADERS = ['connection', 'keep-alive', 'proxy-connection', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']

export function cleanHeaders(headers: IncomingHttpHeaders, outgoing: boolean): OutgoingHttpHeaders {
  const blocked = new Set([...HOP_HEADERS, ...(headers.connection ?? '').toLowerCase().split(',').map((name) => name.trim()),
    ...(outgoing ? ['authorization', 'cookie', 'origin', 'referer', 'host', 'sec-websocket-key', 'sec-websocket-version', 'sec-websocket-extensions', 'sec-websocket-protocol'] : ['set-cookie', 'set-cookie2', 'content-security-policy', 'x-content-type-options'])])
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !blocked.has(name.toLowerCase())))
}

/** Validate the actual addresses returned to connect(), without resolving again.
 * Resolve all candidates even for single-address callers: mixed safe/unsafe DNS
 * answers fail closed and cannot escape via Node's automatic family selection. */
export function createHostLookup(resolve: typeof lookup = lookup): LookupFunction {
  return (hostname, options, callback) => {
    resolve(hostname, { ...options, all: true }, (error, addresses: LookupAddress[]) => {
      if (error) { callback(error, []); return }
      const allowed = (address: string): boolean => {
        const family = isIP(address)
        if (!family || address.includes('%')) return false
        const canonical = family === 6 ? new URL(`http://[${address}]`).hostname.slice(1, -1) : address
        return isLoopbackAddress(address) || isTailscaleAddress(address) || isLoopbackAddress(canonical) || isTailscaleAddress(canonical)
      }
      if (!addresses.length || addresses.some(({ address }) => !allowed(address))) {
        callback(Object.assign(new Error('Remote hostname resolved outside loopback/Tailscale ranges'), { code: 'EACCES' }), [])
        return
      }
      if (options.all) callback(null, addresses)
      else callback(null, addresses[0].address, addresses[0].family)
    })
  }
}

export function hostLookupFor(url: URL): LookupFunction | undefined {
  return url.hostname.endsWith('.ts.net') ? createHostLookup() : undefined
}

/** No redirect handling: Node's request returns 3xx responses verbatim. */
export function remoteRequest(url: URL, options: Parameters<typeof httpRequest>[1]): ClientRequest {
  const safeLookup = hostLookupFor(url)
  const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, { ...options, ...(safeLookup ? { lookup: safeLookup } : {}) })
  const timer = setTimeout(() => request.destroy(new Error('Remote connect timeout')), CONNECT_TIMEOUT_MS)
  timer.unref()
  request.once('socket', (socket) => {
    if (!socket.connecting) clearTimeout(timer)
    else socket.once(url.protocol === 'https:' ? 'secureConnect' : 'connect', () => clearTimeout(timer))
  })
  request.once('close', () => clearTimeout(timer))
  request.setTimeout(IDLE_TIMEOUT_MS, () => request.destroy(new Error('Remote idle timeout')))
  return request
}

export function hostJson(response: ServerResponse, status: number, value: unknown): void {
  const body = `${JSON.stringify(value)}\n`
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(body), ...HOST_RESPONSE_SECURITY })
  response.end(body)
}

export function hostFailure(response: ServerResponse, error: unknown): void {
  if (response.destroyed) return
  if (response.headersSent) { response.destroy(); return }
  const failure = error instanceof HostError ? error : new HostError(502, 'host_unreachable', 'Remote host is unavailable')
  const body: HostErrorResponse = { error: failure.message, code: failure.code }
  hostJson(response, failure.status, body)
}
