import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { ClaudeProfile } from '../shared/tmux-create.js'
import { listClaudeProfiles, validClaudeConfigDir } from './tmux-create.js'

export function defaultClaudeProfileCachePath(): string {
  return process.env.COMMANDO_CLAUDE_PROFILE_CACHE_PATH ?? join(homedir(), '.commando', 'claude-profiles.json')
}

/** How long a scan stays fresh before a read rescans. */
const DEFAULT_MAX_AGE_MS = 30_000
/** How long a stale read waits for its rescan (so recent use counts) before answering from the cache. */
const DEFAULT_STALE_WAIT_MS = 750

/**
 * The Claude profiles found in the home folder, kept in memory and on disk. Scanning stats
 * thousands of transcripts, which stalls behind a busy daemon, so a read answers with the
 * last list (also after a restart) once its rescan takes longer than a moment.
 */
export class ClaudeProfileCache {
  private profiles: ClaudeProfile[] | undefined
  /** When the list in memory was scanned; never, for one read back from disk. */
  private scannedAt = Number.NEGATIVE_INFINITY
  private scanning: Promise<ClaudeProfile[]> | undefined
  /** One more scan, after the running one, for callers that need to see a change made since it began. */
  private queued: Promise<ClaudeProfile[]> | undefined
  private stored: Promise<ClaudeProfile[] | undefined> | undefined
  private storing: Promise<void> = Promise.resolve()

  constructor(
    readonly path = defaultClaudeProfileCachePath(),
    private readonly home = homedir(),
    private readonly discover: (home: string) => Promise<ClaudeProfile[]> = listClaudeProfiles,
    private readonly maxAgeMs = DEFAULT_MAX_AGE_MS,
    private readonly now: () => number = Date.now,
    private readonly staleWaitMs = DEFAULT_STALE_WAIT_MS,
  ) {}

  /** The last known list; once stale, the rescan's result if it lands within a moment. Waits only when none is known. */
  async list(): Promise<ClaudeProfile[]> {
    const stored = await (this.stored ??= this.readStored())
    // A scan may have finished during the read; it beats the stored copy.
    this.profiles ??= stored
    if (!this.profiles) return this.scan()
    if (this.now() - this.scannedAt < this.maxAgeMs) return this.profiles
    const rescan = this.scan()
    rescan.catch((error: unknown) => console.warn('Unable to rescan Claude profiles', error))
    let wait: NodeJS.Timeout | undefined
    const cached = this.profiles
    return Promise.race([
      rescan.catch(() => cached),
      new Promise<ClaudeProfile[]>((resolve) => { wait = setTimeout(() => resolve(cached), this.staleWaitMs) }),
    ]).finally(() => clearTimeout(wait))
  }

  /** A scan that starts after this call, so it sees any change made before it; shared by concurrent callers. */
  refresh(): Promise<ClaudeProfile[]> {
    if (this.queued) return this.queued
    if (!this.scanning) return this.scan()
    this.queued = this.scanning.catch(() => undefined).then(() => {
      this.queued = undefined
      return this.scan()
    })
    return this.queued
  }

  /** Resolves once scans and stores under way have finished. */
  async idle(): Promise<void> {
    await this.queued?.catch(() => undefined)
    await this.scanning?.catch(() => undefined)
    await this.storing
  }

  /** The running scan, else a new one; remembered and stored when it finishes. */
  private scan(): Promise<ClaudeProfile[]> {
    this.scanning ??= this.discover(this.home).then((found) => {
      this.profiles = found
      this.scannedAt = this.now()
      // Queued, so overlapping stores land in scan order.
      this.storing = this.storing.then(() => this.store(found)).catch((error: unknown) => console.warn('Unable to store Claude profiles', error))
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
