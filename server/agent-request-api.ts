import type { IncomingMessage, ServerResponse } from 'node:http'

import {
  answerAgentRequest,
  IdempotencyKeyMemory,
  isInteractionId,
  parseAgentInteractionAnswer,
  type AgentRequestAnswerDependencies,
} from './agent-request-answers.js'

const API_ROOT = '/api/agent-requests'
const MAX_REQUEST_BYTES = 16 * 1024
const PANE_ID = /^%\d+$/
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{1,128}$/

type AgentRequestApiDependencies = AgentRequestAnswerDependencies & {
  paneExists: (paneId: string) => boolean
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

/**
 * Pane ids look like `%12`, so a client sends them percent-encoded (`%2512`)
 * and the segment is decoded here.
 */
function answerRoute(pathname: string): { paneId: string; interactionId: string } | null {
  const match = /^\/api\/agent-requests\/([^/]+)\/([^/]+)\/answer$/.exec(pathname)
  if (!match) return null
  let paneId: string
  let interactionId: string
  try {
    paneId = decodeURIComponent(match[1])
    interactionId = decodeURIComponent(match[2])
  } catch {
    throw new HttpError(400, 'Invalid agent request path')
  }
  if (!PANE_ID.test(paneId)) throw new HttpError(400, 'Invalid tmux pane id')
  if (!isInteractionId(interactionId)) throw new HttpError(400, 'Invalid agent request id')
  return { paneId, interactionId }
}

/**
 * Owner route behind the shared `/api/*` authorization gate, used by
 * notification actions when no socket is up. It answers exactly the same way an
 * opted-in `/ws` client does.
 */
export class AgentRequestApi {
  private readonly idempotencyKeys = new IdempotencyKeyMemory()

  constructor(private readonly dependencies: AgentRequestApiDependencies) {}

  async handle(request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean> {
    if (url.pathname !== API_ROOT && !url.pathname.startsWith(`${API_ROOT}/`)) return false

    try {
      const route = answerRoute(url.pathname)
      if (!route) throw new HttpError(404, 'Not found')
      if (request.method !== 'POST') throw new HttpError(405, 'Method not allowed')
      if (!this.dependencies.paneExists(route.paneId)) {
        throw new HttpError(404, 'Tmux pane does not exist')
      }

      const body = await readJson(request)
      const answer = parseAgentInteractionAnswer(body.answer)
      if (!answer) throw new HttpError(400, 'Invalid agent request answer')
      const idempotencyKey = body.idempotencyKey
      if (typeof idempotencyKey !== 'string' || !IDEMPOTENCY_KEY.test(idempotencyKey)) {
        throw new HttpError(400, 'Invalid idempotency key')
      }

      if (this.idempotencyKeys.has(idempotencyKey)) {
        writeJson(response, 200, { ok: true, changed: false })
        return true
      }

      const outcome = answerAgentRequest(
        this.dependencies,
        route.paneId,
        route.interactionId,
        answer,
      )
      if (!outcome.ok) {
        throw new HttpError(outcome.code === 'invalid_answer' ? 400 : 409, outcome.message)
      }
      this.idempotencyKeys.remember(idempotencyKey)
      writeJson(response, 200, { ok: true, changed: outcome.changed })
      return true
    } catch (error) {
      if (error instanceof HttpError) {
        if (error.status === 405) response.setHeader('Allow', 'POST')
        writeJson(response, error.status, { error: error.message })
        return true
      }
      writeJson(response, 500, {
        error: error instanceof Error ? error.message : 'Agent request answer failed',
      })
      return true
    }
  }
}
