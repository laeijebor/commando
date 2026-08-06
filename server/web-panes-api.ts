import { createHash, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WebPane, WebPanePlacement } from '../shared/protocol.js'
import { TokenBucketRateLimiter } from './client-messages.js'
import { WebPaneError, type WebPaneService } from './web-panes.js'

const API_ROOT = '/api/web-panes'
const MAX_REQUEST_BYTES = 16 * 1024
const PANE_ID = /^%\d+$/
const WEB_PANE_ID = /^w-[0-9a-f]{8}$/
const PLACEMENTS: readonly WebPanePlacement[] = ['right', 'below', 'auto']

type AnchorPane = {
  id: string
  sessionId: string
  windowId: string
}

type WebPanesApiDependencies = {
  service: WebPaneService
  /** The agent hook token — the same secret agents already use for status hooks. */
  agentToken: string
  /** Owner auth (session cookie or COMMANDO_TOKEN bearer/query token). */
  ownerAuthorized: (request: IncomingMessage, url: URL) => Promise<boolean>
  paneForId: (paneId: string) => AnchorPane | undefined
  /** Label for the agent occupying a pane, e.g. "claude · gizmo". */
  agentLabel?: (paneId: string) => string | undefined
  onChange: () => void
  openLimiter?: TokenBucketRateLimiter
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

function writeJson(response: ServerResponse, status: number, value: unknown): void {
  const body = `${JSON.stringify(value)}\n`
  response.writeHead(status, {
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
    'Content-Type': 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
  })
  response.end(body)
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const contentType = request.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase()
  if (contentType !== 'application/json') {
    throw new HttpError(415, 'Content-Type must be application/json')
  }
  const chunks: Buffer[] = []
  let byteLength = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    byteLength += buffer.length
    if (byteLength > MAX_REQUEST_BYTES) throw new HttpError(413, 'Request body is too large')
    chunks.push(buffer)
  }
  if (byteLength === 0) throw new HttpError(400, 'Request body is required')

  let value: unknown
  try {
    value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  } catch {
    throw new HttpError(400, 'Request body is not valid JSON')
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new HttpError(400, 'Request body must be a JSON object')
  }
  return value as Record<string, unknown>
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest()
}

function bearerToken(request: IncomingMessage): string | null {
  const authorization = request.headers.authorization
  if (!authorization) return null
  return /^Bearer\s+([^\s]+)$/i.exec(authorization)?.[1] ?? null
}

export function isWebPanesApiPath(pathname: string): boolean {
  return pathname === API_ROOT || pathname.startsWith(`${API_ROOT}/`)
}

/**
 * Web pane control API. Mounted before the owner-only /api gate so agents can
 * call it with the agent hook token; the owner's cookie or COMMANDO_TOKEN also
 * works. Confirming a pending external URL is owner-only — an agent must not
 * approve its own request.
 */
export class WebPanesApi {
  private readonly agentTokenDigest: Buffer
  private readonly openLimiter: TokenBucketRateLimiter

  constructor(private readonly dependencies: WebPanesApiDependencies) {
    if (dependencies.agentToken.length < 32) {
      throw new Error('Agent hook token must contain at least 32 characters')
    }
    this.agentTokenDigest = digest(dependencies.agentToken)
    // Opening tiles is a human-scale action: 10 quick opens, refilling 1/s.
    this.openLimiter = dependencies.openLimiter ?? new TokenBucketRateLimiter(10, 1)
  }

  async handle(request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean> {
    if (!isWebPanesApiPath(url.pathname)) return false

    try {
      const caller = await this.authenticate(request, url)
      const route = this.route(url.pathname)

      if (route.kind === 'collection') {
        if (request.method === 'GET') {
          writeJson(response, 200, { webPanes: this.dependencies.service.list() })
          return true
        }
        if (request.method !== 'POST') throw new HttpError(405, 'Method not allowed')
        if (!this.openLimiter.take(1)) throw new HttpError(429, 'Too many web pane requests')
        const pane = this.openPane(await readJson(request), caller)
        this.dependencies.onChange()
        writeJson(response, 201, {
          ok: true,
          webPaneId: pane.id,
          beside: pane.anchorPaneId,
          status: pane.status,
        })
        return true
      }

      if (route.action === 'confirm') {
        if (request.method !== 'POST') throw new HttpError(405, 'Method not allowed')
        if (caller !== 'owner') {
          throw new HttpError(403, 'Only the owner can confirm an external URL')
        }
        const body = await readJson(request)
        const allowOrigin = body.allowOrigin === true
        const pane = this.dependencies.service.confirm(route.id, allowOrigin)
        this.dependencies.onChange()
        writeJson(response, 200, { ok: true, webPaneId: pane.id, status: pane.status })
        return true
      }

      if (request.method !== 'DELETE') throw new HttpError(405, 'Method not allowed')
      if (!this.dependencies.service.close(route.id)) {
        throw new HttpError(404, 'Web pane does not exist')
      }
      this.dependencies.onChange()
      writeJson(response, 200, { ok: true, webPaneId: route.id })
      return true
    } catch (error) {
      if (error instanceof WebPaneError || error instanceof HttpError) {
        if (error.status === 401) {
          response.setHeader('WWW-Authenticate', 'Bearer realm="commando"')
        }
        if (error.status === 405) {
          response.setHeader('Allow', url.pathname === API_ROOT ? 'GET, POST' : 'POST, DELETE')
        }
        writeJson(response, error.status, { error: error.message })
        return true
      }
      writeJson(response, 500, { error: 'Web pane action failed' })
      return true
    }
  }

  private async authenticate(request: IncomingMessage, url: URL): Promise<'owner' | 'agent'> {
    if (await this.dependencies.ownerAuthorized(request, url)) return 'owner'
    const candidate = bearerToken(request)
    if (
      candidate !== null &&
      candidate.length <= 1_024 &&
      timingSafeEqual(digest(candidate), this.agentTokenDigest)
    ) {
      return 'agent'
    }
    throw new HttpError(401, 'Unauthorized')
  }

  private route(pathname: string): { kind: 'collection' } | { kind: 'pane'; id: string; action: 'confirm' | 'delete' } {
    if (pathname === API_ROOT) return { kind: 'collection' }
    const match = /^\/api\/web-panes\/([^/]+)(?:\/(confirm))?$/.exec(pathname)
    if (!match || !WEB_PANE_ID.test(match[1])) throw new HttpError(404, 'Not found')
    return { kind: 'pane', id: match[1], action: match[2] === 'confirm' ? 'confirm' : 'delete' }
  }

  private openPane(body: Record<string, unknown>, caller: 'owner' | 'agent'): WebPane {
    const { url, anchor, placement } = body
    if (typeof url !== 'string') throw new HttpError(400, 'url must be a string')
    if (typeof anchor !== 'string' || !PANE_ID.test(anchor)) {
      throw new HttpError(400, 'anchor must be a tmux pane id (use $TMUX_PANE)')
    }
    if (
      placement !== undefined &&
      (typeof placement !== 'string' || !PLACEMENTS.includes(placement as WebPanePlacement))
    ) {
      throw new HttpError(400, 'placement must be right, below, or auto')
    }
    const anchorPane = this.dependencies.paneForId(anchor)
    if (!anchorPane) throw new HttpError(404, 'Anchor tmux pane does not exist')

    return this.dependencies.service.open({
      url,
      anchorPaneId: anchorPane.id,
      sessionId: anchorPane.sessionId,
      windowId: anchorPane.windowId,
      placement: placement as WebPanePlacement | undefined,
      openedBy: caller === 'owner' ? 'user' : 'agent',
      openerLabel: caller === 'agent'
        ? this.dependencies.agentLabel?.(anchorPane.id)
        : undefined,
    })
  }
}
