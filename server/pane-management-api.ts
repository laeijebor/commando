import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  TmuxPaneActions,
  validateTmuxPaneId,
  validateTmuxPaneTitle,
} from './tmux-pane-actions.js'

const API_ROOT = '/api/pane-management'
const MAX_REQUEST_BYTES = 16 * 1024

type PaneManagementDependencies = {
  actions?: TmuxPaneActions
  currentPaneIds: () => readonly string[]
  beforePaneDeleted?: (paneId: string) => void | Promise<void>
  onPanesChanged?: () => void | Promise<void>
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

function paneRoute(pathname: string): { paneId: string; action: 'rename' | 'delete' } | null {
  const match = /^\/api\/pane-management\/panes\/([^/]+)\/(rename|delete)$/.exec(pathname)
  if (!match) return null
  try {
    return {
      paneId: validateTmuxPaneId(decodeURIComponent(match[1])),
      action: match[2] as 'rename' | 'delete',
    }
  } catch {
    throw new HttpError(400, 'Invalid tmux pane id')
  }
}

export class PaneManagementApi {
  private readonly actions: TmuxPaneActions

  constructor(private readonly dependencies: PaneManagementDependencies) {
    this.actions = dependencies.actions ?? new TmuxPaneActions()
  }

  async handle(request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean> {
    if (url.pathname !== API_ROOT && !url.pathname.startsWith(`${API_ROOT}/`)) return false

    try {
      const route = paneRoute(url.pathname)
      if (!route) throw new HttpError(404, 'Not found')
      if (!this.dependencies.currentPaneIds().includes(route.paneId)) {
        throw new HttpError(404, 'Tmux pane does not exist')
      }

      if (route.action === 'rename') {
        if (request.method !== 'POST') throw new HttpError(405, 'Method not allowed')
        const body = await readJson(request)
        let title: string
        try {
          title = validateTmuxPaneTitle(body.title)
        } catch (error) {
          throw new HttpError(400, error instanceof Error ? error.message : 'Invalid pane title')
        }
        await this.actions.rename(route.paneId, title)
        await this.dependencies.onPanesChanged?.()
        writeJson(response, 200, { ok: true, paneId: route.paneId, title })
        return true
      }

      if (request.method !== 'DELETE') throw new HttpError(405, 'Method not allowed')
      const body = await readJson(request)
      if (body.confirmPaneId !== route.paneId) {
        throw new HttpError(400, 'Deletion requires an exact confirmPaneId')
      }
      await this.dependencies.beforePaneDeleted?.(route.paneId)
      await this.actions.delete(route.paneId)
      await this.dependencies.onPanesChanged?.()
      writeJson(response, 200, { ok: true, paneId: route.paneId })
      return true
    } catch (error) {
      if (error instanceof HttpError) {
        if (error.status === 405) {
          response.setHeader('Allow', url.pathname.endsWith('/rename') ? 'POST' : 'DELETE')
        }
        writeJson(response, error.status, { error: error.message })
        return true
      }
      writeJson(response, 502, {
        error: error instanceof Error ? error.message : 'Pane management action failed',
      })
      return true
    }
  }
}
