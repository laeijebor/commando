import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { ClaudeProfile } from '../shared/tmux-create.js'
import { listClaudeProfiles, validClaudeConfigDir } from './tmux-create.js'

export function defaultClaudeProfileCachePath(): string {
  return process.env.COMMANDO_CLAUDE_PROFILE_CACHE_PATH ?? join(homedir(), '.commando', 'claude-profiles.json')
}

/** How long a scan stays fresh before a read starts another one in the background. */
const DEFAULT_MAX_AGE_MS = 30_000

/**
 * The Claude profiles found in the home folder, kept in memory and on disk. Scanning stats
 * thousands of transcripts, which stalls behind a busy daemon, so a read answers with the
 * last list straight away (also after a restart) and rescans in the background once stale.
 */
export class ClaudeProfileCache {
  private profiles: ClaudeProfile[] | undefined
  /** When the list in memory was scanned; never, for one read back from disk. */
  private scannedAt = Number.NEGATIVE_INFINITY
  private scanning: Promise<ClaudeProfile[]> | undefined
  private stored: Promise<ClaudeProfile[] | undefined> | undefined

  constructor(
    readonly path = defaultClaudeProfileCachePath(),
    private readonly home = homedir(),
    private readonly discover: (home: string) => Promise<ClaudeProfile[]> = listClaudeProfiles,
    private readonly maxAgeMs = DEFAULT_MAX_AGE_MS,
    private readonly now: () => number = Date.now,
  ) {}

  /** The last known list, refreshed in the background once stale; waits only when none is known. */
  async list(): Promise<ClaudeProfile[]> {
    this.profiles ??= await (this.stored ??= this.readStored())
    if (!this.profiles) return this.refresh()
    if (this.now() - this.scannedAt >= this.maxAgeMs) {
      this.refresh().catch((error: unknown) => console.warn('Unable to rescan Claude profiles', error))
    }
    return this.profiles
  }

  /** A fresh scan, shared by concurrent callers, then remembered and stored. */
  refresh(): Promise<ClaudeProfile[]> {
    this.scanning ??= this.discover(this.home).then((found) => {
      this.profiles = found
      this.scannedAt = this.now()
      this.store(found).catch((error: unknown) => console.warn('Unable to store Claude profiles', error))
      return found
    }).finally(() => { this.scanning = undefined })
    return this.scanning
  }

  private async readStored(): Promise<ClaudeProfile[] | undefined> {
    try {
      const value: unknown = JSON.parse(await readFile(this.path, 'utf8'))
      const entries = value && typeof value === 'object' && Array.isArray((value as { profiles?: unknown }).profiles)
        ? (value as { profiles: unknown[] }).profiles
        : undefined
      return entries?.flatMap((entry) => {
        const { name, configDir, lastUsedAt } = (entry ?? {}) as Partial<Record<keyof ClaudeProfile, unknown>>
        if (typeof name !== 'string' || typeof configDir !== 'string' || !validClaudeConfigDir(configDir, this.home)) return []
        return [{ name, configDir, ...(typeof lastUsedAt === 'number' ? { lastUsedAt } : {}) }]
      })
    } catch {
      // Missing or unreadable: the first read scans instead.
      return undefined
    }
  }

  private async store(profiles: ClaudeProfile[]): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
    const temporary = `${this.path}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, `${JSON.stringify({ profiles })}\n`, { mode: 0o600, flag: 'wx' })
      await rename(temporary, this.path)
    } finally { await rm(temporary, { force: true }) }
  }
}
