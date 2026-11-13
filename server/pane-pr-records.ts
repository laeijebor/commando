import { lstat, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { isCommandoTargetId } from '../shared/pane-target.js'
import type { PanePrImpact } from '../shared/pr-types.js'

/** A PR a pane is known to have created or impacted, so it stays listed when GitHub's search misses it. */
export type PanePrRef = { repo: string; number: number }
export type { PanePrImpact }
export type PanePrRelation = 'created' | PanePrImpact
/**
 * `at` is when the PR was first recorded; `createdAt` when GitHub says it was created, once known.
 * `impact` is the strongest way the pane touched the PR, last at `impactedAt`.
 * `created: false` marks a PR the pane only impacted; older files only held PRs the pane created.
 */
export type PanePrRecord = PanePrRef & {
  at: number
  createdAt?: number
  impact?: PanePrImpact
  impactedAt?: number
  created?: false
}

const IMPACT_STRENGTH: Record<PanePrImpact, number> = { commented: 1, reviewed: 2, pushed: 3 }

export function isPanePrImpact(value: unknown): value is PanePrImpact {
  return typeof value === 'string' && Object.hasOwn(IMPACT_STRENGTH, value)
}

/** How the pane relates to a recorded PR, for display. */
export function recordRelation(record: PanePrRecord): PanePrRelation {
  return record.created === false && record.impact ? record.impact : 'created'
}

/**
 * How new a record is: a created PR's creation time (or, before GitHub has shown it to us,
 * when it was recorded); an impacted PR's last push or comment.
 */
export function recordRecency(record: PanePrRecord): number {
  return record.created === false ? record.impactedAt ?? record.at : record.createdAt ?? record.at
}

// The pane search shows 20 PRs, so older created records would never be shown anyway.
// Impacted PRs are always looked up by number, so they get their own 20.
const MAX_PER_KIND = 20
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

/** Keeps the newest records of each kind, newest first; the sort is stable, so ties keep their order. */
function trimmed(records: readonly PanePrRecord[]): PanePrRecord[] {
  const counts = { created: 0, impacted: 0 }
  return [...records].sort((left, right) => recordRecency(right) - recordRecency(left))
    .filter((record) => ++counts[record.created === false ? 'impacted' : 'created'] <= MAX_PER_KIND)
}

function validRecord(value: unknown): value is PanePrRecord {
  if (!isPanePrRef(value)) return false
  const record = value as PanePrRecord
  const optionalNumber = (field: unknown) => field === undefined || (typeof field === 'number' && Number.isFinite(field))
  return typeof record.at === 'number' && optionalNumber(record.createdAt) && optionalNumber(record.impactedAt)
    && (record.impact === undefined || isPanePrImpact(record.impact))
    && (record.created === undefined || (record.created === false && record.impact !== undefined))
}

/**
 * Remembers which PRs each pane target created, pushed to, reviewed or commented
 * on. Without a path it only lives in memory; with one it survives daemon restarts.
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

  /**
   * Records PRs the pane created, or learns when known ones were created.
   * Returns whether a PR newly counts as created by the pane.
   */
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
      } else if (known[index].created === false) {
        // A PR the pane pushed to turns out to be its own; its marker gets a fresh grace period.
        const { created: _created, ...record } = known[index]
        known.splice(index, 1)
        fresh.push({ ...record, at, ...(createdAt === undefined ? {} : { createdAt }) })
      } else if (createdAt !== undefined && known[index].createdAt !== createdAt) {
        known[index] = { ...known[index], createdAt }
        learned = true
      }
    }
    // Keep the newest PRs, like the pane's search page, however hits arrive.
    // The sort is stable, so on a tie the PR recorded just now comes first.
    const next = trimmed([...fresh, ...known])
    // Older hits past the cap come back every poll; they change nothing.
    const kept = fresh.some((record) => next.includes(record))
    if (!kept && !learned) return false
    this.save(targetId, next)
    return kept
  }

  /**
   * Records that the pane pushed to, reviewed or commented on PRs, keeping each
   * PR's strongest impact and latest time. Returns whether one now shows differently.
   */
  async touch(targetId: string, refs: readonly PanePrRef[], impact: PanePrImpact): Promise<boolean> {
    await this.loaded
    const valid = refs.filter(isPanePrRef)
    if (!isCommandoTargetId(targetId) || !isPanePrImpact(impact) || !valid.length) return false
    const impactedAt = this.now()
    const records = [...this.targets.get(targetId) ?? []]
    const shown: PanePrRecord[] = []
    for (const ref of valid) {
      const index = records.findIndex((record) => sameRef(record, ref))
      const current = index === -1 ? undefined : records[index]
      const strongest = current?.impact && IMPACT_STRENGTH[current.impact] > IMPACT_STRENGTH[impact] ? current.impact : impact
      const record: PanePrRecord = current
        ? { ...current, impact: strongest, impactedAt }
        : { repo: ref.repo, number: ref.number, at: impactedAt, impact, impactedAt, created: false }
      if (index === -1) records.unshift(record)
      else records[index] = record
      if (!current || recordRelation(current) !== recordRelation(record)) shown.push(record)
    }
    const next = trimmed(records)
    this.save(targetId, next)
    return shown.some((record) => next.includes(record))
  }

  /** Records PRs found again by number, perhaps under a renamed repo, learning when they were created. */
  async learn(targetId: string, records: readonly PanePrRecord[]): Promise<void> {
    await this.loaded
    if (!isCommandoTargetId(targetId)) return
    const known = [...this.targets.get(targetId) ?? []]
    let changed = false
    for (const record of records) {
      if (!validRecord(record)) continue
      const index = known.findIndex((candidate) => sameRef(candidate, record))
      if (index === -1) known.push({ ...record })
      else if (record.createdAt === undefined || known[index].createdAt === record.createdAt) continue
      else known[index] = { ...known[index], createdAt: record.createdAt }
      changed = true
    }
    if (changed) this.save(targetId, trimmed(known))
  }

  /**
   * Drops the pane's claim to have created PRs whose marker is gone. A PR it
   * also pushed to or commented on stays, as impacted; any other is forgotten.
   */
  async disown(targetId: string, refs: readonly PanePrRef[]): Promise<void> {
    await this.loaded
    const current = this.targets.get(targetId)
    if (!current) return
    let changed = false
    const next = current.flatMap((record): PanePrRecord[] => {
      if (record.created === false || !refs.some((ref) => sameRef(record, ref))) return [record]
      changed = true
      return record.impact ? [{ ...record, created: false }] : []
    })
    if (changed) this.save(targetId, trimmed(next))
  }

  async remove(targetId: string, refs: readonly PanePrRef[]): Promise<void> {
    await this.loaded
    const current = this.targets.get(targetId)
    if (!current) return
    const next = current.filter((known) => !refs.some((ref) => sameRef(known, ref)))
    if (next.length === current.length) return
    this.save(targetId, next)
  }

  /** Resolves once every queued write has settled; for tests and shutdown. */
  flushed(): Promise<void> { return this.writes }

  private save(targetId: string, records: PanePrRecord[]): void {
    this.targets.delete(targetId)
    if (records.length) this.targets.set(targetId, records)
    // Map order is least recently changed first.
    while (this.targets.size > MAX_TARGETS) this.targets.delete(this.targets.keys().next().value!)
    this.persist()
  }

  private async load(path: string): Promise<void> {
    try {
      const metadata = await lstat(path)
      if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error('pane PR records path must be a regular file')
      const parsed: unknown = JSON.parse(await readFile(path, 'utf8'))
      const targets = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>).targets : undefined
      if (typeof targets !== 'object' || targets === null) return
      for (const [targetId, refs] of Object.entries(targets)) {
        if (!isCommandoTargetId(targetId) || !Array.isArray(refs)) continue
        // Version 1 files only hold created PRs, which read the same way here.
        const valid = trimmed(refs.filter(validRecord))
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
      await writeFile(temporary, `${JSON.stringify({ version: 2, targets: Object.fromEntries(this.targets) })}\n`, { mode: 0o600 })
      await rename(temporary, path)
    }).catch((error: unknown) => console.error('[commando] failed to save pane PR records', error))
  }
}
