import { createHash, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AgentStatusChange, AgentStatusRegistry } from './agent-status-registry.js'

const API_ROOT = '/api/agent-status/hooks'
const MAX_REQUEST_BYTES = 64 * 1024
const PANE_ID = /^%\d+$/

type AgentStatusApiDependencies = {
  token: string
  registry: AgentStatusRegistry
  paneExists: (paneId: string) => boolean
  paneCommand: (paneId: string) => string | undefined
  onChange: (change: AgentStatusChange) => void
  now?: () => number
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
  const declaredLength = Number(request.headers['content-length'] ?? 0)
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) {
    throw new HttpError(413, 'Request body is too large')
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

function paneId(request: IncomingMessage): string {
  const value = request.headers['x-commando-pane']
  if (typeof value !== 'string' || !PANE_ID.test(value)) {
    throw new HttpError(400, 'X-Commando-Pane must be a tmux pane id')
  }
  return value
}

function requiredString(body: Record<string, unknown>, property: string): void {
  const value = body[property]
  if (typeof value !== 'string' || value.length === 0 || value.length > 256) {
    throw new HttpError(400, `${property} must be a non-empty string`)
  }
}

export function isAgentStatusHookPath(pathname: string): boolean {
  return pathname === API_ROOT || pathname.startsWith(`${API_ROOT}/`)
}

export class AgentStatusHookApi {
  private readonly tokenDigest: Buffer

  constructor(private readonly dependencies: AgentStatusApiDependencies) {
    if (dependencies.token.length < 32) throw new Error('Agent hook token must contain at least 32 characters')
    this.tokenDigest = digest(dependencies.token)
  }

  async handle(request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean> {
    if (!isAgentStatusHookPath(url.pathname)) return false

    try {
      const candidate = bearerToken(request)
      if (
        candidate === null ||
        candidate.length > 1_024 ||
        !timingSafeEqual(digest(candidate), this.tokenDigest)
      ) {
        response.setHeader('WWW-Authenticate', 'Bearer realm="commando-agent-hooks"')
        throw new HttpError(401, 'Unauthorized')
      }
      if (request.method !== 'POST') throw new HttpError(405, 'Method not allowed')

      const provider = url.pathname.slice(`${API_ROOT}/`.length)
      if (provider !== 'claude' && provider !== 'opencode') {
        throw new HttpError(404, 'Not found')
      }
      const targetPaneId = paneId(request)
      if (!this.dependencies.paneExists(targetPaneId)) {
        throw new HttpError(404, 'Tmux pane does not exist')
      }
      const processCommand = this.dependencies.paneCommand(targetPaneId) ?? null

      const body = await readJson(request)
      const updatedAt = this.dependencies.now?.() ?? Date.now()
      let change: AgentStatusChange
      if (provider === 'claude') {
        requiredString(body, 'hook_event_name')
        requiredString(body, 'session_id')
        change = this.dependencies.registry.applyClaudeHook(
          targetPaneId,
          body,
          updatedAt,
          processCommand,
        )
      } else {
        const event = body.event
        if (typeof event !== 'object' || event === null || Array.isArray(event)) {
          throw new HttpError(400, 'event must be a JSON object')
        }
        const eventRecord = event as Record<string, unknown>
        requiredString(eventRecord, 'type')
        if (
          typeof eventRecord.properties !== 'object' ||
          eventRecord.properties === null ||
          Array.isArray(eventRecord.properties)
        ) {
          throw new HttpError(400, 'event.properties must be a JSON object')
        }
        change = this.dependencies.registry.applyOpenCodeEvent(
          targetPaneId,
          event,
          updatedAt,
          processCommand,
        )
      }

      this.dependencies.onChange(change)
      writeJson(response, 200, { ok: true, changed: change !== null })
      return true
    } catch (error) {
      if (error instanceof HttpError) {
        if (error.status === 405) response.setHeader('Allow', 'POST')
        writeJson(response, error.status, { error: error.message })
        return true
      }
      writeJson(response, 500, { error: 'Unable to record agent status' })
      return true
    }
  }
}
