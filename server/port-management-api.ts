import type { IncomingMessage, ServerResponse } from 'node:http'
import type { OpenPort } from '../shared/protocol.js'
import { OpenPortNotFoundError, type OpenPortTarget, type TerminatedSessionPorts } from './open-ports.js'
import { validateTmuxPaneId } from './tmux-pane-actions.js'
import { validateTmuxSessionId } from './tmux-session-actions.js'

const API_ROOT = '/api/port-management'
const MAX_REQUEST_BYTES = 16 * 1024

type PortActions = {
  terminatePort(target: OpenPortTarget): Promise<OpenPort>
  terminateSessionPorts(sessionId: string): Promise<TerminatedSessionPorts>
}

type PortManagementDependencies = {
  actions: PortActions
  currentSessionIds: () => readonly string[]
  onPortsChanged?: () => void | Promise<void>
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
  if (contentType !== 'application/json') throw new HttpError(415, 'Content-Type must be application/json')

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

function validatePort(value: unknown): number {
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 65_535) {
    throw new HttpError(400, 'Port must be an integer between 1 and 65535')
  }
  return value as number
}

function sessionRoute(pathname: string): string | null {
  const match = /^\/api\/port-management\/sessions\/([^/]+)\/kill$/.exec(pathname)
  if (!match) return null
  try {
    return validateTmuxSessionId(decodeURIComponent(match[1]))
  } catch {
    throw new HttpError(400, 'Invalid tmux session id')
  }
}

export class PortManagementApi {
  constructor(private readonly dependencies: PortManagementDependencies) {}

  async handle(request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean> {
    if (url.pathname !== API_ROOT && !url.pathname.startsWith(`${API_ROOT}/`)) return false

    try {
      if (url.pathname === `${API_ROOT}/ports/kill`) {
        if (request.method !== 'DELETE') throw new HttpError(405, 'Method not allowed')
        const body = await readJson(request)
        let target: OpenPortTarget
        try {
          target = {
            sessionId: validateTmuxSessionId(body.sessionId),
            paneId: validateTmuxPaneId(body.paneId),
            port: validatePort(body.port),
          }
        } catch (error) {
          if (error instanceof HttpError) throw error
          throw new HttpError(400, error instanceof Error ? error.message : 'Invalid open port target')
        }
        if (body.confirmPort !== target.port) {
          throw new HttpError(400, 'Termination requires an exact confirmPort')
        }
        const terminated = await this.dependencies.actions.terminatePort(target)
        await this.dependencies.onPortsChanged?.()
        writeJson(response, 200, { ok: true, terminated })
        return true
      }

      const sessionId = sessionRoute(url.pathname)
      if (!sessionId) throw new HttpError(404, 'Not found')
      if (!this.dependencies.currentSessionIds().includes(sessionId)) {
        throw new HttpError(404, 'Tmux session does not exist')
      }
      if (request.method !== 'DELETE') throw new HttpError(405, 'Method not allowed')
      const body = await readJson(request)
      if (body.confirmSessionId !== sessionId) {
        throw new HttpError(400, 'Termination requires an exact confirmSessionId')
      }
      const terminated = await this.dependencies.actions.terminateSessionPorts(sessionId)
      await this.dependencies.onPortsChanged?.()
      writeJson(response, 200, { ok: true, sessionId, ...terminated })
      return true
    } catch (error) {
      if (error instanceof OpenPortNotFoundError) {
        writeJson(response, 404, { error: error.message })
        return true
      }
      if (error instanceof HttpError) {
        if (error.status === 405) response.setHeader('Allow', 'DELETE')
        writeJson(response, error.status, { error: error.message })
        return true
      }
      writeJson(response, 502, {
        error: error instanceof Error ? error.message : 'Port management action failed',
      })
      return true
    }
  }
}
