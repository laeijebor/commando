import { createHash, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { MAX_FEEDBACK_NOTES_PER_POST, MAX_WEB_PANE_URL_LENGTH, type WebPane, type WebPaneEngine, type WebPaneFeedbackNote, type WebPanePlacement } from '../shared/protocol.js'
import { MAX_RESPONSE_ANSWER, MAX_RESPONSE_DATA_JSON, MAX_RESPONSE_QUESTION } from '../shared/redline-response.js'
import { MAX_INSPECT_SELECTOR, MAX_INSPECT_TAG, MAX_INSPECT_TEXT } from '../shared/tile-inspect.js'
import { TokenBucketRateLimiter } from './client-messages.js'
import { MAX_FEEDBACK_WAIT_MS, type WebPaneFeedbackStore } from './web-pane-feedback.js'
import { WebPaneError, type WebPaneService } from './web-panes.js'

const API_ROOT = '/api/web-panes'
const MAX_REQUEST_BYTES = 16 * 1024
const PANE_ID = /^%\d+$/
const WEB_PANE_ID = /^w-[0-9a-f]{8}$/
const PLACEMENTS: readonly WebPanePlacement[] = ['right', 'below', 'auto']
const ENGINES: readonly WebPaneEngine[] = ['webkit', 'chromium']

/** Runtime CDP coordinates for a chromium tile's target. */
export type WebPaneCdpInfo = {
  /** ws:// endpoint of the tile's own page target. */
  target: string
  /** Full DevTools frontend URL for the target (open it as a sibling tile). */
  devtoolsFrontendUrl: string
}

type AnchorPane = {
  id: string
  sessionId: string
  windowId: string
  /** Cell size, used to resolve 'auto' placement at open. */
  width: number
  height: number
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
  /** Owner-submit / agent-drain review feedback queue. */
  feedback: WebPaneFeedbackStore
  openLimiter?: TokenBucketRateLimiter
  /**
   * Resolves the live CDP coordinates for a chromium tile (starting its
   * target if needed). Absent when no chromium engine is configured.
   */
  cdpInfo?: (webPaneId: string) => Promise<WebPaneCdpInfo>
  /** Fired after the owner confirms a pending tile (chromium tiles resume navigation here). */
  onConfirmed?: (pane: WebPane) => void
  /** Fired after a tile is deleted so engine targets can be torn down. */
  onClosed?: (webPaneId: string) => void
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

const MAX_FEEDBACK_COMMENT = 4_096

function parseFeedbackNotes(body: Record<string, unknown>): WebPaneFeedbackNote[] {
  const raw = body.notes
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_FEEDBACK_NOTES_PER_POST) {
    throw new HttpError(400, `notes must contain 1 to ${MAX_FEEDBACK_NOTES_PER_POST} entries`)
  }
  return raw.map((entry) => {
    if (typeof entry !== 'object' || entry === null) throw new HttpError(400, 'Each note must be an object')
    const note = entry as Record<string, unknown>
    const rect = note.rect as Record<string, unknown> | undefined
    const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
    if (
      typeof note.selector !== 'string' || note.selector.length === 0 || note.selector.length > MAX_INSPECT_SELECTOR ||
      typeof note.tag !== 'string' || note.tag.length === 0 || note.tag.length > MAX_INSPECT_TAG ||
      (note.text !== undefined && (typeof note.text !== 'string' || note.text.length > MAX_INSPECT_TEXT)) ||
      typeof note.comment !== 'string' || note.comment.length === 0 || note.comment.length > MAX_FEEDBACK_COMMENT ||
      typeof note.pageUrl !== 'string' || note.pageUrl.length > MAX_WEB_PANE_URL_LENGTH ||
      typeof rect !== 'object' || rect === null ||
      !finite(rect.x) || !finite(rect.y) || !finite(rect.width) || !finite(rect.height) ||
      !finite(note.capturedAt) || note.capturedAt < 0
    ) {
      throw new HttpError(400, 'Note is malformed')
    }
    let response: WebPaneFeedbackNote['response']
    if (note.response !== undefined) {
      const raw = note.response as Record<string, unknown> | null
      if (typeof raw !== 'object' || raw === null) throw new HttpError(400, 'Note response is malformed')
      const question = raw.question
      const answer = raw.answer
      if (
        typeof question !== 'string' || question.length === 0 || question.length > MAX_RESPONSE_QUESTION ||
        typeof answer !== 'string' || answer.length === 0 || answer.length > MAX_RESPONSE_ANSWER
      ) {
        throw new HttpError(400, 'Note response is malformed')
      }
      response = { question, answer }
      if (raw.data !== undefined) {
        let json: string | undefined
        try {
          json = JSON.stringify(raw.data)
        } catch {
          throw new HttpError(400, 'Note response is malformed')
        }
        if (json === undefined || json.length > MAX_RESPONSE_DATA_JSON) {
          throw new HttpError(400, 'Note response is malformed')
        }
        response.data = JSON.parse(json) as unknown
      }
    }
    return {
      selector: note.selector,
      tag: note.tag,
      ...(note.text !== undefined ? { text: note.text } : {}),
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      comment: note.comment,
      pageUrl: note.pageUrl,
      capturedAt: note.capturedAt,
      ...(response !== undefined ? { response } : {}),
    }
  })
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
          engine: pane.engine,
        })
        return true
      }

      if (route.action === 'cdp') {
        if (request.method !== 'GET') throw new HttpError(405, 'Method not allowed')
        const pane = this.dependencies.service.get(route.id)
        if (!pane) throw new HttpError(404, 'Web pane does not exist')
        if (pane.engine !== 'chromium') {
          throw new HttpError(409, 'Web pane does not use the chromium engine')
        }
        if (pane.status !== 'open') {
          throw new HttpError(409, 'Web pane is awaiting the owner\'s confirmation')
        }
        if (!this.dependencies.cdpInfo) {
          throw new HttpError(503, 'Chromium engine is not available')
        }
        const info = await this.dependencies.cdpInfo(route.id)
        writeJson(response, 200, { ok: true, webPaneId: route.id, ...info })
        return true
      }

      if (route.action === 'feedback') {
        if (!this.dependencies.service.get(route.id)) {
          throw new HttpError(404, 'Web pane does not exist')
        }
        if (request.method === 'POST') {
          if (caller !== 'owner') {
            throw new HttpError(403, 'Only the owner can submit feedback')
          }
          const notes = parseFeedbackNotes(await readJson(request))
          this.dependencies.feedback.enqueue(route.id, notes)
          this.dependencies.onChange()
          const queued = this.dependencies.feedback.info()[route.id]?.queued ?? 0
          writeJson(response, 200, { ok: true, webPaneId: route.id, queued })
          return true
        }
        if (request.method !== 'GET') throw new HttpError(405, 'Method not allowed')
        if (caller !== 'agent') throw new HttpError(403, 'Only agents poll feedback')
        const waitRaw = url.searchParams.get('wait') ?? '0'
        const wait = Number(waitRaw)
        if (!Number.isFinite(wait) || wait < 0 || wait > MAX_FEEDBACK_WAIT_MS / 1_000) {
          throw new HttpError(400, 'wait must be between 0 and 60 seconds')
        }
        const controller = new AbortController()
        const onClose = (): void => controller.abort()
        request.on('close', onClose)
        try {
          const notes = await this.dependencies.feedback.drain(route.id, wait * 1_000, controller.signal)
          writeJson(response, 200, { ok: true, webPaneId: route.id, notes })
        } finally {
          request.off('close', onClose)
        }
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
        if (pane.status === 'open') this.dependencies.onConfirmed?.(pane)
        this.dependencies.onChange()
        writeJson(response, 200, { ok: true, webPaneId: pane.id, status: pane.status })
        return true
      }

      if (request.method !== 'DELETE') throw new HttpError(405, 'Method not allowed')
      if (!this.dependencies.service.close(route.id)) {
        throw new HttpError(404, 'Web pane does not exist')
      }
      this.dependencies.onClosed?.(route.id)
      this.dependencies.onChange()
      writeJson(response, 200, { ok: true, webPaneId: route.id })
      return true
    } catch (error) {
      if (error instanceof WebPaneError || error instanceof HttpError) {
        if (error.status === 401) {
          response.setHeader('WWW-Authenticate', 'Bearer realm="commando"')
        }
        if (error.status === 405) {
          response.setHeader(
            'Allow',
            url.pathname === API_ROOT
              ? 'GET, POST'
              : url.pathname.endsWith('/cdp') ? 'GET'
              : url.pathname.endsWith('/feedback') ? 'GET, POST'
              : 'POST, DELETE',
          )
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

  private route(pathname: string): { kind: 'collection' } | { kind: 'pane'; id: string; action: 'confirm' | 'cdp' | 'feedback' | 'delete' } {
    if (pathname === API_ROOT) return { kind: 'collection' }
    const match = /^\/api\/web-panes\/([^/]+)(?:\/(confirm|cdp|feedback))?$/.exec(pathname)
    if (!match || !WEB_PANE_ID.test(match[1])) throw new HttpError(404, 'Not found')
    const action = match[2] === 'confirm' ? 'confirm' : match[2] === 'cdp' ? 'cdp' : match[2] === 'feedback' ? 'feedback' : 'delete'
    return { kind: 'pane', id: match[1], action }
  }

  private openPane(body: Record<string, unknown>, caller: 'owner' | 'agent'): WebPane {
    const { url, anchor, placement, engine } = body
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
    if (
      engine !== undefined &&
      (typeof engine !== 'string' || !ENGINES.includes(engine as WebPaneEngine))
    ) {
      throw new HttpError(400, 'engine must be webkit or chromium')
    }
    const anchorPane = this.dependencies.paneForId(anchor)
    if (!anchorPane) throw new HttpError(404, 'Anchor tmux pane does not exist')

    return this.dependencies.service.open({
      url,
      anchorPaneId: anchorPane.id,
      sessionId: anchorPane.sessionId,
      windowId: anchorPane.windowId,
      placement: placement as WebPanePlacement | undefined,
      anchorSize: { cols: anchorPane.width, rows: anchorPane.height },
      engine: engine as WebPaneEngine | undefined,
      openedBy: caller === 'owner' ? 'user' : 'agent',
      openerLabel: caller === 'agent'
        ? this.dependencies.agentLabel?.(anchorPane.id)
        : undefined,
    })
  }
}
