import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, normalize, resolve, sep } from 'node:path'

const MAX_ARTIFACT_DIRS = 16

/** Persisted registrations expire after a week — a review never runs that long. */
export const REDLINE_ARTIFACT_TTL_MS = 7 * 24 * 60 * 60 * 1_000

export function defaultRedlineArtifactStatePath(): string {
  return join(homedir(), '.commando', 'redline-artifacts.json')
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
    for (const [id, entry] of this.entries) {
      if (entry.dir === real) {
        // Same directory keeps its id (and its URLs) across re-registrations.
        entry.registeredAt = this.now()
        this.persist()
        return { id }
      }
    }
    if (this.entries.size >= MAX_ARTIFACT_DIRS) {
      throw new RedlineArtifactError(429, `At most ${MAX_ARTIFACT_DIRS} artifact directories can be registered`)
    }
    const id = randomBytes(8).toString('hex')
    this.entries.set(id, { dir: real, registeredAt: this.now() })
    this.persist()
    return { id }
  }

  unregister(id: string): boolean {
    const removed = this.entries.delete(id)
    if (removed) this.persist()
    return removed
  }

  /** Maps an artifact request path to an absolute file path, or null. */
  resolve(id: string, requestPath: string): string | null {
    const root = this.entries.get(id)?.dir
    if (!root) return null
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
    const artifacts = (parsed as { artifacts?: unknown }).artifacts
    if (!Array.isArray(artifacts)) return
    const cutoff = this.now() - REDLINE_ARTIFACT_TTL_MS
    for (const item of artifacts) {
      if (this.entries.size >= MAX_ARTIFACT_DIRS) break
      const { id, dir, registeredAt } = (item ?? {}) as Record<string, unknown>
      if (typeof id !== 'string' || !/^[0-9a-f]{16}$/.test(id)) continue
      if (typeof dir !== 'string' || !isAbsolute(dir)) continue
      if (typeof registeredAt !== 'number' || registeredAt < cutoff) continue
      // The directory must still pass the fresh-registration checks — a
      // moved or deleted artifact dir is dropped, never served blind.
      let real: string
      try {
        real = realpathSync(dir)
        if (!statSync(real).isDirectory()) continue
      } catch {
        continue
      }
      this.entries.set(id, { dir: real, registeredAt })
    }
    if (this.entries.size !== artifacts.length) this.persist()
  }

  private persist(): void {
    if (!this.statePath) return
    const artifacts = [...this.entries].map(([id, entry]) => ({
      id,
      dir: entry.dir,
      registeredAt: entry.registeredAt,
    }))
    mkdirSync(dirname(this.statePath), { recursive: true, mode: 0o700 })
    const tmp = `${this.statePath}.tmp`
    writeFileSync(tmp, JSON.stringify({ artifacts }, null, 2))
    renameSync(tmp, this.statePath)
  }
}
