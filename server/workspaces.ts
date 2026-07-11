import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import type {
  GroupLayoutPreset,
  SavedGroup,
  SavedWorkspace,
} from '../shared/protocol.js'

type StateFile = {
  version: 1
  workspaces: Record<string, SavedWorkspace>
}

const SESSION_ID = /^\$\d+$/
const WINDOW_ID = /^@\d+$/
const PANE_ID = /^%\d+$/
const GROUP_ID = /^[A-Za-z0-9._-]{1,64}$/
const LAYOUTS = new Set<GroupLayoutPreset>([
  'equal-grid',
  'full-then-halves',
  'two-full-two-halves',
  'lead-and-stack',
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function cleanName(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 128 || value.trim().length === 0) {
    return null
  }
  return /[\u0000-\u001f\u007f]/.test(value) ? null : value
}

function parseGroup(value: unknown): SavedGroup | null {
  if (!isRecord(value)) return null
  const { id, name, sessionId, windowId, paneIds, layout } = value
  const parsedName = cleanName(name)

  if (
    typeof id !== 'string' ||
    !GROUP_ID.test(id) ||
    parsedName === null ||
    typeof sessionId !== 'string' ||
    !SESSION_ID.test(sessionId) ||
    typeof windowId !== 'string' ||
    !WINDOW_ID.test(windowId) ||
    !Array.isArray(paneIds) ||
    paneIds.length === 0 ||
    paneIds.length > 32 ||
    typeof layout !== 'string' ||
    !LAYOUTS.has(layout as GroupLayoutPreset)
  ) {
    return null
  }

  if (!paneIds.every((paneId) => typeof paneId === 'string' && PANE_ID.test(paneId))) {
    return null
  }
  if (new Set(paneIds).size !== paneIds.length) return null

  return {
    id,
    name: parsedName,
    sessionId,
    windowId,
    paneIds: [...paneIds],
    layout: layout as GroupLayoutPreset,
  }
}

export function parseSavedWorkspace(value: unknown): SavedWorkspace | null {
  if (!isRecord(value)) return null
  const { sessionId, groups, updatedAt } = value
  if (
    typeof sessionId !== 'string' ||
    !SESSION_ID.test(sessionId) ||
    !Array.isArray(groups) ||
    groups.length > 32 ||
    typeof updatedAt !== 'number' ||
    !Number.isSafeInteger(updatedAt) ||
    updatedAt < 0
  ) {
    return null
  }

  const parsedGroups = groups.map(parseGroup)
  if (parsedGroups.some((group) => group === null)) return null
  const validGroups = parsedGroups as SavedGroup[]
  if (new Set(validGroups.map((group) => group.id)).size !== validGroups.length) {
    return null
  }
  if (validGroups.some((group) => group.sessionId !== sessionId)) return null
  const allPaneIds = validGroups.flatMap((group) => group.paneIds)
  if (new Set(allPaneIds).size !== allPaneIds.length) return null

  return { sessionId, groups: validGroups, updatedAt }
}

function parseState(value: unknown): StateFile {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.workspaces)) {
    throw new Error('Workspace state file has an invalid structure')
  }

  const workspaces: Record<string, SavedWorkspace> = Object.create(null)
  for (const [sessionId, candidate] of Object.entries(value.workspaces)) {
    const workspace = parseSavedWorkspace(candidate)
    if (!workspace || workspace.sessionId !== sessionId) {
      throw new Error(`Workspace state contains an invalid entry for ${sessionId}`)
    }
    workspaces[sessionId] = workspace
  }

  return { version: 1, workspaces }
}

export function defaultStatePath(): string {
  return process.env.COMMANDO_STATE_PATH ?? join(homedir(), '.commando', 'state.json')
}

export class WorkspaceStore {
  readonly statePath: string
  private writes: Promise<void> = Promise.resolve()

  constructor(statePath = defaultStatePath()) {
    this.statePath = statePath
  }

  async load(sessionId: string): Promise<SavedWorkspace | null> {
    if (!SESSION_ID.test(sessionId)) throw new Error('Invalid tmux session id')
    await this.writes
    const state = await this.readState()
    return state.workspaces[sessionId] ?? null
  }

  save(workspace: SavedWorkspace): Promise<void> {
    const validated = parseSavedWorkspace(workspace)
    if (!validated) return Promise.reject(new Error('Invalid workspace'))

    const operation = this.writes.then(async () => {
      const state = await this.readState()
      state.workspaces[validated.sessionId] = validated
      await this.writeState(state)
    })
    this.writes = operation.catch(() => undefined)
    return operation
  }

  private async readState(): Promise<StateFile> {
    try {
      const content = await readFile(this.statePath, 'utf8')
      return parseState(JSON.parse(content) as unknown)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { version: 1, workspaces: Object.create(null) }
      }
      if (error instanceof SyntaxError) {
        throw new Error('Workspace state file contains invalid JSON', { cause: error })
      }
      throw error
    }
  }

  private async writeState(state: StateFile): Promise<void> {
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

      try {
        const directoryHandle = await open(directory, 'r')
        try {
          await directoryHandle.sync()
        } finally {
          await directoryHandle.close()
        }
      } catch {
        // Directory fsync is not available on every supported filesystem.
      }
    } catch (error) {
      await handle?.close().catch(() => undefined)
      await rm(temporaryPath, { force: true }).catch(() => undefined)
      throw error
    }
  }
}
