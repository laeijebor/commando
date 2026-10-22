import { lstat, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { isCommandoTargetId } from '../shared/pane-target.js'

/** A PR a pane is known to have created, so it stays listed when GitHub's search misses it. */
export type PanePrRef = { repo: string; number: number }
type StoredRef = PanePrRef & { at: number }

// The pane search shows 20 PRs, so older records would never be shown anyway.
const MAX_PER_TARGET = 20
const MAX_TARGETS = 500
const REPO_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})?\/[A-Za-z0-9._-]{1,100}$/

function sameRef(left: PanePrRef, right: PanePrRef): boolean {
  return left.number === right.number && left.repo.toLowerCase() === right.repo.toLowerCase()
}

export function isPanePrRef(value: unknown): value is PanePrRef {
  if (typeof value !== 'object' || value === null) return false
  const { repo, number } = value as Record<string, unknown>
  return typeof repo === 'string' && REPO_PATTERN.test(repo)
    && typeof number === 'number' && Number.isInteger(number) && number > 0
}

/**
 * Remembers which PRs each pane target created. Without a path it only lives
 * in memory; with one it survives daemon restarts.
 */
export class PanePrRecords {
  private readonly targets = new Map<string, StoredRef[]>()
  private readonly loaded: Promise<void>
  private writes: Promise<void> = Promise.resolve()

  constructor(private readonly path?: string, private readonly now: () => number = Date.now) {
    this.loaded = path ? this.load(path) : Promise.resolve()
  }

  async list(targetId: string): Promise<PanePrRef[]> {
    await this.loaded
    return (this.targets.get(targetId) ?? []).map(({ repo, number }) => ({ repo, number }))
  }

  /** Returns whether anything new was recorded. */
  async add(targetId: string, refs: readonly PanePrRef[]): Promise<boolean> {
    await this.loaded
    if (!isCommandoTargetId(targetId)) return false
    const current = this.targets.get(targetId) ?? []
    const added = refs.filter((ref, index) => isPanePrRef(ref)
      && !current.some((known) => sameRef(known, ref))
      && refs.findIndex((other) => sameRef(other, ref)) === index)
    if (!added.length) return false
    const at = this.now()
    const next = [...added.map(({ repo, number }) => ({ repo, number, at })), ...current].slice(0, MAX_PER_TARGET)
    this.targets.delete(targetId)
    this.targets.set(targetId, next)
    // Map order is least recently changed first.
    while (this.targets.size > MAX_TARGETS) this.targets.delete(this.targets.keys().next().value!)
    this.persist()
    return true
  }

  async remove(targetId: string, refs: readonly PanePrRef[]): Promise<void> {
    await this.loaded
    const current = this.targets.get(targetId)
    if (!current) return
    const next = current.filter((known) => !refs.some((ref) => sameRef(known, ref)))
    if (next.length === current.length) return
    if (next.length) this.targets.set(targetId, next)
    else this.targets.delete(targetId)
    this.persist()
  }

  /** Resolves once every queued write has settled; for tests and shutdown. */
  flushed(): Promise<void> { return this.writes }

  private async load(path: string): Promise<void> {
    try {
      const metadata = await lstat(path)
      if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error('pane PR records path must be a regular file')
      const parsed: unknown = JSON.parse(await readFile(path, 'utf8'))
      const targets = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>).targets : undefined
      if (typeof targets !== 'object' || targets === null) return
      for (const [targetId, refs] of Object.entries(targets)) {
        if (!isCommandoTargetId(targetId) || !Array.isArray(refs)) continue
        const valid = refs.filter((ref): ref is StoredRef => isPanePrRef(ref) && typeof (ref as StoredRef).at === 'number')
          .slice(0, MAX_PER_TARGET)
        if (valid.length) this.targets.set(targetId, valid)
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      // Records only add PRs back that search missed, so a bad file costs nothing but that.
      console.error('[commando] ignoring unreadable pane PR records', error)
    }
  }

  private persist(): void {
    const path = this.path
    if (!path) return
    this.writes = this.writes.then(async () => {
      await mkdir(dirname(path), { recursive: true })
      const temporary = `${path}.${process.pid}.tmp`
      await writeFile(temporary, `${JSON.stringify({ version: 1, targets: Object.fromEntries(this.targets) })}\n`, { mode: 0o600 })
      await rename(temporary, path)
    }).catch((error: unknown) => console.error('[commando] failed to save pane PR records', error))
  }
}
