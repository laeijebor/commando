import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  TmuxPaneActions,
  validateTmuxPaneId,
  validateTmuxPaneTitle,
} from './tmux-pane-actions.js'
import { openFolderInFinder, revealInFinder } from './open-folder.js'
import type { PaneScreenshotRegistry } from './pane-screenshots.js'
import { runCommand, validateRunCommand } from './run-command.js'
import { validatePaneMarkInput, type PaneMarkInput } from './pane-marks.js'
import type { PaneMark } from '../shared/protocol.js'

const API_ROOT = '/api/pane-management'
const MAX_REQUEST_BYTES = 16 * 1024

type PaneManagementDependencies = {
  actions?: TmuxPaneActions
  currentPaneIds: () => readonly string[]
  panePath: (paneId: string) => string | undefined
  paneTargetId?: (paneId: string) => string | undefined
  setPaneMark?: (targetId: string, input: PaneMarkInput) => Promise<PaneMark>
  acknowledgePaneMark?: (targetId: string) => Promise<PaneMark | null>
  clearPaneMark?: (targetId: string) => Promise<boolean>
  onPaneMarkChanged?: (change: { type: 'upsert'; mark: PaneMark } | { type: 'remove'; targetId: string }) => void
  openFolder?: (path: string) => Promise<void>
  revealFile?: (path: string) => Promise<void>
  screenshots?: PaneScreenshotRegistry
  runCommand?: (command: string, cwd: string) => Promise<void>
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

type PaneAction = 'rename' | 'delete' | 'open' | 'reveal' | 'run' | 'mark' | 'acknowledge-mark'

function paneRoute(pathname: string): { paneId: string; action: PaneAction } | null {
  const match = /^\/api\/pane-management\/panes\/([^/]+)\/(rename|delete|open|reveal|run|mark)(?:\/(acknowledge))?$/.exec(pathname)
  if (!match) return null
  try {
    return {
      paneId: validateTmuxPaneId(decodeURIComponent(match[1])),
      action: match[2] === 'mark' && match[3] === 'acknowledge'
        ? 'acknowledge-mark'
        : match[2] as PaneAction,
    }
  } catch {
    throw new HttpError(400, 'Invalid tmux pane id')
  }
}

export class PaneManagementApi {
  private readonly actions: TmuxPaneActions
  private readonly openFolder: (path: string) => Promise<void>
  private readonly runCommand: (command: string, cwd: string) => Promise<void>
  private readonly revealFile: (path: string) => Promise<void>

  constructor(private readonly dependencies: PaneManagementDependencies) {
    this.actions = dependencies.actions ?? new TmuxPaneActions()
    this.openFolder = dependencies.openFolder ?? openFolderInFinder
    this.revealFile = dependencies.revealFile ?? revealInFinder
    this.runCommand = dependencies.runCommand ?? runCommand
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

      if (route.action === 'open') {
        if (request.method !== 'POST') throw new HttpError(405, 'Method not allowed')
        const path = this.dependencies.panePath(route.paneId)
        if (!path) throw new HttpError(404, 'Pane path is unavailable')
        await this.openFolder(path)
        writeJson(response, 200, { ok: true, paneId: route.paneId })
        return true
      }

      if (route.action === 'reveal') {
        if (request.method !== 'POST') throw new HttpError(405, 'Method not allowed')
        const body = await readJson(request)
        if (typeof body.folderId !== 'string' || !/^[0-9a-f]{16}$/.test(body.folderId)) {
          throw new HttpError(400, 'folderId is invalid')
        }
        if (body.file !== undefined && (typeof body.file !== 'string' || body.file.length === 0)) {
          throw new HttpError(400, 'file is invalid')
        }
        if (!this.dependencies.screenshots?.isRegisteredForPane(route.paneId, body.folderId)) {
          throw new HttpError(404, 'Screenshot folder is not registered for this pane')
        }
        const path = await this.dependencies.screenshots.resolveForPane(route.paneId, body.folderId, body.file as string | undefined)
        if (!path) throw new HttpError(400, body.file === undefined ? 'Screenshot folder is unavailable' : 'Screenshot file is invalid')
        if (body.file === undefined) await this.openFolder(path)
        else await this.revealFile(path)
        writeJson(response, 200, { ok: true, paneId: route.paneId })
        return true
      }

      if (route.action === 'run') {
        if (request.method !== 'POST') throw new HttpError(405, 'Method not allowed')
        const body = await readJson(request)
        let command: string
        try {
          command = validateRunCommand(body.command)
        } catch (error) {
          throw new HttpError(400, error instanceof Error ? error.message : 'Invalid command')
        }
        const path = this.dependencies.panePath(route.paneId)
        if (!path) throw new HttpError(404, 'Pane path is unavailable')
        await this.runCommand(command, path)
        writeJson(response, 202, { ok: true, paneId: route.paneId })
        return true
      }

      if (route.action === 'mark' || route.action === 'acknowledge-mark') {
        const targetId = this.dependencies.paneTargetId?.(route.paneId)
        if (!targetId) throw new HttpError(404, 'Pane target is unavailable')
        if (route.action === 'acknowledge-mark') {
          if (request.method !== 'POST') throw new HttpError(405, 'Method not allowed')
          const body = await readJson(request)
          if (body.targetId !== targetId) throw new HttpError(409, 'Pane target changed')
          if (!this.dependencies.acknowledgePaneMark) throw new Error('Pane mark store is unavailable')
          const mark = await this.dependencies.acknowledgePaneMark(targetId)
          if (!mark) throw new HttpError(404, 'Pane is not marked')
          this.dependencies.onPaneMarkChanged?.({ type: 'upsert', mark })
          writeJson(response, 200, { ok: true, paneId: route.paneId, mark })
          return true
        }
        if (request.method === 'DELETE') {
          const body = await readJson(request)
          if (body.targetId !== targetId) throw new HttpError(409, 'Pane target changed')
          if (!this.dependencies.clearPaneMark) throw new Error('Pane mark store is unavailable')
          const removed = await this.dependencies.clearPaneMark(targetId)
          if (removed) this.dependencies.onPaneMarkChanged?.({ type: 'remove', targetId })
          writeJson(response, 200, { ok: true, paneId: route.paneId, removed })
          return true
        }
        if (request.method !== 'POST') throw new HttpError(405, 'Method not allowed')
        let input: PaneMarkInput
        try {
          const body = await readJson(request)
          if (body.targetId !== targetId) throw new HttpError(409, 'Pane target changed')
          input = validatePaneMarkInput(body)
        } catch (error) {
          if (error instanceof HttpError) throw error
          throw new HttpError(400, error instanceof Error ? error.message : 'Invalid pane mark')
        }
        if (!this.dependencies.setPaneMark) throw new Error('Pane mark store is unavailable')
        const mark = await this.dependencies.setPaneMark(targetId, input)
        this.dependencies.onPaneMarkChanged?.({ type: 'upsert', mark })
        writeJson(response, 200, { ok: true, paneId: route.paneId, mark })
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
          response.setHeader('Allow', url.pathname.endsWith('/delete') ? 'DELETE' : url.pathname.endsWith('/mark') ? 'POST, DELETE' : 'POST')
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
