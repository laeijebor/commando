import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  parseSessionTreePreferences,
  SessionPreferenceStore,
  type SessionTreePreferences,
} from './session-preferences.js'
import {
  TmuxSessionActions,
  validateTmuxSessionId,
  validateTmuxSessionName,
  validateTmuxWindowId,
} from './tmux-session-actions.js'

const API_ROOT = '/api/session-management'
const MAX_REQUEST_BYTES = 64 * 1024

type SessionManagementDependencies = {
  preferences?: SessionPreferenceStore
  actions?: TmuxSessionActions
  currentSessions: () => readonly { id: string; name: string }[]
  currentWindowIds: () => readonly string[]
  beforeWindowDeleted?: (windowId: string) => void | Promise<void>
  onSessionsChanged?: () => void | Promise<void>
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

async function readJson(request: IncomingMessage): Promise<unknown> {
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

  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  } catch {
    throw new HttpError(400, 'Request body is not valid JSON')
  }
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new HttpError(400, 'Request body must be a JSON object')
  }
  return value as Record<string, unknown>
}

function sessionRoute(pathname: string): { sessionId: string; action: 'rename' | 'delete' } | null {
  const match = /^\/api\/session-management\/sessions\/([^/]+)\/(rename|delete)$/.exec(pathname)
  if (!match) return null
  try {
    return {
      sessionId: validateTmuxSessionId(decodeURIComponent(match[1])),
      action: match[2] as 'rename' | 'delete',
    }
  } catch {
    throw new HttpError(400, 'Invalid tmux session id')
  }
}

function windowDeleteRoute(pathname: string): string | null {
  const match = /^\/api\/session-management\/windows\/([^/]+)\/delete$/.exec(pathname)
  if (!match) return null
  try {
    return validateTmuxWindowId(decodeURIComponent(match[1]))
  } catch {
    throw new HttpError(400, 'Invalid tmux window id')
  }
}

export function isSessionManagementPath(pathname: string): boolean {
  return pathname === API_ROOT || pathname.startsWith(`${API_ROOT}/`)
}

export class SessionManagementApi {
  private readonly preferences: SessionPreferenceStore
  private readonly actions: TmuxSessionActions

  constructor(private readonly dependencies: SessionManagementDependencies) {
    this.preferences = dependencies.preferences ?? new SessionPreferenceStore()
    this.actions = dependencies.actions ?? new TmuxSessionActions()
  }

  /**
   * Handles only /api/session-management routes. The caller must enforce Commando's
   * host, origin, and bearer-token checks before invoking this method.
   */
  async handle(request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean> {
    if (!isSessionManagementPath(url.pathname)) return false

    try {
      if (url.pathname === `${API_ROOT}/preferences`) {
        await this.handlePreferences(request, response)
        return true
      }

      const route = sessionRoute(url.pathname)
      if (route) {
        if (!this.dependencies.currentSessions().some((session) => session.id === route.sessionId)) {
          throw new HttpError(404, 'Tmux session does not exist')
        }

        if (route.action === 'rename') {
          if (request.method !== 'POST') throw new HttpError(405, 'Method not allowed')
          const body = record(await readJson(request))
          let name: string
          try {
            name = validateTmuxSessionName(body.name)
          } catch (error) {
            throw new HttpError(400, error instanceof Error ? error.message : 'Invalid session name')
          }
          await this.actions.rename(route.sessionId, name)
          await this.dependencies.onSessionsChanged?.()
          writeJson(response, 200, { ok: true, sessionId: route.sessionId, name })
          return true
        }

        if (request.method !== 'DELETE') throw new HttpError(405, 'Method not allowed')
        const body = record(await readJson(request))
        if (body.confirmSessionId !== route.sessionId) {
          throw new HttpError(400, 'Deletion requires an exact confirmSessionId')
        }
        await this.actions.delete(route.sessionId)
        await this.dependencies.onSessionsChanged?.()
        writeJson(response, 200, { ok: true, sessionId: route.sessionId })
        return true
      }

      const windowId = windowDeleteRoute(url.pathname)
      if (!windowId) throw new HttpError(404, 'Not found')
      if (!this.dependencies.currentWindowIds().includes(windowId)) {
        throw new HttpError(404, 'Tmux window does not exist')
      }
      if (request.method !== 'DELETE') throw new HttpError(405, 'Method not allowed')
      const body = record(await readJson(request))
      if (body.confirmWindowId !== windowId) {
        throw new HttpError(400, 'Deletion requires an exact confirmWindowId')
      }
      await this.dependencies.beforeWindowDeleted?.(windowId)
      await this.actions.deleteWindow(windowId)
      await this.dependencies.onSessionsChanged?.()
      writeJson(response, 200, { ok: true, windowId })
      return true
    } catch (error) {
      if (error instanceof HttpError) {
        if (error.status === 405) response.setHeader('Allow', this.allowedMethods(url.pathname))
        writeJson(response, error.status, { error: error.message })
        return true
      }
      writeJson(response, 502, {
        error: error instanceof Error ? error.message : 'Session management action failed',
      })
      return true
    }
  }

  private async handlePreferences(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const currentSessions = this.dependencies.currentSessions()
    if (request.method === 'GET') {
      const preferences = await this.preferences.load(currentSessions)
      writeJson(response, 200, { preferences })
      return
    }
    if (request.method !== 'PUT') throw new HttpError(405, 'Method not allowed')

    const body = record(await readJson(request))
    const parsed = parseSessionTreePreferences(body.preferences)
    if (!parsed) throw new HttpError(400, 'Invalid session tree preferences')
    const preferences = await this.preferences.replace(parsed, currentSessions)
    writeJson(response, 200, { preferences })
  }

  private allowedMethods(pathname: string): string {
    if (pathname === `${API_ROOT}/preferences`) return 'GET, PUT'
    if (pathname.endsWith('/rename')) return 'POST'
    if (pathname.endsWith('/delete')) return 'DELETE'
    return 'GET'
  }
}

export type { SessionTreePreferences }
