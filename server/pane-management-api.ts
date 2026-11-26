import { createHash, randomBytes } from 'node:crypto'
import { copyFile, lstat, mkdir, readFile, readdir, realpath, rename, rm, stat } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, extname, relative, isAbsolute, join, sep } from 'node:path'
import { REDLINE_ARTIFACT_TTL_MS, type RedlineArtifactRegistry } from './redline-artifacts.js'
import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  TmuxPaneActions,
  validateTmuxPaneId,
  validateTmuxPaneTitle,
} from './tmux-pane-actions.js'
import { openFolderInFinder, revealInFinder, openResource, openResourceInEditor, validResourcePath, type FolderOpenExecutor } from './open-folder.js'
import type { PaneScreenshotRegistry } from './pane-screenshots.js'
import { runCommand, validateRunCommand } from './run-command.js'
import { validatePaneMarkInput, type PaneMarkInput } from './pane-marks.js'
import type { PaneMark } from '../shared/protocol.js'
import { isDeckPath, parseDeck } from '../shared/deck.js'

const API_ROOT = '/api/pane-management'
const MAX_REQUEST_BYTES = 16 * 1024
const MAX_DECK_BYTES = 2 * 1024 * 1024
const DECK_SNAPSHOT_LIMITS = { files: 2000, bytes: 100 * 1024 * 1024 }
/** Hidden folders a deck may live in and still be served directly. */
const SERVABLE_DOT_FOLDERS = new Set(['.slides', '.redline', '.canvas', '.pr'])

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
  resourceExecutor?: FolderOpenExecutor
  platform?: NodeJS.Platform
  resourceHome?: string
  resourceTempRoots?: readonly string[]
  resourceTileRoot?: string
  /** Most a deck snapshot copies before Present falls back to Open. */
  deckSnapshotLimits?: { files: number; bytes: number }
  resourceNow?: () => number
  artifacts?: Pick<RedlineArtifactRegistry, 'register' | 'hasDirectory'>
  /** Opens a tile beside the pane; `content` makes it a canvas, as slides decks are. */
  openResourceTile?: (paneId: string, url: string, content?: { kind: 'canvas'; artifactId: string; manifest: string }) => string
  screenshots?: PaneScreenshotRegistry
  runCommand?: (command: string, cwd: string) => Promise<void>
  beforePaneDeleted?: (paneId: string) => void | Promise<void>
  onPanesChanged?: () => void | Promise<void>
  /** When each pane was last viewed, and which are on a screen now. */
  paneViews?: () => PaneViewsSnapshot
}

type ViewTimes = { viewedAt: Record<string, number>; viewing: string[] }
/** When each tmux pane and each tile was last on a screen, and which are on one now. */
export type PaneViewsSnapshot = ViewTimes & { tiles?: ViewTimes }

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

function containsPath(root: string, path: string): boolean {
  const fromRoot = relative(root, path)
  return fromRoot === '' || (!isAbsolute(fromRoot) && fromRoot !== '..' && !fromRoot.startsWith(`..${sep}`))
}

type PaneAction = 'resource' | 'rename' | 'delete' | 'open' | 'reveal' | 'run' | 'shell' | 'mark' | 'acknowledge-mark' | 'capture'

function paneRoute(pathname: string): { paneId: string; action: PaneAction } | null {
  const match = /^\/api\/pane-management\/panes\/([^/]+)\/(rename|delete|open|reveal|run|shell|mark|capture|resource)(?:\/(acknowledge))?$/.exec(pathname)
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
  private lastResourcePruneAt: number | undefined
  private resourcePruning: Promise<void> | undefined
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

  private async pruneResourceSnapshots(root: string): Promise<void> {
    if (this.resourcePruning) return this.resourcePruning
    const now = (this.dependencies.resourceNow ?? Date.now)()
    if (this.lastResourcePruneAt !== undefined && now - this.lastResourcePruneAt < 60 * 60 * 1000) return
    this.lastResourcePruneAt = now
    const prune = async () => {
      let entries
      try { entries = await readdir(root, { withFileTypes: true }) } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
        throw error
      }
      for (const entry of entries) {
        if (!entry.isDirectory() || !/^[a-f0-9]{16}$/.test(entry.name)) continue
        const path = join(root, entry.name)
        try {
          if ((await stat(path)).mtimeMs >= now - REDLINE_ARTIFACT_TTL_MS) continue
          if (this.dependencies.artifacts?.hasDirectory(await realpath(path))) continue
          await rm(path, { recursive: true, force: true })
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
      }
    }
    this.resourcePruning = prune()
    try { await this.resourcePruning } finally { this.resourcePruning = undefined }
  }

  private async resource(paneId: string, body: Record<string, unknown>) {
    if (!validResourcePath(body.path)) throw new HttpError(400, 'path must be absolute, at most 4096 bytes, and contain no control characters')
    if (!['open', 'reveal', 'editor', 'tile', 'slides'].includes(body.action as string)) throw new HttpError(400, 'Invalid resource action')
    if (body.line !== undefined && (typeof body.line !== 'number' || !Number.isSafeInteger(body.line) || body.line < 1)) throw new HttpError(400, 'line must be a positive integer')
    const platform = this.dependencies.platform ?? process.platform
    if (platform !== 'darwin') throw new HttpError(501, 'Resource actions are only available on macOS')
    let path: string
    try { path = await realpath(body.path) } catch { throw new HttpError(404, 'Resource does not exist') }
    const roots = [this.dependencies.resourceHome ?? homedir(), this.dependencies.panePath(paneId),
      ...(this.dependencies.resourceTempRoots ?? [tmpdir(), '/private/tmp', '/tmp'])].filter((root): root is string => Boolean(root))
    const allowed = await Promise.all(roots.map(async (root) => {
      try {
        const rel = relative(await realpath(root), path)
        return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
      } catch { return false }
    }))
    if (!allowed.some(Boolean)) throw new HttpError(403, 'Resource is outside the home, pane, and temporary directories')
    const stats = await stat(path)
    if (!stats.isFile() && !stats.isDirectory()) throw new HttpError(400, 'Resource must be a file or folder')
    const execute = this.dependencies.resourceExecutor
    if (body.action === 'reveal') await revealInFinder(path, execute, platform)
    if (body.action === 'open') return { ok: true, performed: await openResource(path, execute, platform) }
    if (body.action === 'editor') {
      if (!stats.isFile()) throw new HttpError(400, 'Only files can be opened in an editor')
      await openResourceInEditor(path, body.line as number | undefined, execute, platform)
    }
    if (body.action === 'slides') return this.presentSlides(paneId, path, stats.isDirectory(), execute, platform)
    if (body.action === 'tile') {
      if (!stats.isFile() || !/\.(?:html?|svg|png|jpe?g|gif|webp|pdf)$/i.test(extname(path))) throw new HttpError(400, 'This resource cannot be opened as a tile')
      const parent = await realpath(dirname(path))
      const home = await realpath(this.dependencies.resourceHome ?? homedir()).catch(() => undefined)
      const broadDirectories = [home, home ? dirname(home) : undefined, '/', '/Users', '/Volumes',
        tmpdir(), '/tmp', '/private/tmp', ...(this.dependencies.resourceTempRoots ?? [])]
      const broadRealpaths = await Promise.all(broadDirectories.map(async (directory) =>
        directory ? realpath(directory).catch(() => undefined) : undefined))
      if (broadRealpaths.includes(parent)) return { ok: true, performed: await openResource(path, execute, platform) }
      const root = this.dependencies.resourceTileRoot ?? join(this.dependencies.resourceHome ?? homedir(), '.commando', 'resource-tiles')
      const statePath = join(this.dependencies.resourceHome ?? homedir(), '.commando')
      const stateDirectory = await realpath(statePath).catch(() => home ? join(home, '.commando') : statePath)
      let directory = parent
      let snapshotDirectory: string | undefined
      const html = /\.html?$/i.test(path)
      if (html) {
        const artifactFolders = new Set(['.redline', '.canvas', '.pr'])
        while (!artifactFolders.has(basename(directory))) {
          const ancestor = dirname(directory)
          if (ancestor === directory) return { ok: true, performed: await openResource(path, execute, platform) }
          directory = ancestor
        }
        directory = await realpath(directory)
        const paneCwd = this.dependencies.panePath(paneId)
        const cwd = paneCwd ? await realpath(paneCwd).catch(() => undefined) : undefined
        if (!cwd || !containsPath(cwd, directory) || containsPath(stateDirectory, directory) || broadRealpaths.includes(directory)) {
          return { ok: true, performed: await openResource(path, execute, platform) }
        }
      }
      if (!this.dependencies.artifacts || !this.dependencies.openResourceTile) throw new HttpError(503, 'Resource tiles are unavailable')
      await this.pruneResourceSnapshots(root)
      if (!html) {
        const key = createHash('sha256').update(path).digest('hex').slice(0, 16)
        directory = join(root, key)
        await mkdir(root, { recursive: true, mode: 0o700 })
        await mkdir(directory, { recursive: true, mode: 0o700 })
        snapshotDirectory = join(await realpath(root), key)
        directory = await realpath(directory)
        if (directory !== snapshotDirectory) return { ok: true, performed: await openResource(path, execute, platform) }
        const temporary = join(directory, `.${basename(path)}.${randomBytes(8).toString('hex')}.tmp`)
        try {
          await copyFile(path, temporary)
          await rename(temporary, join(directory, basename(path)))
        } finally { await rm(temporary, { force: true }) }
      }
      // Only a per-file directory under the snapshot root may expose any daemon state path.
      if (containsPath(stateDirectory, directory) && (html || directory !== snapshotDirectory)) {
        return { ok: true, performed: await openResource(path, execute, platform) }
      }
      const { id } = this.dependencies.artifacts.register(directory)
      const file = html ? relative(directory, path).split(sep).map(encodeURIComponent).join('/') : encodeURIComponent(basename(path))
      const url = `/redline/artifacts/${id}/${file}`
      try {
        const webPaneId = this.dependencies.openResourceTile(paneId, url)
        return { ok: true, performed: 'tile', webPaneId }
      } catch (error) {
        const status = (error as { status?: number }).status
        if (status && status >= 400 && status <= 599) throw new HttpError(status, error instanceof Error ? error.message : 'Unable to open resource tile')
        throw error
      }
    }
    return { ok: true, performed: body.action }
  }

  /**
   * Opens a slides deck as a canvas tile, as `scripts/commando-slides` does. `path` is a real path inside an allowed root.
   * The tile is served from an unauthenticated artifact URL, so it always serves a copy without hidden files or
   * `node_modules`, refreshed on each Present: a file added to the deck folder later never becomes reachable.
   * Hidden folders such as `~/.ssh` (which keep secrets in ordinary files) are refused.
   */
  private async presentSlides(paneId: string, path: string, directory: boolean, execute: FolderOpenExecutor | undefined, platform: NodeJS.Platform) {
    const folder = directory ? path : dirname(path)
    const manifest = directory ? 'deck.html' : basename(path)
    const notDeck = new HttpError(400, 'Only a slides deck can be presented')
    // The slides tile reads only lowercase .html pages as decks (`isDeckPath`).
    if (!isDeckPath(manifest) || manifest.startsWith('.')) throw notDeck
    let text: string
    try {
      if (!(await stat(join(folder, 'deck.html'))).isFile()) throw notDeck
      const page = await stat(join(folder, manifest))
      if (!page.isFile() || page.size > MAX_DECK_BYTES) throw notDeck
      text = await readFile(join(folder, manifest), 'utf8')
    } catch { throw notDeck }
    if (!parseDeck(text, manifest).deck.slides.length) throw notDeck
    const home = await realpath(this.dependencies.resourceHome ?? homedir()).catch(() => undefined)
    const broad = await Promise.all([home, home ? dirname(home) : undefined, '/', '/Users', '/Volumes', tmpdir(), '/tmp', '/private/tmp',
      ...(this.dependencies.resourceTempRoots ?? [])].map((entry) => entry ? realpath(entry).catch(() => undefined) : undefined))
    const statePath = join(this.dependencies.resourceHome ?? homedir(), '.commando')
    const state = await realpath(statePath).catch(() => home ? join(home, '.commando') : statePath)
    // Agent worktrees (`<repo>/.claude/worktrees/…`, `~/.codex/worktrees/…`) are ordinary checkouts, judged like any other.
    const segments = folder.split(sep)
    const hidden = segments.some((segment, index) => segment.startsWith('.') && !SERVABLE_DOT_FOLDERS.has(segment) && segments[index + 1] !== 'worktrees')
    if (broad.includes(folder) || containsPath(state, folder) || containsPath(folder, state) || hidden) throw new HttpError(403, 'This folder cannot be presented')
    if (!this.dependencies.artifacts || !this.dependencies.openResourceTile) throw new HttpError(503, 'Slides tiles are unavailable')
    const root = this.dependencies.resourceTileRoot ?? join(this.dependencies.resourceHome ?? homedir(), '.commando', 'resource-tiles')
    await this.pruneResourceSnapshots(root)
    const snapshot = await this.snapshotDeck(folder, root)
    if (!snapshot) return { ok: true, performed: await openResource(path, execute, platform) }
    const { id } = this.dependencies.artifacts.register(snapshot)
    try {
      const webPaneId = this.dependencies.openResourceTile(paneId, `/redline/artifacts/${id}/`, { kind: 'canvas', artifactId: id, manifest })
      return { ok: true, performed: 'slides', webPaneId }
    } catch (error) {
      const status = (error as { status?: number }).status
      if (status && status >= 400 && status <= 599) throw new HttpError(status, error instanceof Error ? error.message : 'Unable to open the slides')
      throw error
    }
  }

  /**
   * Copies a deck, without hidden entries, `node_modules` or symlinks, into a private per-deck folder under the
   * snapshot root, replacing an earlier copy. Undefined when the deck is too large to copy.
   */
  private async snapshotDeck(folder: string, root: string): Promise<string | undefined> {
    const limits = this.dependencies.deckSnapshotLimits ?? DECK_SNAPSHOT_LIMITS
    const key = createHash('sha256').update(`deck:${folder}`).digest('hex').slice(0, 16)
    await mkdir(root, { recursive: true, mode: 0o700 })
    const realRoot = await realpath(root)
    const target = join(realRoot, key)
    const temporary = join(realRoot, `.${key}.${randomBytes(8).toString('hex')}.tmp`)
    let files = 0, bytes = 0
    const copy = async (from: string, to: string): Promise<boolean> => {
      await mkdir(to, { mode: 0o700 })
      for (const entry of await readdir(from, { withFileTypes: true })) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
        const source = join(from, entry.name)
        if (entry.isDirectory()) {
          if (!(await copy(source, join(to, entry.name)))) return false
        } else if (entry.isFile()) {
          bytes += (await lstat(source)).size
          if (++files > limits.files || bytes > limits.bytes) return false
          await copyFile(source, join(to, entry.name))
        }
      }
      return true
    }
    try {
      if (!(await copy(folder, temporary))) return undefined
      const previous = `${temporary}.old`
      await rename(target, previous).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error })
      await rename(temporary, target)
      await rm(previous, { recursive: true, force: true })
      return target
    } finally {
      await rm(temporary, { recursive: true, force: true })
    }
  }

  async handle(request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean> {
    if (url.pathname !== API_ROOT && !url.pathname.startsWith(`${API_ROOT}/`)) return false

    try {
      if (url.pathname === `${API_ROOT}/views`) {
        if (request.method !== 'GET') throw new HttpError(405, 'Method not allowed')
        writeJson(response, 200, this.dependencies.paneViews?.() ?? { viewedAt: {}, viewing: [] })
        return true
      }
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

      if (route.action === 'capture') {
        if (request.method !== 'GET') throw new HttpError(405, 'Method not allowed')
        const text = await this.actions.capture(route.paneId)
        writeJson(response, 200, { paneId: route.paneId, text })
        return true
      }

      if (route.action === 'resource') {
        if (request.method !== 'POST') throw new HttpError(405, 'Method not allowed')
        const result = await this.resource(route.paneId, await readJson(request))
        writeJson(response, 200, result)
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

      if (route.action === 'shell') {
        if (request.method !== 'POST') throw new HttpError(405, 'Method not allowed')
        const shellPaneId = await this.actions.ensureShell(route.paneId, this.dependencies.panePath(route.paneId))
        await this.dependencies.onPanesChanged?.()
        writeJson(response, 200, { ok: true, paneId: route.paneId, shellPaneId })
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
      const outcome = await this.actions.delete(route.paneId, this.dependencies.panePath(route.paneId))
      // An emptied pane keeps its id, so its Terminal-tab shell would otherwise outlive the close.
      await this.actions.closeShell(route.paneId).catch(() => undefined)
      await this.dependencies.onPanesChanged?.()
      writeJson(response, 200, { ok: true, paneId: route.paneId, ...(outcome === 'emptied' ? { emptied: true } : {}) })
      return true
    } catch (error) {
      if (error instanceof HttpError) {
        if (error.status === 405) {
          response.setHeader('Allow', url.pathname.endsWith('/delete') ? 'DELETE' : url.pathname.endsWith('/mark') ? 'POST, DELETE' : /\/(capture|views)$/.test(url.pathname) ? 'GET' : 'POST')
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
