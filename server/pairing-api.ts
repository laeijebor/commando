import type { IncomingMessage, ServerResponse } from 'node:http'
import { hostname } from 'node:os'
import type { PairingClaimRequest } from '../shared/pairing.js'
import { PairingError, type PairingRegistry } from './pairing.js'

type PairingDetails = { urls: string[]; name: string; tailscaleEnabled: boolean }
function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' })
  response.end(JSON.stringify(value))
}
async function body(request: IncomingMessage): Promise<PairingClaimRequest> {
  if (request.headers['content-type']?.split(';')[0].trim() !== 'application/json') throw new PairingError(415, 'Expected JSON')
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk)
    size += bytes.length
    if (size > 4096) throw new PairingError(413, 'Request too large')
    chunks.push(bytes)
  }
  let value: unknown
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new PairingError(400, 'Invalid JSON') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new PairingError(400, 'Invalid request')
  const input = value as PairingClaimRequest
  if (typeof input.code !== 'string' || input.code.length > 1024) throw new PairingError(401, 'Invalid pairing code')
  return input
}

/** Must be called after the daemon's unchanged network gate, before general bearer auth. */
export class PairingApi {
  constructor(private readonly registry: PairingRegistry, private readonly ownerAuthorized: (request: IncomingMessage, url: URL) => Promise<boolean>, private readonly details: () => Promise<PairingDetails>) {}

  async handle(request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean> {
    if (!url.pathname.startsWith('/api/pairing/')) return false
    try {
      if (url.pathname === '/api/pairing/claim') {
        if (request.method !== 'POST') { response.setHeader('Allow', 'POST'); throw new PairingError(405, 'Method not allowed') }
        if (!this.registry.allowClaim(request.socket.remoteAddress ?? 'unknown')) {
          response.setHeader('Retry-After', '60')
          throw new PairingError(429, 'Too many pairing attempts. Try again in a minute.')
        }
        const input = await body(request)
        const result = await this.registry.claim(input, hostname())
        json(response, 200, result)
        return true
      }
      if (!(await this.ownerAuthorized(request, url))) throw new PairingError(401, 'Unauthorized')
      if (url.pathname === '/api/pairing/codes' && request.method === 'POST') {
        // Discover first so the full lifetime starts when the QR can be rendered.
        const details = await this.details()
        if (response.destroyed) return true
        json(response, 200, { ...details, ...this.registry.createCode() })
      } else if (url.pathname === '/api/pairing/devices' && request.method === 'GET') {
        json(response, 200, { devices: this.registry.list() })
      } else {
        const match = /^\/api\/pairing\/devices\/([a-f0-9-]{36})$/.exec(url.pathname)
        if (match && request.method === 'DELETE') {
          if (!(await this.registry.revoke(match[1]))) throw new PairingError(404, 'Device not found')
          json(response, 200, { ok: true })
        } else throw new PairingError(404, 'Not found')
      }
    } catch (error) {
      json(response, error instanceof PairingError ? error.status : 500, {
        error: error instanceof PairingError ? error.message : 'Pairing request failed',
      })
    }
    return true
  }
}
