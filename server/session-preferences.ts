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
  return { version: 1, groups, ungroupedSessionIds }
}

export function emptySessionTreePreferences(): SessionTreePreferences {
  return { version: 1, groups: [], ungroupedSessionIds: [] }
}

export function reconcileSessionTreePreferences(
  preferences: SessionTreePreferences,
  currentSessionIds: readonly string[],
): SessionTreePreferences {
  const parsed = parseSessionTreePreferences(preferences)
  if (!parsed) throw new Error('Invalid session tree preferences')

  const known = new Set([
    ...parsed.groups.flatMap((group) => group.sessionIds),
    ...parsed.ungroupedSessionIds,
  ])
  const additions: string[] = []
  const current = new Set<string>()
  for (const sessionId of currentSessionIds) {
    if (!SESSION_ID.test(sessionId)) throw new Error('Invalid tmux session id')
    if (current.has(sessionId)) continue
    current.add(sessionId)
    if (!known.has(sessionId)) additions.push(sessionId)
  }

  if (additions.length === 0) return parsed
  return {
    ...parsed,
    ungroupedSessionIds: [...parsed.ungroupedSessionIds, ...additions],
  }
}

export function visibleSessionTreePreferences(
  preferences: SessionTreePreferences,
  currentSessionIds: readonly string[],
): SessionTreePreferences {
  const current = new Set(currentSessionIds)
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

  async load(currentSessionIds: readonly string[] = []): Promise<SessionTreePreferences> {
    await this.writes
    const stored = await this.readState()
    const reconciled = reconcileSessionTreePreferences(stored, currentSessionIds)
    if (reconciled.ungroupedSessionIds.length !== stored.ungroupedSessionIds.length) {
      await this.replace(reconciled, currentSessionIds)
    }
    return reconciled
  }

  replace(
    preferences: SessionTreePreferences,
    currentSessionIds: readonly string[] = [],
  ): Promise<SessionTreePreferences> {
    let validated: SessionTreePreferences
    try {
      validated = reconcileSessionTreePreferences(preferences, currentSessionIds)
    } catch (error) {
      return Promise.reject(error)
    }

    const operation = this.writes.then(() => this.writeState(validated))
    this.writes = operation.catch(() => undefined)
    return operation.then(() => validated)
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
