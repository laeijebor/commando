import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, normalize, resolve, sep } from 'node:path'

const MAX_ARTIFACT_DIRS = 16

/** Persisted registrations expire after a week — a review never runs that long. */
export const REDLINE_ARTIFACT_TTL_MS = 7 * 24 * 60 * 60 * 1_000

export function defaultRedlineArtifactStatePath(port: number): string {
  return join(homedir(), '.commando', `redline-artifacts-${port}.json`)
}

export class RedlineArtifactError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

type RegistryOptions = {
  /** Where registrations persist across daemon restarts; omit for in-memory only. */
  statePath?: string
  now?: () => number
}

type Entry = { dir: string; registeredAt: number }

/**
 * Registry of directories the daemon serves as redline artifacts. Ids are
 * unguessable; resolution is strictly confined to the registered directory —
 * normalized paths AND realpaths must stay inside it, so neither `..`
 * segments nor symlinks can escape. With a statePath, registrations survive
 * daemon restarts (same id keeps serving); entries whose directory vanished
 * or whose ttl lapsed are dropped on load, and every surviving entry is
 * re-validated through the same realpath checks as a fresh registration.
 */
export class RedlineArtifactRegistry {
  private readonly entries = new Map<string, Entry>()
  private readonly statePath: string | null
  private readonly now: () => number

  constructor(options: RegistryOptions = {}) {
    this.statePath = options.statePath ?? null
    this.now = options.now ?? Date.now
    this.load()
  }

  register(dir: string): { id: string } {
    if (typeof dir !== 'string' || !isAbsolute(dir)) {
      throw new RedlineArtifactError(400, 'dir must be an absolute path')
    }
    let real: string
    try {
      real = realpathSync(dir)
    } catch {
      throw new RedlineArtifactError(404, 'dir does not exist')
    }
    if (!statSync(real).isDirectory()) {
      throw new RedlineArtifactError(400, 'dir must be a directory')
    }
    const registeredAt = this.now()
    const cutoff = registeredAt - REDLINE_ARTIFACT_TTL_MS
    const nextEntries = new Map([...this.entries].filter(([, entry]) => entry.registeredAt >= cutoff))
    for (const [id, entry] of nextEntries) {
      if (entry.dir === real) {
        // Same directory keeps its id (and its URLs) across re-registrations.
        nextEntries.set(id, { ...entry, registeredAt })
        this.commit(nextEntries)
        return { id }
      }
    }
    if (nextEntries.size >= MAX_ARTIFACT_DIRS) {
      throw new RedlineArtifactError(429, `At most ${MAX_ARTIFACT_DIRS} artifact directories can be registered`)
    }
    let id: string
    do {
      id = randomBytes(8).toString('hex')
    } while (this.entries.has(id))
    nextEntries.set(id, { dir: real, registeredAt })
    this.commit(nextEntries)
    return { id }
  }

  unregister(id: string): boolean {
    if (!this.entries.has(id)) return false
    const nextEntries = new Map(this.entries)
    nextEntries.delete(id)
    this.commit(nextEntries)
    return true
  }

  /** Maps an artifact request path to an absolute file path, or null. */
  resolve(id: string, requestPath: string): string | null {
    const entry = this.entries.get(id)
    if (!entry || entry.registeredAt < this.now() - REDLINE_ARTIFACT_TTL_MS) return null
    const root = entry.dir
    let decoded: string
    try {
      decoded = decodeURIComponent(requestPath)
    } catch {
      return null
    }
    if (decoded.includes('\0') || isAbsolute(decoded)) return null
    const relative = decoded === '' || decoded.endsWith('/') ? `${decoded}index.html` : decoded
    const normalized = normalize(relative)
    if (normalized === '..' || normalized.startsWith(`..${sep}`)) return null
    const candidate = resolve(root, normalized)
    if (candidate !== root && !candidate.startsWith(root + sep)) return null
    let real: string
    try {
      real = realpathSync(candidate)
    } catch {
      return null
    }
    if (real !== root && !real.startsWith(root + sep)) return null
    try {
      if (!statSync(real).isFile()) return null
    } catch {
      return null
    }
    return real
  }

  private load(): void {
    if (!this.statePath) return
    let raw: string
    try {
      raw = readFileSync(this.statePath, 'utf8')
    } catch {
      return
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return
    }
    if (typeof parsed !== 'object' || parsed === null) return
    const artifacts = (parsed as { artifacts?: unknown }).artifacts
    if (!Array.isArray(artifacts)) return
    const now = this.now()
    const cutoff = now - REDLINE_ARTIFACT_TTL_MS
    const candidates: Array<[string, Entry]> = []
    let dirty = false
    for (const item of artifacts) {
      const { id, dir, registeredAt } = (item ?? {}) as Record<string, unknown>
      if (typeof id !== 'string' || !/^[0-9a-f]{16}$/.test(id)) {
        dirty = true
        continue
      }
      if (typeof dir !== 'string' || !isAbsolute(dir)) {
        dirty = true
        continue
      }
      if (typeof registeredAt !== 'number' || !Number.isFinite(registeredAt) || registeredAt < cutoff) {
        dirty = true
        continue
      }
      const clampedRegisteredAt = Math.min(registeredAt, now)
      if (clampedRegisteredAt !== registeredAt) dirty = true
      // Persisted paths are canonical; a changed realpath means the directory
      // was rebound and the old capability must not follow it.
      let real: string
      try {
        real = realpathSync(dir)
        if (real !== dir || !statSync(real).isDirectory()) {
          dirty = true
          continue
        }
      } catch {
        dirty = true
        continue
      }
      candidates.push([id, { dir: real, registeredAt: clampedRegisteredAt }])
    }
    candidates.sort(([, a], [, b]) => b.registeredAt - a.registeredAt)
    const dirs = new Set<string>()
    for (const [id, entry] of candidates) {
      if (this.entries.has(id) || dirs.has(entry.dir) || this.entries.size >= MAX_ARTIFACT_DIRS) {
        dirty = true
        continue
      }
      this.entries.set(id, entry)
      dirs.add(entry.dir)
    }
    if (dirty) this.persist(this.entries)
  }

  private commit(entries: ReadonlyMap<string, Entry>): void {
    this.persist(entries)
    this.entries.clear()
    for (const [id, entry] of entries) this.entries.set(id, entry)
  }

  private persist(entries: Iterable<[string, Entry]>): void {
    if (!this.statePath) return
    const artifacts = [...entries].map(([id, entry]) => ({
      id,
      dir: entry.dir,
      registeredAt: entry.registeredAt,
    }))
    mkdirSync(dirname(this.statePath), { recursive: true, mode: 0o700 })
    const tmp = `${this.statePath}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify({ artifacts }, null, 2), { mode: 0o600 })
    renameSync(tmp, this.statePath)
  }
}
