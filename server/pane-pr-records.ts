import { lstat, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { isCommandoTargetId } from '../shared/pane-target.js'

/** A PR a pane is known to have created, so it stays listed when GitHub's search misses it. */
export type PanePrRef = { repo: string; number: number }
/** `at` is when the PR was first recorded; `createdAt` when GitHub says it was created, once known. */
export type PanePrRecord = PanePrRef & { at: number; createdAt?: number }

/** How new a record's PR is: its creation time, or for a PR GitHub hasn't shown us yet, when it was recorded. */
export function recordRecency(record: PanePrRecord): number {
  return record.createdAt ?? record.at
}

// The pane search shows 20 PRs, so older records would never be shown anyway.
const MAX_PER_TARGET = 20
const MAX_TARGETS = 500
// GraphQL's Int is 32-bit; a larger number would fail the whole lookup query.
const MAX_PR_NUMBER = 2_147_483_647
const REPO_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})?\/[A-Za-z0-9._-]{1,100}$/

export function defaultPanePrRecordsPath(port: number): string {
  return process.env.COMMANDO_PANE_PRS_PATH ?? join(homedir(), '.commando', `pane-prs-${port}.json`)
}

function sameRef(left: PanePrRef, right: PanePrRef): boolean {
  return left.number === right.number && left.repo.toLowerCase() === right.repo.toLowerCase()
}

export function isPanePrRef(value: unknown): value is PanePrRef {
  if (typeof value !== 'object' || value === null) return false
  const { repo, number } = value as Record<string, unknown>
  return typeof repo === 'string' && REPO_PATTERN.test(repo)
    && typeof number === 'number' && Number.isInteger(number) && number > 0 && number <= MAX_PR_NUMBER
}

/**
 * Remembers which PRs each pane target created. Without a path it only lives
 * in memory; with one it survives daemon restarts.
 */
export class PanePrRecords {
  private readonly targets = new Map<string, PanePrRecord[]>()
  private readonly loaded: Promise<void>
  private writes: Promise<void> = Promise.resolve()

  constructor(private readonly path?: string, private readonly now: () => number = Date.now) {
    this.loaded = path ? this.load(path) : Promise.resolve()
  }

  async list(targetId: string): Promise<PanePrRecord[]> {
    await this.loaded
    return (this.targets.get(targetId) ?? []).map((ref) => ({ ...ref }))
  }

  /** Records PRs, or learns when known ones were created. Returns whether a new PR was recorded. */
  async add(targetId: string, refs: readonly (PanePrRef & { createdAt?: number })[]): Promise<boolean> {
    await this.loaded
    if (!isCommandoTargetId(targetId)) return false
    const at = this.now()
    const known = [...this.targets.get(targetId) ?? []]
    const fresh: PanePrRecord[] = []
    let learned = false
    for (const ref of refs) {
      if (!isPanePrRef(ref)) continue
      const createdAt = typeof ref.createdAt === 'number' && Number.isFinite(ref.createdAt) ? ref.createdAt : undefined
      const index = known.findIndex((record) => sameRef(record, ref))
      if (index === -1) {
        if (fresh.some((record) => sameRef(record, ref))) continue
        fresh.push({ repo: ref.repo, number: ref.number, at, ...(createdAt === undefined ? {} : { createdAt }) })
      } else if (createdAt !== undefined && known[index].createdAt !== createdAt) {
        known[index] = { ...known[index], createdAt }
        learned = true
      }
    }
    // Keep the newest PRs, like the pane's search page, however hits arrive.
    // The sort is stable, so on a tie the PR recorded just now comes first.
    const next = [...fresh, ...known].sort((left, right) => recordRecency(right) - recordRecency(left)).slice(0, MAX_PER_TARGET)
    // Older hits past the cap come back every poll; they change nothing.
    const kept = fresh.some((record) => next.includes(record))
    if (!kept && !learned) return false
    this.targets.delete(targetId)
    this.targets.set(targetId, next)
    // Map order is least recently changed first.
    while (this.targets.size > MAX_TARGETS) this.targets.delete(this.targets.keys().next().value!)
    this.persist()
    return kept
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
        const valid = refs.filter((ref): ref is PanePrRecord => isPanePrRef(ref) && typeof (ref as PanePrRecord).at === 'number'
          && ((ref as PanePrRecord).createdAt === undefined || typeof (ref as PanePrRecord).createdAt === 'number'))
          .sort((left, right) => recordRecency(right) - recordRecency(left))
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
