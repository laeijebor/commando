import { assignSessionIdentities, deriveSessionIdentity, isSessionGlyph, normalizeSessionIdentities, type SessionIdentities } from '../shared/session-identity.js'
import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'

export type SessionPreferenceGroup = {
  id: string
  name: string
  sessionIds: string[]
}

export type SessionGroupingMode = 'repository' | 'manual'

export type RepositorySessionGroup = {
  id: string
  name: string
  repoRoot: string
  sessionIds: string[]
  collapsed?: boolean
}

export type SessionTreePreferences = {
  version: 1
  groups: SessionPreferenceGroup[]
  ungroupedSessionIds: string[]
  sessionNamesById?: Record<string, string>
  sessionIdentities?: SessionIdentities
  /** How the sidebar groups sessions; defaults to `repository` when absent. */
  groupingMode?: SessionGroupingMode
  /** Top-level repository order: loose session ids and `group:<groupId>` tokens, independent of manual grouping. */
  repositorySessionIds?: string[]
  repositoryGroups?: RepositorySessionGroup[]
  /** The tmux server (`pid:start_time`) whose session ids these preferences use. */
  serverId?: string
}

export type TmuxSessionReference = {
  id: string
  name: string
}

const SESSION_ID = /^\$\d+$/
const GROUP_ID = /^[A-Za-z0-9._-]{1,64}$/
const SERVER_ID = /^[A-Za-z0-9:._-]{1,64}$/
/**
 * Holds a session's place after a tmux restart until a session with this name is restored.
 * Session ids are only meaningful on the server that issued them; names survive tmux-resurrect.
 */
const PENDING_PREFIX = 'name:'
/** Stands in for the unknown tmux server that wrote preferences saved before server ids were recorded. */
const PREVIOUS_SERVER_ID = 'previous'
const MAX_GROUPS = 128
const MAX_SESSIONS = 4_096

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const isSessionName = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 128 && !/[\u0000-\u001f\u007f]/.test(value)

/** A live tmux session id, or a placeholder naming a session that hasn't been restored yet. */
const isSessionEntry = (value: string): boolean =>
  SESSION_ID.test(value) || (value.startsWith(PENDING_PREFIX) && isSessionName(value.slice(PENDING_PREFIX.length)))

export function validateSessionGroupName(value: unknown): string {
  if (typeof value !== 'string' || value !== value.trim() || value.length === 0 || value.length > 128) {
    throw new Error('Group name must be between 1 and 128 characters without surrounding whitespace')
  }
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error('Group name contains unsupported control characters')
  }
  return value
}

export function parseSessionTreePreferences(value: unknown): SessionTreePreferences | null {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.groups)) return null
  if (!Array.isArray(value.ungroupedSessionIds) || value.groups.length > MAX_GROUPS) return null

  const groupIds = new Set<string>()
  const assignedSessionIds = new Set<string>()
  const groups: SessionPreferenceGroup[] = []

  for (const candidate of value.groups) {
    if (!isRecord(candidate) || typeof candidate.id !== 'string' || !GROUP_ID.test(candidate.id)) {
      return null
    }
    if (groupIds.has(candidate.id) || !Array.isArray(candidate.sessionIds)) return null

    let name: string
    try {
      name = validateSessionGroupName(candidate.name)
    } catch {
      return null
    }

    const sessionIds: string[] = []
    for (const sessionId of candidate.sessionIds) {
      if (typeof sessionId !== 'string' || !isSessionEntry(sessionId) || assignedSessionIds.has(sessionId)) return null
      assignedSessionIds.add(sessionId)
      sessionIds.push(sessionId)
    }
    groupIds.add(candidate.id)
    groups.push({ id: candidate.id, name, sessionIds })
  }

  const ungroupedSessionIds: string[] = []
  for (const sessionId of value.ungroupedSessionIds) {
    if (typeof sessionId !== 'string' || !isSessionEntry(sessionId) || assignedSessionIds.has(sessionId)) return null
    assignedSessionIds.add(sessionId)
    ungroupedSessionIds.push(sessionId)
  }

  if (assignedSessionIds.size > MAX_SESSIONS) return null
  let sessionNamesById: Record<string, string> | undefined
  if (value.sessionNamesById !== undefined) {
    if (!isRecord(value.sessionNamesById)) return null
    const entries = Object.entries(value.sessionNamesById)
    if (entries.length > MAX_SESSIONS) return null
    sessionNamesById = {}
    for (const [sessionId, name] of entries) {
      if (!SESSION_ID.test(sessionId) || !isSessionName(name)) return null
      sessionNamesById[sessionId] = name
    }
  }
  let groupingMode: SessionGroupingMode | undefined
  if (value.groupingMode !== undefined) {
    if (value.groupingMode !== 'repository' && value.groupingMode !== 'manual') return null
    groupingMode = value.groupingMode
  }
  let repositorySessionIds: string[] | undefined
  if (value.repositorySessionIds !== undefined) {
    if (!Array.isArray(value.repositorySessionIds) || value.repositorySessionIds.length > MAX_SESSIONS + MAX_GROUPS) return null
    const ids = new Set<string>()
    for (const id of value.repositorySessionIds) {
      if (typeof id !== 'string' || !(isSessionEntry(id) || (id.startsWith('group:') && GROUP_ID.test(id.slice(6)))) || ids.has(id)) return null
      ids.add(id)
    }
    repositorySessionIds = [...ids]
    if (repositorySessionIds.filter((id) => !id.startsWith('group:')).length > MAX_SESSIONS || repositorySessionIds.filter((id) => id.startsWith('group:')).length > MAX_GROUPS) return null
  }
  let repositoryGroups: RepositorySessionGroup[] | undefined
  if (value.repositoryGroups !== undefined) {
    if (!Array.isArray(value.repositoryGroups) || value.repositoryGroups.length > MAX_GROUPS) return null
    repositoryGroups = []
    const ids = new Set<string>()
    const members = new Set<string>()
    for (const candidate of value.repositoryGroups) {
      if (!isRecord(candidate) || typeof candidate.id !== 'string' || !GROUP_ID.test(candidate.id) || ids.has(candidate.id)) return null
      if (typeof candidate.repoRoot !== 'string' || !isAbsolute(candidate.repoRoot) || candidate.repoRoot.length > 4096 || /[\u0000-\u001f\u007f]/.test(candidate.repoRoot)) return null
      if (!Array.isArray(candidate.sessionIds) || (candidate.collapsed !== undefined && typeof candidate.collapsed !== 'boolean')) return null
      let name: string
      try { name = validateSessionGroupName(candidate.name) } catch { return null }
      const sessionIds: string[] = []
      for (const id of candidate.sessionIds) {
        if (typeof id !== 'string' || !isSessionEntry(id) || members.has(id)) return null
        members.add(id)
        sessionIds.push(id)
      }
      if (members.size > MAX_SESSIONS) return null
      ids.add(candidate.id)
      repositoryGroups.push({ id: candidate.id, name, repoRoot: candidate.repoRoot, sessionIds, ...(candidate.collapsed !== undefined ? { collapsed: candidate.collapsed } : {}) })
    }
  }
  if (value.serverId !== undefined && (typeof value.serverId !== 'string' || !SERVER_ID.test(value.serverId))) return null
  return {
    version: 1,
    groups,
    ungroupedSessionIds,
    ...(sessionNamesById ? { sessionNamesById } : {}),
    ...(value.sessionIdentities !== undefined ? { sessionIdentities: normalizeSessionIdentities(value.sessionIdentities) } : {}),
    ...(groupingMode ? { groupingMode } : {}),
    ...(repositorySessionIds ? { repositorySessionIds } : {}),
    ...(repositoryGroups ? { repositoryGroups } : {}),
    ...(value.serverId !== undefined ? { serverId: value.serverId } : {}),
  }
}

export function emptySessionTreePreferences(): SessionTreePreferences {
  return { version: 1, groups: [], ungroupedSessionIds: [] }
}

/**
 * Map stored entries onto the live tmux sessions.
 *
 * tmux never reuses a session id while its server runs, but a restarted server (for example
 * after tmux-resurrect) hands out ids from the start again. So ids are trusted only on the
 * server that issued them (`serverId`); entries from another server are matched by session
 * name, and those not restored yet keep their place as `name:` placeholders.
 */
export function reconcileSessionTreePreferences(
  preferences: SessionTreePreferences,
  currentSessions: readonly TmuxSessionReference[],
  serverId?: string | null,
): SessionTreePreferences {
  const parsed = parseSessionTreePreferences(preferences)
  if (!parsed) throw new Error('Invalid session tree preferences')

  const currentById = new Map<string, TmuxSessionReference>()
  const currentByName = new Map<string, TmuxSessionReference>()
  for (const session of currentSessions) {
    if (!SESSION_ID.test(session.id)) throw new Error('Invalid tmux session id')
    if (!isSessionName(session.name)) throw new Error('Invalid tmux session name')
    if (currentById.has(session.id) || currentByName.has(session.name)) continue
    currentById.set(session.id, session)
    currentByName.set(session.name, session)
  }

  // Without a recorded server (preferences from before server ids, or tmux not found yet) ids are trusted.
  const sameServer = !serverId || !parsed.serverId || parsed.serverId === serverId
  // Only ids known to come from this server outrank names; a client view without one may predate a restart.
  const idsFromThisServer = Boolean(serverId) && parsed.serverId === serverId
  const storedNames = parsed.sessionNamesById ?? {}
  const sessionNamesById: Record<string, string> = {}
  const resolve = (entry: string): string | undefined => {
    if (entry.startsWith(PENDING_PREFIX)) return currentByName.get(entry.slice(PENDING_PREFIX.length))?.id ?? entry
    // A server never reuses an id, so a live id is still its own session, even if renamed.
    if (idsFromThisServer && currentById.has(entry)) return entry
    const name = storedNames[entry]
    const live = name ? currentByName.get(name) : undefined
    if (live) return live.id
    if (!sameServer) return name ? PENDING_PREFIX + name : undefined
    // Closed (its name lets a restore after a tmux restart find it), or created but not in a tmux snapshot yet.
    if (name) sessionNamesById[entry] = name
    return entry
  }
  const reconcileIds = (sessionIds: readonly string[], claimed: Set<string>): string[] => sessionIds.flatMap((sessionId) => {
    const next = resolve(sessionId)
    if (!next || claimed.has(next)) return []
    claimed.add(next)
    return [next]
  })

  const claimed = new Set<string>()
  const groups = parsed.groups.map((group) => ({ ...group, sessionIds: reconcileIds(group.sessionIds, claimed) }))
  const ungroupedSessionIds = reconcileIds(parsed.ungroupedSessionIds, claimed)
  for (const session of currentById.values()) {
    if (!claimed.has(session.id)) ungroupedSessionIds.push(session.id)
  }
  const repositorySessionIds = parsed.repositorySessionIds
    ? (() => {
      const seen = new Set<string>()
      return parsed.repositorySessionIds.flatMap((id) => id.startsWith('group:') ? [id] : reconcileIds([id], seen))
    })()
    : undefined
  const repositoryClaimed = new Set<string>()
  const repositoryGroups = parsed.repositoryGroups?.map((group) => ({ ...group, sessionIds: reconcileIds(group.sessionIds, repositoryClaimed) }))
  for (const session of currentById.values()) sessionNamesById[session.id] = session.name

  const resultServerId = serverId ?? parsed.serverId
  return {
    version: 1,
    groups,
    ungroupedSessionIds,
    ...(Object.keys(sessionNamesById).length > 0 ? { sessionNamesById } : {}),
    ...(parsed.sessionIdentities ? { sessionIdentities: parsed.sessionIdentities } : {}),
    ...(parsed.groupingMode ? { groupingMode: parsed.groupingMode } : {}),
    ...(repositorySessionIds ? { repositorySessionIds } : {}),
    ...(repositoryGroups ? { repositoryGroups } : {}),
    ...(resultServerId ? { serverId: resultServerId } : {}),
  }
}

export function visibleSessionTreePreferences(
  preferences: SessionTreePreferences,
  currentSessions: readonly TmuxSessionReference[],
): SessionTreePreferences {
  const current = new Set(currentSessions.map((session) => session.id))
  return {
    version: 1,
    groups: preferences.groups.map((group) => ({
      ...group,
      sessionIds: group.sessionIds.filter((sessionId) => current.has(sessionId)),
    })),
    ungroupedSessionIds: preferences.ungroupedSessionIds.filter((sessionId) =>
      current.has(sessionId),
    ),
    ...(preferences.sessionIdentities ? { sessionIdentities: preferences.sessionIdentities } : {}),
    ...(preferences.groupingMode ? { groupingMode: preferences.groupingMode } : {}),
    ...(preferences.repositorySessionIds ? {
      repositorySessionIds: preferences.repositorySessionIds.filter((sessionId) => sessionId.startsWith('group:') || current.has(sessionId)),
    } : {}),
    ...(preferences.repositoryGroups ? { repositoryGroups: preferences.repositoryGroups.map((group) => ({ ...group, sessionIds: group.sessionIds.filter((id) => current.has(id)) })) } : {}),
  }
}

export function defaultSessionPreferencesPath(): string {
  return (
    process.env.COMMANDO_SESSION_PREFERENCES_PATH ??
    join(homedir(), '.commando', 'session-tree.json')
  )
}

export class SessionPreferenceStore {
  readonly statePath: string
  private writes: Promise<void> = Promise.resolve()

  constructor(statePath = defaultSessionPreferencesPath()) {
    this.statePath = statePath
  }

  /** Reconcile for display without persisting changes from this reader's snapshot. */
  async loadReadOnly(currentSessions: readonly TmuxSessionReference[] = [], serverId?: string | null): Promise<SessionTreePreferences> {
    await this.writes
    return reconcileSessionTreePreferences(await this.withServerId(await this.readState(), serverId), currentSessions, serverId)
  }

  async load(currentSessions: readonly TmuxSessionReference[] = [], serverId?: string | null): Promise<SessionTreePreferences> {
    return this.update((stored) => {
      const reconciled = reconcileSessionTreePreferences(stored, currentSessions, serverId)
      return { result: reconciled, state: reconciled }
    }, serverId)
  }

  private withIdentities(preferences: SessionTreePreferences, sessions: readonly TmuxSessionReference[], names: readonly string[] = []): SessionTreePreferences {
    return { ...preferences, sessionIdentities: assignSessionIdentities(preferences.sessionIdentities ?? {}, [...sessions.map((session) => session.name), ...names]) }
  }

  /** All identity mutations share the preference write queue, so stale grouping saves cannot undo them. */
  private update(transform: (stored: SessionTreePreferences) => { result: SessionTreePreferences; state: SessionTreePreferences }, serverId?: string | null): Promise<SessionTreePreferences> {
    let result: SessionTreePreferences
    const operation = this.writes.then(async () => {
      const stored = await this.readState()
      const next = transform(await this.withServerId(stored, serverId))
      result = next.result
      if (JSON.stringify(stored) !== JSON.stringify(next.state)) await this.writeState(next.state)
    })
    this.writes = operation.catch(() => undefined)
    return operation.then(() => result!)
  }

  ensureIdentities(names: readonly string[], sessions: readonly TmuxSessionReference[] = [], serverId?: string | null): Promise<SessionTreePreferences> {
    return this.update((stored) => {
      const state = this.withIdentities(stored, sessions, names)
      return { state, result: reconcileSessionTreePreferences(state, sessions, serverId) }
    }, serverId)
  }

  changeIdentity(name: string, glyph: string | null, sessions: readonly TmuxSessionReference[] = [], serverId?: string | null): Promise<SessionTreePreferences> {
    if (glyph !== null && !isSessionGlyph(glyph)) return Promise.reject(new Error('Glyph must be a single emoji'))
    return this.update((stored) => {
      const state = this.withIdentities(stored, sessions, [name])
      const identities = new Map(Object.entries(state.sessionIdentities ?? {}))
      const otherCodenames = [...identities].filter(([key]) => key !== name).map(([, identity]) => identity.codename)
      const identity = identities.get(name) ?? deriveSessionIdentity(name, otherCodenames)
      identities.set(name, glyph === null ? deriveSessionIdentity(name, otherCodenames) : { ...identity, glyph, glyphSource: 'user' })
      state.sessionIdentities = normalizeSessionIdentities(Object.fromEntries(identities))
      return { state, result: reconcileSessionTreePreferences(state, sessions, serverId) }
    }, serverId)
  }

  /** Record a rename seen on the same tmux server right away, so a tmux restart before the next load still finds the session. */
  recordSessionRename(sessionId: string, previousName: string, name: string, serverId?: string | null): Promise<SessionTreePreferences> {
    return this.update((stored) => {
      if (stored.sessionNamesById?.[sessionId] !== previousName) return { state: stored, result: stored }
      const state = { ...stored, sessionNamesById: { ...stored.sessionNamesById, [sessionId]: name } }
      return { state, result: state }
    }, serverId)
  }

  renameIdentity(oldName: string, newName: string, sessionId: string, serverId?: string | null): Promise<SessionTreePreferences> {
    return this.update((stored) => {
      const identities = new Map(Object.entries(stored.sessionIdentities ?? {}))
      const identity = identities.get(oldName) ?? deriveSessionIdentity(oldName, [...identities.values()].map((entry) => entry.codename))
      identities.delete(oldName)
      identities.set(newName, identity)
      // Before the first load after a tmux restart, the stored ids still belong to the old server.
      const sameIds = !serverId || stored.serverId === serverId || stored.sessionNamesById?.[sessionId] === oldName
      const state = {
        ...stored,
        sessionIdentities: normalizeSessionIdentities(Object.fromEntries(identities)),
        ...(sameIds ? { sessionNamesById: { ...stored.sessionNamesById, [sessionId]: newName } } : {}),
      }
      return { state, result: state }
    }, serverId)
  }

  replace(
    preferences: SessionTreePreferences,
    currentSessions: readonly TmuxSessionReference[] = [],
    serverId?: string | null,
  ): Promise<SessionTreePreferences> {
    const parsed = parseSessionTreePreferences(preferences)
    if (!parsed) return Promise.reject(new Error('Invalid session tree preferences'))
    return this.update((stored) => {
      // The client's ids are read against the tmux server it last loaded from (its `serverId`),
      // so a view from before a tmux restart can't hand a group to the session now using an old id.
      const state = reconcileSessionTreePreferences({
        ...parsed,
        // Identity changes use dedicated queued mutations; grouping snapshots may be stale.
        ...(parsed.sessionIdentities || stored.sessionIdentities ? { sessionIdentities: stored.sessionIdentities ?? parsed.sessionIdentities } : {}),
        // Stored names cover ids the client no longer lists; they are only valid on the same server.
        sessionNamesById: parsed.serverId === stored.serverId
          ? { ...stored.sessionNamesById, ...parsed.sessionNamesById } : parsed.sessionNamesById,
      }, currentSessions, serverId)
      return { state, result: state }
    }, serverId)
  }

  /**
   * Preferences saved before server ids were recorded belong to the current tmux server only if
   * they were written after it started (`serverId` is `pid:start_time`); otherwise they predate a
   * tmux restart and their ids must be matched by name.
   */
  private async withServerId(stored: SessionTreePreferences, serverId: string | null | undefined): Promise<SessionTreePreferences> {
    if (stored.serverId || !serverId) return stored
    const startedAt = Number(serverId.split(':')[1])
    const writtenAt = await stat(this.statePath).then((file) => file.mtimeMs / 1000, () => undefined)
    if (writtenAt === undefined || !Number.isFinite(startedAt) || writtenAt >= startedAt) return { ...stored, serverId }
    return { ...stored, serverId: PREVIOUS_SERVER_ID }
  }

  private async readState(): Promise<SessionTreePreferences> {
    try {
      const content = await readFile(this.statePath, 'utf8')
      const parsed = parseSessionTreePreferences(JSON.parse(content) as unknown)
      if (!parsed) throw new Error('Session preference state file has an invalid structure')
      return parsed
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return emptySessionTreePreferences()
      }
      if (error instanceof SyntaxError) {
        throw new Error('Session preference state file contains invalid JSON', { cause: error })
      }
      throw error
    }
  }

  private async writeState(state: SessionTreePreferences): Promise<void> {
    const directory = dirname(this.statePath)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const temporaryPath = `${this.statePath}.${process.pid}.${randomUUID()}.tmp`
    let handle: Awaited<ReturnType<typeof open>> | null = null

    try {
      handle = await open(temporaryPath, 'wx', 0o600)
      await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, 'utf8')
      await handle.sync()
      await handle.close()
      handle = null
      await rename(temporaryPath, this.statePath)
    } catch (error) {
      await handle?.close().catch(() => undefined)
      await rm(temporaryPath, { force: true }).catch(() => undefined)
      throw error
    }
  }
}
