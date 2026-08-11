import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export type SessionPreferenceGroup = {
  id: string
  name: string
  sessionIds: string[]
}

export type SessionTreePreferences = {
  version: 1
  groups: SessionPreferenceGroup[]
  ungroupedSessionIds: string[]
  sessionNamesById?: Record<string, string>
}

export type SessionIdentity = {
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
  return { version: 1, groups, ungroupedSessionIds, ...(sessionNamesById ? { sessionNamesById } : {}) }
}

export function emptySessionTreePreferences(): SessionTreePreferences {
  return { version: 1, groups: [], ungroupedSessionIds: [] }
}

export function reconcileSessionTreePreferences(
  preferences: SessionTreePreferences,
  currentSessions: readonly SessionIdentity[],
): SessionTreePreferences {
  const parsed = parseSessionTreePreferences(preferences)
  if (!parsed) throw new Error('Invalid session tree preferences')

  const currentById = new Map<string, SessionIdentity>()
  const currentByName = new Map<string, SessionIdentity>()
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
  const reconcileIds = (sessionIds: readonly string[]): string[] => sessionIds.flatMap((sessionId) => {
    const storedName = parsed.sessionNamesById?.[sessionId]
    const restored = storedName ? currentByName.get(storedName) : undefined
    const nextId = restored?.id ?? sessionId
    if (claimed.has(nextId)) return []
    claimed.add(nextId)
    const name = storedName ?? currentById.get(nextId)?.name
    if (name) claimedNames.set(nextId, name)
    return [nextId]
  })
  const groups = parsed.groups.map((group) => ({
    ...group,
    sessionIds: reconcileIds(group.sessionIds),
  }))
  const ungroupedSessionIds = reconcileIds(parsed.ungroupedSessionIds)
  for (const session of currentSessions) {
    if (!claimed.has(session.id)) {
      claimed.add(session.id)
      claimedNames.set(session.id, session.name)
      ungroupedSessionIds.push(session.id)
    }
  }
  const sessionNamesById: Record<string, string> = {}
  for (const sessionId of claimed) {
    const name = claimedNames.get(sessionId)
    if (name) sessionNamesById[sessionId] = name
  }
  return {
    version: 1,
    groups,
    ungroupedSessionIds,
    ...(Object.keys(sessionNamesById).length > 0 ? { sessionNamesById } : {}),
  }
}

function hasUnresolvedSessionIdReuse(
  preferences: SessionTreePreferences,
  currentSessions: readonly SessionIdentity[],
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
  currentSessions: readonly SessionIdentity[],
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

  async load(currentSessions: readonly SessionIdentity[] = []): Promise<SessionTreePreferences> {
    await this.writes
    const stored = await this.readState()
    const reconciled = reconcileSessionTreePreferences(stored, currentSessions)
    if (
      JSON.stringify(reconciled) !== JSON.stringify(stored) &&
      !hasUnresolvedSessionIdReuse(stored, currentSessions)
    ) {
      await this.replace(reconciled, currentSessions)
    }
    return reconciled
  }

  replace(
    preferences: SessionTreePreferences,
    currentSessions: readonly SessionIdentity[] = [],
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
      validated = reconcileSessionTreePreferences({
        ...parsed,
        sessionNamesById: {
          ...stored.sessionNamesById,
          ...parsed.sessionNamesById,
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
