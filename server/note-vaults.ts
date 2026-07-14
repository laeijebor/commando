import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, readdir, realpath, rename, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, parse } from 'node:path'
import { defaultLegacyNotesPath, NoteStore, NoteValidationError } from './notes.js'

const MAX_VAULTS = 20
const MAX_PATH_LENGTH = 4_096

type StoredVault = {
  id: string
  path: string
  lastOpenedAt: number
}

type VaultState = {
  version: 1
  activeVaultId: string
  vaults: StoredVault[]
}

export type NoteVaultSummary = StoredVault & {
  name: string
  available: boolean
}

export type NoteVaultSnapshot = {
  activeVaultId: string
  vaults: NoteVaultSummary[]
}

export type NoteVaultBrowseResult = {
  path: string
  parent: string | null
  home: string
  directories: Array<{ name: string; path: string }>
}

export type NoteVaultManagerOptions = {
  statePath?: string
  defaultDirectory?: string
  legacyDirectory?: string
  legacyNotesPath?: string | null
  environment?: NodeJS.ProcessEnv
}

const VAULT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function validTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function validateAbsolutePath(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_PATH_LENGTH ||
    !isAbsolute(value) ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new NoteValidationError('Vault path must be an absolute path without control characters')
  }
  return value
}

function parseState(value: unknown): VaultState {
  if (!isRecord(value) || value.version !== 1 || typeof value.activeVaultId !== 'string' || !Array.isArray(value.vaults)) {
    throw new Error('Note vault state file has an invalid structure')
  }
  if (value.vaults.length === 0 || value.vaults.length > MAX_VAULTS) {
    throw new Error('Note vault state file has an invalid structure')
  }

  const ids = new Set<string>()
  const paths = new Set<string>()
  const vaults: StoredVault[] = []
  for (const candidate of value.vaults) {
    if (
      !isRecord(candidate) ||
      typeof candidate.id !== 'string' ||
      !VAULT_ID.test(candidate.id) ||
      ids.has(candidate.id) ||
      typeof candidate.path !== 'string' ||
      !isAbsolute(candidate.path) ||
      paths.has(candidate.path) ||
      !validTimestamp(candidate.lastOpenedAt)
    ) {
      throw new Error('Note vault state file has an invalid structure')
    }
    ids.add(candidate.id)
    paths.add(candidate.path)
    vaults.push({ id: candidate.id, path: candidate.path, lastOpenedAt: candidate.lastOpenedAt })
  }
  if (!ids.has(value.activeVaultId)) throw new Error('Note vault state file has an invalid active vault')
  return { version: 1, activeVaultId: value.activeVaultId, vaults }
}

export function defaultNoteVaultDirectory(): string {
  return join(homedir(), '.commando', 'notes-vaults', 'default')
}

export function defaultNoteVaultStatePath(): string {
  return join(homedir(), '.commando', 'note-vaults.json')
}

export function legacyDefaultNotesDirectory(): string {
  return join(homedir(), '.commando', 'notes')
}

export class NoteVaultManager {
  readonly statePath: string
  readonly defaultDirectory: string
  readonly legacyDirectory: string
  readonly legacyNotesPath: string | null
  readonly environment: NodeJS.ProcessEnv
  private initialization: Promise<void> | null = null
  private state: VaultState | null = null
  private stores = new Map<string, NoteStore>()
  private writes: Promise<void> = Promise.resolve()
  private migrationDirectory: string | null = null

  constructor(options: NoteVaultManagerOptions = {}) {
    this.statePath = options.statePath ?? defaultNoteVaultStatePath()
    this.defaultDirectory = options.defaultDirectory ?? defaultNoteVaultDirectory()
    this.legacyDirectory = options.legacyDirectory ?? legacyDefaultNotesDirectory()
    this.legacyNotesPath = options.legacyNotesPath === undefined ? defaultLegacyNotesPath() : options.legacyNotesPath
    this.environment = options.environment ?? process.env
  }

  async snapshot(): Promise<NoteVaultSnapshot> {
    await this.writes
    await this.ensureInitialized()
    return this.snapshotState()
  }

  async store(id?: string | null): Promise<NoteStore> {
    await this.writes
    await this.ensureInitialized()
    const vaultId = id || this.state!.activeVaultId
    const vault = this.state!.vaults.find((candidate) => candidate.id === vaultId)
    if (!vault) throw new NoteValidationError('Unknown note vault')
    await this.requireDirectory(vault.path)
    let store = this.stores.get(vault.path)
    if (!store) {
      store = new NoteStore({
        directory: vault.path,
        legacyPath: vault.path === this.migrationDirectory ? this.legacyNotesPath : null,
      })
      this.stores.set(vault.path, store)
    }
    return store
  }

  async browse(path?: unknown): Promise<NoteVaultBrowseResult> {
    await this.writes
    await this.ensureInitialized()
    const active = this.state!.vaults.find((vault) => vault.id === this.state!.activeVaultId)!
    const current = await this.canonicalBrowseDirectory(path === undefined || path === '' ? active.path : path)
    const home = await this.canonicalBrowseDirectory(homedir())
    let entries
    try {
      entries = await readdir(current, { withFileTypes: true })
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'EACCES' || code === 'EPERM') throw new NoteValidationError('Permission denied while reading this directory')
      throw error
    }
    if (entries.length > 5_000) throw new NoteValidationError('Directory contains too many entries')
    const directories = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => ({ name: entry.name, path: join(current, entry.name) }))
      .sort((left, right) => left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: 'base' }))
    const parent = dirname(current)
    return { path: current, parent: parent === current ? null : parent, home, directories }
  }

  open(path: unknown): Promise<NoteVaultSnapshot> {
    return this.mutate(async () => {
      this.activatePath(await this.canonicalDirectory(path))
      return this.snapshotState()
    })
  }

  create(path: unknown): Promise<NoteVaultSnapshot> {
    return this.mutate(async () => {
      const requested = validateAbsolutePath(path)
      if (parse(requested).root === requested) throw new NoteValidationError('Filesystem root cannot be used as a note vault')
      const parent = await realpath(dirname(requested)).catch(() => null)
      if (!parent) throw new NoteValidationError('The parent directory does not exist')
      const target = join(parent, basename(requested))
      try {
        await mkdir(target, { mode: 0o700 })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
          throw new NoteValidationError('The vault directory already exists; open it instead')
        }
        throw error
      }
      this.activatePath(await this.canonicalDirectory(target))
      return this.snapshotState()
    })
  }

  createIn(parent: unknown, name: unknown): Promise<NoteVaultSnapshot> {
    return this.mutate(async () => {
      if (
        typeof name !== 'string' ||
        name.length === 0 ||
        name.length > 128 ||
        name !== name.trim() ||
        name === '.' ||
        name === '..' ||
        name.includes('/') ||
        name.includes('\\') ||
        /[\u0000-\u001f\u007f]/.test(name)
      ) {
        throw new NoteValidationError('Vault name must be a valid folder name')
      }
      const canonicalParent = await this.canonicalBrowseDirectory(parent)
      const target = join(canonicalParent, name)
      try {
        await mkdir(target, { mode: 0o700 })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
          throw new NoteValidationError('The vault directory already exists; open it instead')
        }
        throw error
      }
      this.activatePath(await this.canonicalDirectory(target))
      return this.snapshotState()
    })
  }

  select(id: unknown): Promise<NoteVaultSnapshot> {
    return this.mutate(async () => {
      if (typeof id !== 'string' || !VAULT_ID.test(id)) throw new NoteValidationError('Invalid note vault id')
      const vault = this.state!.vaults.find((candidate) => candidate.id === id)
      if (!vault) throw new NoteValidationError('Unknown note vault')
      await this.requireDirectory(vault.path)
      vault.lastOpenedAt = Date.now()
      this.state!.activeVaultId = id
      this.sortAndLimit()
      return this.snapshotState()
    })
  }

  clearHistory(id: unknown): Promise<NoteVaultSnapshot> {
    return this.mutate(async () => {
      if (typeof id !== 'string' || !VAULT_ID.test(id)) throw new NoteValidationError('Invalid note vault id')
      const active = this.state!.vaults.find((vault) => vault.id === id)
      if (!active) throw new NoteValidationError('Unknown note vault')
      await this.requireDirectory(active.path)
      this.state!.activeVaultId = active.id
      this.state!.vaults = [active]
      return this.snapshotState()
    })
  }

  private mutate(task: () => Promise<NoteVaultSnapshot>): Promise<NoteVaultSnapshot> {
    const operation = this.writes.then(async () => {
      await this.ensureInitialized()
      const snapshot = await task()
      await this.writeState(this.state!)
      return snapshot
    })
    this.writes = operation.then(() => undefined, () => undefined)
    return operation
  }

  private ensureInitialized(): Promise<void> {
    this.initialization ??= this.initialize()
    return this.initialization
  }

  private async initialize(): Promise<void> {
    const stored = await this.readState()
    const configured = this.environment.COMMANDO_NOTES_DIR
    if (configured !== undefined) validateAbsolutePath(configured)

    if (stored) {
      this.state = stored
      if (configured !== undefined) {
        await mkdir(configured, { recursive: true, mode: 0o700 })
        const canonical = await this.canonicalDirectory(configured)
        this.migrationDirectory = canonical
        this.activatePath(canonical)
        await this.writeState(this.state)
      } else {
        this.migrationDirectory = await realpath(this.defaultDirectory).catch(() => null)
        const active = this.state.vaults.find((vault) => vault.id === this.state!.activeVaultId)
        if (!active || !(await this.directoryAvailable(active.path))) {
          const available = await this.firstAvailable(this.state.vaults)
          if (available) this.state.activeVaultId = available.id
          else await this.createDefaultVault()
          await this.writeState(this.state)
        }
      }
      return
    }

    let initialPath: string
    if (configured !== undefined) {
      await mkdir(configured, { recursive: true, mode: 0o700 })
      initialPath = await this.canonicalDirectory(configured)
    } else {
      const additionalLegacyPath = await this.migrateLegacyDirectory()
      await mkdir(this.defaultDirectory, { recursive: true, mode: 0o700 })
      initialPath = await this.canonicalDirectory(this.defaultDirectory)
      this.migrationDirectory = initialPath
      const vault: StoredVault = { id: randomUUID(), path: initialPath, lastOpenedAt: Date.now() }
      const vaults = [vault]
      if (additionalLegacyPath && additionalLegacyPath !== initialPath) {
        vaults.push({ id: randomUUID(), path: additionalLegacyPath, lastOpenedAt: Math.max(0, vault.lastOpenedAt - 1) })
      }
      this.state = { version: 1, activeVaultId: vault.id, vaults }
      await this.writeState(this.state)
      return
    }
    this.migrationDirectory = initialPath
    const vault: StoredVault = { id: randomUUID(), path: initialPath, lastOpenedAt: Date.now() }
    this.state = { version: 1, activeVaultId: vault.id, vaults: [vault] }
    await this.writeState(this.state)
  }

  private async createDefaultVault(): Promise<void> {
    await mkdir(this.defaultDirectory, { recursive: true, mode: 0o700 })
    const canonical = await this.canonicalDirectory(this.defaultDirectory)
    this.activatePath(canonical)
    this.migrationDirectory = canonical
  }

  private async migrateLegacyDirectory(): Promise<string | null> {
    if (await this.directoryAvailable(this.defaultDirectory)) {
      return await this.directoryAvailable(this.legacyDirectory)
        ? this.canonicalDirectory(this.legacyDirectory)
        : null
    }
    if (!(await this.directoryAvailable(this.legacyDirectory))) return null
    await mkdir(dirname(this.defaultDirectory), { recursive: true, mode: 0o700 })
    await rename(this.legacyDirectory, this.defaultDirectory)
    return null
  }

  private async canonicalDirectory(value: unknown): Promise<string> {
    const requested = validateAbsolutePath(value)
    const canonical = await realpath(requested).catch(() => null)
    if (!canonical) throw new NoteValidationError('Vault directory does not exist')
    if (parse(canonical).root === canonical) throw new NoteValidationError('Filesystem root cannot be used as a note vault')
    await this.requireDirectory(canonical)
    return canonical
  }

  private async canonicalBrowseDirectory(value: unknown): Promise<string> {
    const requested = validateAbsolutePath(value)
    const canonical = await realpath(requested).catch(() => null)
    if (!canonical) throw new NoteValidationError('Directory does not exist')
    await this.requireDirectory(canonical)
    return canonical
  }

  private async requireDirectory(path: string): Promise<void> {
    const info = await stat(path).catch(() => null)
    if (!info?.isDirectory()) throw new NoteValidationError('Vault directory is unavailable')
  }

  private async directoryAvailable(path: string): Promise<boolean> {
    const info = await stat(path).catch(() => null)
    return Boolean(info?.isDirectory())
  }

  private async firstAvailable(vaults: StoredVault[]): Promise<StoredVault | null> {
    for (const vault of [...vaults].sort((left, right) => right.lastOpenedAt - left.lastOpenedAt)) {
      if (await this.directoryAvailable(vault.path)) return vault
    }
    return null
  }

  private activatePath(path: string): void {
    const now = Date.now()
    let vault = this.state!.vaults.find((candidate) => candidate.path === path)
    if (vault) vault.lastOpenedAt = now
    else {
      vault = { id: randomUUID(), path, lastOpenedAt: now }
      this.state!.vaults.push(vault)
    }
    this.state!.activeVaultId = vault.id
    this.sortAndLimit()
  }

  private sortAndLimit(): void {
    this.state!.vaults.sort((left, right) => right.lastOpenedAt - left.lastOpenedAt || left.path.localeCompare(right.path))
    this.state!.vaults = this.state!.vaults.slice(0, MAX_VAULTS)
  }

  private async snapshotState(): Promise<NoteVaultSnapshot> {
    const vaults = await Promise.all(this.state!.vaults.map(async (vault) => ({
      ...vault,
      name: basename(vault.path) || vault.path,
      available: await this.directoryAvailable(vault.path),
    })))
    return { activeVaultId: this.state!.activeVaultId, vaults }
  }

  private async readState(): Promise<VaultState | null> {
    try {
      return parseState(JSON.parse(await readFile(this.statePath, 'utf8')) as unknown)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      if (error instanceof SyntaxError) throw new Error('Note vault state file contains invalid JSON', { cause: error })
      throw error
    }
  }

  private async writeState(state: VaultState): Promise<void> {
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
        try { await directoryHandle.sync() } finally { await directoryHandle.close() }
      } catch {
        // Directory fsync is not supported by every filesystem.
      }
    } catch (error) {
      await handle?.close().catch(() => undefined)
      await rm(temporaryPath, { force: true }).catch(() => undefined)
      throw error
    }
  }
}
