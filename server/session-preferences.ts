import { assignSessionIdentities, deriveSessionIdentity, isSessionGlyph, normalizeSessionIdentities, type SessionIdentities } from '../shared/session-identity.js'
import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
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
}

export type TmuxSessionReference = {
  id: string
  name: string
}

const SESSION_ID = /^\$\d+$/
const GROUP_ID = /^[A-Za-z0-9._-]{1,64}$/
const MAX_GROUPS = 128
const MAX_SESSIONS = 4_096

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

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
      if (
        typeof sessionId !== 'string' ||
        !SESSION_ID.test(sessionId) ||
        assignedSessionIds.has(sessionId)
      ) {
        return null
      }
      assignedSessionIds.add(sessionId)
      sessionIds.push(sessionId)
    }
    groupIds.add(candidate.id)
    groups.push({ id: candidate.id, name, sessionIds })
  }

  const ungroupedSessionIds: string[] = []
  for (const sessionId of value.ungroupedSessionIds) {
    if (
      typeof sessionId !== 'string' ||
      !SESSION_ID.test(sessionId) ||
      assignedSessionIds.has(sessionId)
    ) {
      return null
    }
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
      if (
        !SESSION_ID.test(sessionId) ||
        typeof name !== 'string' ||
        name.length === 0 ||
        name.length > 128 ||
        /[\u0000-\u001f\u007f]/.test(name)
      ) {
        return null
      }
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
      if (typeof id !== 'string' || (!SESSION_ID.test(id) && !(id.startsWith('group:') && GROUP_ID.test(id.slice(6)))) || ids.has(id)) return null
      ids.add(id)
    }
    repositorySessionIds = [...ids]
    if (repositorySessionIds.filter((id) => SESSION_ID.test(id)).length > MAX_SESSIONS || repositorySessionIds.filter((id) => id.startsWith('group:')).length > MAX_GROUPS) return null
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
        if (typeof id !== 'string' || !SESSION_ID.test(id) || members.has(id)) return null
        members.add(id)
        sessionIds.push(id)
      }
      if (members.size > MAX_SESSIONS) return null
      ids.add(candidate.id)
      repositoryGroups.push({ id: candidate.id, name, repoRoot: candidate.repoRoot, sessionIds, ...(candidate.collapsed !== undefined ? { collapsed: candidate.collapsed } : {}) })
    }
  }
  return {
    version: 1,
    groups,
    ungroupedSessionIds,
    ...(sessionNamesById ? { sessionNamesById } : {}),
    ...(value.sessionIdentities !== undefined ? { sessionIdentities: normalizeSessionIdentities(value.sessionIdentities) } : {}),
    ...(groupingMode ? { groupingMode } : {}),
    ...(repositorySessionIds ? { repositorySessionIds } : {}),
    ...(repositoryGroups ? { repositoryGroups } : {}),
  }
}

export function emptySessionTreePreferences(): SessionTreePreferences {
  return { version: 1, groups: [], ungroupedSessionIds: [] }
}

export function reconcileSessionTreePreferences(
  preferences: SessionTreePreferences,
  currentSessions: readonly TmuxSessionReference[],
): SessionTreePreferences {
  const parsed = parseSessionTreePreferences(preferences)
  if (!parsed) throw new Error('Invalid session tree preferences')

  const currentById = new Map<string, TmuxSessionReference>()
  const currentByName = new Map<string, TmuxSessionReference>()
  for (const session of currentSessions) {
    if (!SESSION_ID.test(session.id)) throw new Error('Invalid tmux session id')
    if (
      typeof session.name !== 'string' ||
      session.name.length === 0 ||
      session.name.length > 128 ||
      /[\u0000-\u001f\u007f]/.test(session.name)
    ) {
      throw new Error('Invalid tmux session name')
    }
    if (currentById.has(session.id) || currentByName.has(session.name)) continue
    currentById.set(session.id, session)
    currentByName.set(session.name, session)
  }

  const claimed = new Set<string>()
  const claimedNames = new Map<string, string>()
  const reconcileIds = (sessionIds: readonly string[], seen = claimed): string[] => sessionIds.flatMap((sessionId) => {
    const storedName = parsed.sessionNamesById?.[sessionId]
    const restored = storedName ? currentByName.get(storedName) : undefined
    const nextId = restored?.id ?? sessionId
    if (seen.has(nextId)) return []
    seen.add(nextId)
    const name = storedName ?? currentById.get(nextId)?.name
    if (name) claimedNames.set(nextId, name)
    return [nextId]
  })
  const groups = parsed.groups.map((group) => ({
    ...group,
    sessionIds: reconcileIds(group.sessionIds),
  }))
  const ungroupedSessionIds = reconcileIds(parsed.ungroupedSessionIds)
  const repositorySessionIds = parsed.repositorySessionIds
    ? (() => {
      const seen = new Set<string>()
      return parsed.repositorySessionIds.flatMap((id) => id.startsWith('group:') ? [id] : reconcileIds([id], seen))
    })()
    : undefined
  const repositoryClaimed = new Set<string>()
  const repositoryGroups = parsed.repositoryGroups?.map((group) => ({
    ...group,
    sessionIds: reconcileIds(group.sessionIds, repositoryClaimed).filter((sessionId) => {
      // reconcileIds carries the stored name to the remapped id in claimedNames.
      const storedName = claimedNames.get(sessionId)
      const current = currentById.get(sessionId)
      return !storedName || !current || current.name === storedName || currentByName.has(storedName)
    }),
  }))
  for (const session of currentSessions) {
    if (!claimed.has(session.id)) {
      claimed.add(session.id)
      claimedNames.set(session.id, session.name)
      ungroupedSessionIds.push(session.id)
    }
  }
  const sessionNamesById: Record<string, string> = {}
  for (const sessionId of new Set([...claimed, ...repositorySessionIds ?? [], ...repositoryClaimed])) {
    const name = claimedNames.get(sessionId)
    if (name) sessionNamesById[sessionId] = name
  }
  return {
    version: 1,
    groups,
    ungroupedSessionIds,
    ...(Object.keys(sessionNamesById).length > 0 ? { sessionNamesById } : {}),
    ...(parsed.sessionIdentities ? { sessionIdentities: parsed.sessionIdentities } : {}),
    ...(parsed.groupingMode ? { groupingMode: parsed.groupingMode } : {}),
    ...(repositorySessionIds ? { repositorySessionIds } : {}),
    ...(repositoryGroups ? { repositoryGroups } : {}),
  }
}

function hasUnresolvedSessionIdReuse(
  preferences: SessionTreePreferences,
  currentSessions: readonly TmuxSessionReference[],
): boolean {
  if (!preferences.sessionNamesById) return false
  const currentById = new Map(currentSessions.map((session) => [session.id, session]))
  const currentNames = new Set(currentSessions.map((session) => session.name))
  return Object.entries(preferences.sessionNamesById).some(([sessionId, storedName]) => {
    const current = currentById.get(sessionId)
    return Boolean(current && current.name !== storedName && !currentNames.has(storedName))
  })
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
  async loadReadOnly(currentSessions: readonly TmuxSessionReference[] = []): Promise<SessionTreePreferences> {
    await this.writes
    return reconcileSessionTreePreferences(await this.readState(), currentSessions)
  }

  async load(currentSessions: readonly TmuxSessionReference[] = []): Promise<SessionTreePreferences> {
    return this.update((stored) => {
      const reconciled = reconcileSessionTreePreferences(stored, currentSessions)
      return {
        result: reconciled,
        state: hasUnresolvedSessionIdReuse(stored, currentSessions)
          ? { ...stored, sessionIdentities: reconciled.sessionIdentities } : reconciled,
      }
    })
  }

  private withIdentities(preferences: SessionTreePreferences, sessions: readonly TmuxSessionReference[], names: readonly string[] = []): SessionTreePreferences {
    return { ...preferences, sessionIdentities: assignSessionIdentities(preferences.sessionIdentities ?? {}, [...sessions.map((session) => session.name), ...names]) }
  }

  /** All identity mutations share the preference write queue, so stale grouping saves cannot undo them. */
  private update(transform: (stored: SessionTreePreferences) => { result: SessionTreePreferences; state: SessionTreePreferences }): Promise<SessionTreePreferences> {
    let result: SessionTreePreferences
    const operation = this.writes.then(async () => {
      const stored = await this.readState()
      const next = transform(stored)
      result = next.result
      if (JSON.stringify(stored) !== JSON.stringify(next.state)) await this.writeState(next.state)
    })
    this.writes = operation.catch(() => undefined)
    return operation.then(() => result!)
  }

  ensureIdentities(names: readonly string[], sessions: readonly TmuxSessionReference[] = []): Promise<SessionTreePreferences> {
    return this.update((stored) => {
      const state = this.withIdentities(stored, sessions, names)
      return { state, result: reconcileSessionTreePreferences(state, sessions) }
    })
  }

  changeIdentity(name: string, glyph: string | null, sessions: readonly TmuxSessionReference[] = []): Promise<SessionTreePreferences> {
    if (glyph !== null && !isSessionGlyph(glyph)) return Promise.reject(new Error('Glyph must be a single emoji'))
    return this.update((stored) => {
      const state = this.withIdentities(stored, sessions, [name])
      const identities = new Map(Object.entries(state.sessionIdentities ?? {}))
      const otherCodenames = [...identities].filter(([key]) => key !== name).map(([, identity]) => identity.codename)
      const identity = identities.get(name) ?? deriveSessionIdentity(name, otherCodenames)
      identities.set(name, glyph === null ? deriveSessionIdentity(name, otherCodenames) : { ...identity, glyph, glyphSource: 'user' })
      state.sessionIdentities = normalizeSessionIdentities(Object.fromEntries(identities))
      return { state, result: reconcileSessionTreePreferences(state, sessions) }
    })
  }

  /** Follow a rename seen on the same tmux server, so reconcile doesn't mistake the session for a reused id. */
  recordSessionRename(sessionId: string, previousName: string, name: string): Promise<SessionTreePreferences> {
    return this.update((stored) => {
      if (stored.sessionNamesById?.[sessionId] !== previousName) return { state: stored, result: stored }
      const state = { ...stored, sessionNamesById: { ...stored.sessionNamesById, [sessionId]: name } }
      return { state, result: state }
    })
  }

  renameIdentity(oldName: string, newName: string, sessionId: string): Promise<SessionTreePreferences> {
    return this.update((stored) => {
      const identities = new Map(Object.entries(stored.sessionIdentities ?? {}))
      const identity = identities.get(oldName) ?? deriveSessionIdentity(oldName, [...identities.values()].map((entry) => entry.codename))
      identities.delete(oldName)
      identities.set(newName, identity)
      const state = { ...stored, sessionIdentities: normalizeSessionIdentities(Object.fromEntries(identities)), sessionNamesById: { ...stored.sessionNamesById, [sessionId]: newName } }
      return { state, result: state }
    })
  }

  replace(
    preferences: SessionTreePreferences,
    currentSessions: readonly TmuxSessionReference[] = [],
  ): Promise<SessionTreePreferences> {
    let parsed: SessionTreePreferences
    try {
      const candidate = parseSessionTreePreferences(preferences)
      if (!candidate) throw new Error('Invalid session tree preferences')
      parsed = candidate
    } catch (error) {
      return Promise.reject(error)
    }

    let validated: SessionTreePreferences
    const operation = this.writes.then(async () => {
      const stored = await this.readState()
      // A session newly placed in a repository group takes its current name, replacing any name
      // left over from an earlier session with the same id. The client sends the name it displayed
      // for the session it moved; a stale snapshot's name won't match tmux, so it isn't accepted.
      // Compare with the reconciled view the client was given: load() can leave stale members on disk.
      const baseline = reconcileSessionTreePreferences(stored, currentSessions)
      const storedMembers = new Map((baseline.repositoryGroups ?? []).map((group) => [group.id, new Set(group.sessionIds)]))
      const currentNames = new Map(currentSessions.map((session) => [session.id, session.name]))
      const assignedNames: Record<string, string> = {}
      for (const group of parsed.repositoryGroups ?? []) {
        for (const sessionId of group.sessionIds) {
          if (storedMembers.get(group.id)?.has(sessionId)) continue
          const submitted = parsed.sessionNamesById?.[sessionId]
          const current = currentNames.get(sessionId)
          // Not in a tmux snapshot yet (just created): trust the client's name until tmux reports it.
          if (submitted && (current === undefined || current === submitted)) assignedNames[sessionId] = submitted
        }
      }
      validated = reconcileSessionTreePreferences({
        ...parsed,
        // Identity changes use dedicated queued mutations; grouping snapshots may be stale.
        ...(parsed.sessionIdentities || stored.sessionIdentities ? { sessionIdentities: stored.sessionIdentities ?? parsed.sessionIdentities } : {}),
        // Renames are recorded server-side, so stored names win over a client's possibly stale copy.
        sessionNamesById: {
          ...parsed.sessionNamesById,
          ...stored.sessionNamesById,
          ...assignedNames,
        },
      }, currentSessions)
      await this.writeState(validated)
    })
    this.writes = operation.catch(() => undefined)
    return operation.then(() => validated!)
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
