import { isSessionName, isSessionGlyph, MAX_SESSION_IDENTITIES } from '../shared/session-identity.js'
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
import { SessionWorktreeConflictError } from './session-worktree-deletion.js'
import type { SessionWorktreeDeletionPlan } from './session-worktree-deletion.js'
import { SessionArchives, type ArchivedRepo, type ArchiveSummary, type SessionArchive } from './session-archives.js'
import type { GitWorktreeIdentity } from './git-worktree.js'
import { TrackedProcessScopeError, type ProcessSelection, type ProcessTracker } from './tracked-processes.js'
import { parseProcessKeys } from './tracked-processes-api.js'

const API_ROOT = '/api/session-management'
const MAX_REQUEST_BYTES = 64 * 1024

type SessionManagementDependencies = {
  preferences?: SessionPreferenceStore
  actions?: TmuxSessionActions
  archives?: SessionArchives
  currentSessions: () => readonly { id: string; name: string }[]
  /** The tmux server the current sessions belong to; null before tmux is discovered. */
  currentServerId?: () => string | null
  currentWindowIds: () => readonly string[]
  prepareSessionWorktreeDeletion?: (sessionId: string) => Promise<SessionWorktreeDeletionPlan>
  /** Plans removing the worktree a paused session's saved directories are in. */
  prepareDirectoriesWorktreeDeletion?: (directories: readonly string[]) => Promise<SessionWorktreeDeletionPlan>
  /** Commits uncommitted work before an archive removes the worktree; returns the identity with its new head. */
  commitWorkInProgress?: (worktree: GitWorktreeIdentity, message: string) => Promise<GitWorktreeIdentity>
  /** The repository a live session belongs to, kept with a paused session for repository grouping. */
  sessionRepo?: (sessionId: string) => ArchivedRepo | undefined
  /** Processes started from the session's panes; the ones the user chose stop after it closes. */
  trackedProcesses?: Pick<ProcessTracker, 'select' | 'stopSelection'>
  afterSessionDeleted?: (sessionId: string) => void
  afterSessionRestored?: (sessionId: string) => void
  afterSessionRenamed?: (sessionId: string, previousName: string, name: string) => void | Promise<void>
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

type SessionAction = 'rename' | 'delete' | 'delete-preview' | 'archive' | 'pause' | 'identity'

function sessionRoute(pathname: string): { sessionId: string; action: SessionAction } | null {
  const match = /^\/api\/session-management\/sessions\/([^/]+)\/(rename|delete|delete-preview|archive|pause|identity)$/.exec(pathname)
  if (!match) return null
  try {
    return {
      sessionId: validateTmuxSessionId(decodeURIComponent(match[1])),
      action: match[2] as SessionAction,
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
  private readonly archives: SessionArchives

  constructor(private readonly dependencies: SessionManagementDependencies) {
    this.preferences = dependencies.preferences ?? new SessionPreferenceStore()
    this.actions = dependencies.actions ?? new TmuxSessionActions()
    this.archives = dependencies.archives ?? new SessionArchives()
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

      if (url.pathname === `${API_ROOT}/archives`) {
        if (request.method !== 'GET') throw new HttpError(405, 'Method not allowed')
        writeJson(response, 200, { archives: await this.archives.list() })
        return true
      }
      const archiveRoute = /^\/api\/session-management\/archives\/([^/]+)\/(restore|archive)$/.exec(url.pathname)
      if (archiveRoute) {
        if (request.method !== 'POST') throw new HttpError(405, 'Method not allowed')
        const id = decodeURIComponent(archiveRoute[1])
        const archive = (await this.archives.list()).find((item) => item.id === id)
        if (!archive) throw new HttpError(404, 'Session archive does not exist')
        if (archiveRoute[2] === 'archive') {
          if (!archive.paused) throw new HttpError(409, 'Session is already archived')
          const full = await this.archives.get(id)
          const directories = full.windows.flatMap((window) => window.panes.map((pane) => pane.path))
          const result = await this.removeArchivedWorktree(archive, () => this.planWorktreeRemoval(() => {
            if (!this.dependencies.prepareDirectoriesWorktreeDeletion) throw new HttpError(501, 'Worktree removal is not available')
            return this.dependencies.prepareDirectoriesWorktreeDeletion(directories)
          }))
          await this.dependencies.onSessionsChanged?.()
          writeJson(response, 200, { ok: true, ...result })
          return true
        }
        if (this.dependencies.currentSessions().some((session) => session.name === archive.name)) {
          throw new HttpError(409, `A tmux session named “${archive.name}” already exists`)
        }
        const sessionId = await this.archives.restore(id)
        this.dependencies.afterSessionRestored?.(sessionId)
        await this.dependencies.onSessionsChanged?.()
        writeJson(response, 200, { ok: true, sessionId })
        return true
      }

      if (url.pathname === `${API_ROOT}/identities`) {
        if (request.method !== 'POST') throw new HttpError(405, 'Method not allowed')
        const body = record(await readJson(request))
        if (!Array.isArray(body.names) || body.names.length > MAX_SESSION_IDENTITIES || !body.names.every(isSessionName)) {
          throw new HttpError(400, 'Expected up to 500 session names')
        }
        const preferences = await this.preferences.ensureIdentities(body.names, this.dependencies.currentSessions(), this.dependencies.currentServerId?.())
        writeJson(response, 200, { preferences })
        return true
      }

      const route = sessionRoute(url.pathname)
      if (route) {
        if (!this.dependencies.currentSessions().some((session) => session.id === route.sessionId)) {
          throw new HttpError(404, 'Tmux session does not exist')
        }

        if (route.action === 'identity') {
          if (request.method !== 'POST') throw new HttpError(405, 'Method not allowed')
          const body = record(await readJson(request))
          if (body.reset !== true && !isSessionGlyph(body.glyph)) throw new HttpError(400, 'Glyph must be a single emoji')
          const session = this.dependencies.currentSessions().find((entry) => entry.id === route.sessionId)!
          const preferences = await this.preferences.changeIdentity(session.name, body.reset === true ? null : body.glyph as string, this.dependencies.currentSessions(), this.dependencies.currentServerId?.())
          writeJson(response, 200, { preferences })
          return true
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
          const previousName = this.dependencies.currentSessions().find((session) => session.id === route.sessionId)!.name
          await this.actions.rename(route.sessionId, name)
          // Tmux has already renamed the session; persistence failures must not hide that success.
          try {
            await this.preferences.renameIdentity(previousName, name, route.sessionId, this.dependencies.currentServerId?.())
          } catch (error) {
            console.warn('[commando] Session identity move failed after session rename', error)
          }
          try {
            await this.dependencies.afterSessionRenamed?.(route.sessionId, previousName, name)
          } catch (error) {
            console.warn('[commando] Session brief update failed after session rename', error)
          }
          await this.dependencies.onSessionsChanged?.()
          writeJson(response, 200, { ok: true, sessionId: route.sessionId, name })
          return true
        }

        if (route.action === 'archive' || route.action === 'pause') {
          if (request.method !== 'POST') throw new HttpError(405, 'Method not allowed')
          const paused = route.action === 'pause'
          const body = record(await readJson(request))
          if (body.confirmSessionId !== route.sessionId) throw new HttpError(400, `${paused ? 'Pausing' : 'Archiving'} requires an exact confirmSessionId`)
          const toStop = await this.processesToStop(route.sessionId, body.stopProcessKeys)
          const name = this.dependencies.currentSessions().find((session) => session.id === route.sessionId)!.name
          // Planned while the session runs: afterwards its panes, which locate the worktree, are gone.
          const plan = await this.planWorktreeRemoval(async () => {
            if (!this.dependencies.prepareSessionWorktreeDeletion) throw new HttpError(501, 'Worktree removal is not available')
            return this.dependencies.prepareSessionWorktreeDeletion(route.sessionId)
          })
          const repo = this.dependencies.sessionRepo?.(route.sessionId)
          const archive = await this.archives.archive(route.sessionId, name, { paused, ...(repo ? { repo } : {}) })
          this.dependencies.afterSessionDeleted?.(route.sessionId)
          if (paused) {
            await this.closeBackgroundSessions(plan.plan)
            try { await this.preferences.holdPlaceByName(route.sessionId, name) }
            catch (error) { console.warn('[commando] Could not keep a paused session’s place in the session tree', error) }
          }
          // Stopped before the worktree goes, so no dev server is still writing into it.
          const processes = await this.stopProcesses(toStop)
          const result = paused ? { archive } : await this.removeArchivedWorktree(archive, async () => plan)
          await this.dependencies.onSessionsChanged?.()
          writeJson(response, 200, { ok: true, ...result, ...processes })
          return true
        }

        const prepareWorktreeDeletion = async () => {
          if (!this.dependencies.prepareSessionWorktreeDeletion) throw new HttpError(501, 'Worktree deletion is not available')
          let plan: SessionWorktreeDeletionPlan
          try { plan = await this.dependencies.prepareSessionWorktreeDeletion(route.sessionId) }
          catch (error) {
            if (error instanceof SessionWorktreeConflictError) throw new HttpError(409, error.message)
            throw error
          }
          const pausedUser = await this.pausedSessionUsing(plan.worktree.root)
          if (pausedUser) throw new HttpError(409, `${pausedUser}; resume or archive it first`)
          return plan
        }
        if (route.action === 'delete-preview') {
          if (request.method !== 'GET') throw new HttpError(405, 'Method not allowed')
          const plan = await prepareWorktreeDeletion()
          writeJson(response, 200, { auxiliarySessions: plan.auxiliarySessions })
          return true
        }

        if (request.method !== 'DELETE') throw new HttpError(405, 'Method not allowed')
        const body = record(await readJson(request))
        if (body.confirmSessionId !== route.sessionId) {
          throw new HttpError(400, 'Deletion requires an exact confirmSessionId')
        }
        if (body.deleteWorktree !== undefined && typeof body.deleteWorktree !== 'boolean') {
          throw new HttpError(400, 'deleteWorktree must be a boolean')
        }
        const toStop = await this.processesToStop(route.sessionId, body.stopProcessKeys)
        let deleteWorktree: SessionWorktreeDeletionPlan | undefined
        if (body.deleteWorktree === true) {
          deleteWorktree = await prepareWorktreeDeletion()
          const confirmed = body.confirmAuxiliarySessionIds ?? []
          if (!Array.isArray(confirmed) || confirmed.some((id) => typeof id !== 'string') ||
            confirmed.length !== deleteWorktree.auxiliarySessions.length ||
            deleteWorktree.auxiliarySessions.some(({ id }) => !confirmed.includes(id))) {
            throw new HttpError(409, 'Sessions using this worktree changed; review the deletion confirmation and try again')
          }
        }
        if (deleteWorktree?.auxiliarySessions.length) {
          try {
            for (const session of deleteWorktree.auxiliarySessions) await this.actions.delete(session.id)
            const remaining = await prepareWorktreeDeletion()
            if (remaining.auxiliarySessions.length) throw new HttpError(409, 'Another session began using this worktree; the main session was kept')
          } catch (error) {
            await this.dependencies.onSessionsChanged?.()
            throw error
          }
        }
        await this.actions.delete(route.sessionId)
        this.dependencies.afterSessionDeleted?.(route.sessionId)
        const processes = await this.stopProcesses(toStop)
        const processDetail = processes.processesNotStopped ? ` Some of its processes may still run: ${processes.processesNotStopped}.` : ''
        let worktreeError: unknown
        try {
          if (deleteWorktree) await this.recordWorktreeOnOtherArchives(deleteWorktree.worktree)
          await deleteWorktree?.remove()
        } catch (error) {
          worktreeError = error
        }
        let refreshError: unknown
        try {
          await this.dependencies.onSessionsChanged?.()
        } catch (error) {
          refreshError = error
        }
        if (worktreeError) {
          const detail = worktreeError instanceof Error ? worktreeError.message : 'worktree removal failed'
          const refreshDetail = refreshError ? ' Session state refresh also failed.' : ''
          throw new HttpError(409, `Tmux session was deleted, but its worktree was not removed: ${detail}.${refreshDetail}${processDetail}`)
        }
        if (refreshError) {
          const detail = refreshError instanceof Error ? refreshError.message : 'session state refresh failed'
          const subject = body.deleteWorktree === true ? 'Tmux session and worktree were deleted' : 'Tmux session was deleted'
          throw new HttpError(502, `${subject}, but session state refresh failed: ${detail}.${processDetail}`)
        }
        writeJson(response, 200, { ok: true, sessionId: route.sessionId, worktreeDeleted: body.deleteWorktree === true, ...processes })
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

  /**
   * The chosen processes of this session, taken before it closes: closing it regroups what is left,
   * so they are stopped by these pids. Processes that exited since the confirmation are dropped;
   * another session's process is refused.
   */
  private async processesToStop(sessionId: string, value: unknown): Promise<ProcessSelection | undefined> {
    if (value === undefined) return undefined
    const keys = parseProcessKeys(value)
    if (!keys) throw new HttpError(400, 'stopProcessKeys must list up to 256 process keys')
    if (!keys.length) return undefined
    if (!this.dependencies.trackedProcesses) throw new HttpError(501, 'Process tracking is not available')
    try { return await this.dependencies.trackedProcesses.select(keys, (process) => process.sessionId === sessionId) }
    catch (error) {
      if (error instanceof TrackedProcessScopeError) throw new HttpError(409, `${error.message}; review the confirmation and try again`)
      throw error
    }
  }

  /** Stops the chosen processes once their session has closed; the session is gone either way, so a failure is reported, not thrown. */
  private async stopProcesses(selection: ProcessSelection | undefined): Promise<{ processesStopped?: number; processesNotStopped?: string }> {
    if (!selection?.members.length || !this.dependencies.trackedProcesses) return {}
    try {
      const result = await this.dependencies.trackedProcesses.stopSelection(selection)
      await result.finished
      return { processesStopped: result.stopped.length, ...(result.failed.length ? { processesNotStopped: `Could not signal process ${result.failed.join(', ')}` } : {}) }
    } catch (error) {
      console.warn('[commando] Could not stop a closed session’s processes', error)
      return { processesNotStopped: error instanceof Error ? error.message : 'Stopping its processes failed' }
    }
  }

  /** Archives with a pane in the worktree. Pane paths are resolved by tmux, as the worktree root is by git. */
  private async archivesUsing(worktreeRoot: string, exceptArchiveId?: string): Promise<SessionArchive[]> {
    const using: SessionArchive[] = []
    for (const summary of await this.archives.list()) {
      if (summary.id === exceptArchiveId) continue
      const archive = await this.archives.get(summary.id).catch(() => undefined)
      if (archive?.windows.some((window) => window.panes.some((pane) => pane.path === worktreeRoot || pane.path.startsWith(`${worktreeRoot}/`)))) using.push(archive)
    }
    return using
  }

  /** Why a worktree must stay: a paused session will reopen in it. */
  private async pausedSessionUsing(worktreeRoot: string, exceptArchiveId?: string): Promise<string | undefined> {
    const paused = (await this.archivesUsing(worktreeRoot, exceptArchiveId)).find((archive) => archive.paused)
    return paused ? `Paused session “${paused.name}” still uses this worktree` : undefined
  }

  /** Lets other archived sessions in a worktree about to go check its branch out again when they are restored. */
  private async recordWorktreeOnOtherArchives(worktree: GitWorktreeIdentity, exceptArchiveId?: string): Promise<void> {
    for (const archive of await this.archivesUsing(worktree.root, exceptArchiveId)) {
      if (archive.paused || archive.worktree) continue
      await this.archives.update(archive.id, { worktree: { path: worktree.root, mainRoot: worktree.mainRoot, branch: worktree.branch } })
        .catch((error: unknown) => console.warn(`[commando] Could not record the removed worktree on archive ${archive.name}`, error))
    }
  }

  /** Helper sessions (dev servers and the like) for a worktree stop with the session that owns it. */
  private async closeBackgroundSessions(plan: SessionWorktreeDeletionPlan | undefined): Promise<void> {
    for (const session of plan?.auxiliarySessions ?? []) {
      await this.actions.delete(session.id).catch((error: unknown) => console.warn(`[commando] Could not close background session ${session.name}`, error))
    }
  }

  /** A worktree plan, or why there is none: `kept` is worth telling the user, a session outside any worktree is not. */
  private async planWorktreeRemoval(prepare: () => Promise<SessionWorktreeDeletionPlan>): Promise<{ plan?: SessionWorktreeDeletionPlan; kept?: string }> {
    try { return { plan: await prepare() } }
    catch (error) {
      if (error instanceof SessionWorktreeConflictError) return error.reason === 'no-worktree' ? {} : { kept: error.message }
      if (error instanceof HttpError && error.status === 501) return {}
      throw error
    }
  }

  /**
   * Commits uncommitted work, records the worktree in the archive, then removes it. The archive and
   * its session are already safe, so any failure here keeps the worktree and says why.
   */
  private async removeArchivedWorktree(
    archive: ArchiveSummary,
    plan: () => Promise<{ plan?: SessionWorktreeDeletionPlan; kept?: string }>,
  ): Promise<{ archive: ArchiveSummary; worktreeKept?: string }> {
    const { plan: removal, kept } = await plan()
    const pausedUser = removal && await this.pausedSessionUsing(removal.worktree.root, archive.id)
    if (pausedUser) return { archive: archive.paused ? await this.archives.update(archive.id, {}) : archive, worktreeKept: pausedUser }
    if (!removal) return { archive: archive.paused ? await this.archives.update(archive.id, {}) : archive, ...(kept ? { worktreeKept: kept } : {}) }
    await this.closeBackgroundSessions(removal)
    let current = removal.worktree
    let recorded = archive
    try {
      if (!this.dependencies.commitWorkInProgress) throw new Error('Work-in-progress commits are not available')
      current = await this.dependencies.commitWorkInProgress(removal.worktree, `wip: archived session “${archive.name}”`)
      // Recorded first: a restore recreates the worktree only when its folder is missing, so this is safe if removal fails.
      recorded = await this.archives.update(archive.id, { worktree: {
        path: current.root, mainRoot: current.mainRoot, branch: current.branch,
        ...(current.head !== removal.worktree.head ? { wipCommit: current.head } : {}),
      } })
      await this.recordWorktreeOnOtherArchives(current, archive.id)
      await removal.remove(current)
      return { archive: recorded }
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'worktree removal failed'
      const unrecorded = await this.archives.update(archive.id, {}).catch(() => recorded)
      return { archive: unrecorded, worktreeKept: current.head !== removal.worktree.head ? `${detail} (uncommitted work was saved in commit ${current.head.slice(0, 8)})` : detail }
    }
  }

  private async handlePreferences(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const currentSessions = this.dependencies.currentSessions()
    const serverId = this.dependencies.currentServerId?.()
    if (request.method === 'GET') {
      await this.preferences.ensureIdentities([], currentSessions, serverId)
      const preferences = await this.preferences.load(currentSessions, serverId)
      writeJson(response, 200, { preferences })
      return
    }
    if (request.method !== 'PUT') throw new HttpError(405, 'Method not allowed')

    const body = record(await readJson(request))
    const parsed = parseSessionTreePreferences(body.preferences)
    if (!parsed) throw new HttpError(400, 'Invalid session tree preferences')
    await this.preferences.ensureIdentities([], currentSessions, serverId)
    const preferences = await this.preferences.replace(parsed, currentSessions, serverId)
    writeJson(response, 200, { preferences })
  }

  private allowedMethods(pathname: string): string {
    if (pathname === `${API_ROOT}/preferences`) return 'GET, PUT'
    if (pathname === `${API_ROOT}/archives`) return 'GET'
    if (pathname.endsWith('/archive') || pathname.endsWith('/pause') || pathname.endsWith('/restore')) return 'POST'
    if (pathname.endsWith('/delete-preview')) return 'GET'
    if (pathname.endsWith('/rename') || pathname.endsWith('/identity') || pathname.endsWith('/identities')) return 'POST'
    if (pathname.endsWith('/delete')) return 'DELETE'
    return 'GET'
  }
}

export type { SessionTreePreferences }
