import type { AgentStatus, AgentStatusKind } from '../shared/protocol.js'
import { TURN_STATES } from './agent-status-registry.js'
import { PaneStore } from './pane-times.js'

/** A busy agent republishes often; clients only need its age to the minute. */
const PUBLISH_INTERVAL_MS = 60_000

/** `working` marks a pane that was mid-turn, so a restart can tell a turn ended while it was down. */
type Entry = { at?: number; working?: true }
const isEntry = (value: unknown): value is Entry => {
  if (!value || typeof value !== 'object') return false
  const { at, working } = value as Record<string, unknown>
  return (at === undefined || (typeof at === 'number' && Number.isFinite(at))) && (working === undefined || working === true)
}

/**
 * When each pane's agent last did real work: a hook-reported working state, the
 * end of any turn the registry counts as ending now (hooked or inferred,
 * including one a restart interrupted), or a turn recap (at its completion
 * time). Any other status first seen after a restart is not activity: an agent
 * re-reporting `done` on reconnect did nothing new. Saved to `path` when given,
 * so ages and the sidebar's quiet sessions survive restarts.
 */
export class PaneActivity {
  private readonly entries: PaneStore<Entry>
  private readonly kinds = new Map<string, AgentStatusKind>()
  private readonly published = new Map<string, number>()

  constructor(path?: string) { this.entries = new PaneStore(path, isEntry) }

  bindServer(serverId: string): boolean { return this.entries.bindServer(serverId) }
  get(paneId: string): number | undefined { return this.entries.get(paneId)?.at }
  has(paneId: string): boolean { return this.get(paneId) !== undefined }
  flush(): void { this.entries.flush() }

  snapshot(): Record<string, number> {
    return Object.fromEntries(Object.entries(this.entries.snapshot()).flatMap(([paneId, entry]) => entry.at === undefined ? [] : [[paneId, entry.at]]))
  }

  /**
   * When a `done` first seen in this daemon run should count as settled: the
   * last activity, unless the pane was mid-turn when the daemon stopped (that
   * turn ended while nobody was listening, so it ended just now).
   */
  settledAt(paneId: string): number | undefined {
    const entry = this.entries.get(paneId)
    return entry?.working || this.kinds.get(paneId) === 'working' ? undefined : entry?.at
  }

  /** Records a published status; returns the entry to broadcast, if any. */
  record(status: AgentStatus): Record<string, number> | null {
    const { paneId, status: kind, updatedAt } = status
    const previousKind = this.kinds.get(paneId)
    this.kinds.set(paneId, kind)
    const entry = this.entries.get(paneId) ?? {}
    // Any source: Codex reports its working state only through inference.
    // `unknown` and `stale` say nothing about the turn ending, so a pending one stays pending.
    const working = kind === 'working' || ((kind === 'unknown' || kind === 'stale') && entry.working === true)
    // Wherever the registry settles a turn now (`settle()`), from any source, the
    // saved time must say now too, or the next restart reads the turn as seen: a
    // working turn the first settling state ends (including one a restart
    // interrupted), and a `done` after any state a turn is still in.
    const endsPendingTurn = entry.working === true && !working
    const endsTurn = kind === 'done' && previousKind !== undefined && TURN_STATES.has(previousKind)
    const at = endsPendingTurn || endsTurn ? updatedAt
      : status.source !== 'hook' ? undefined
        : kind === 'working' || previousKind === 'working' ? updatedAt : status.details?.recap?.completedAt
    const advances = at !== undefined && at > (entry.at ?? -Infinity)
    if (advances || working !== (entry.working === true)) {
      this.entries.set(paneId, { ...(advances ? { at } : entry.at !== undefined ? { at: entry.at } : {}), ...(working ? { working: true as const } : {}) })
    }
    if (!advances) return null
    const lastPublished = this.published.get(paneId)
    if (kind === previousKind && lastPublished !== undefined && at - lastPublished < PUBLISH_INTERVAL_MS) return null
    this.published.set(paneId, at)
    return { [paneId]: at }
  }

  /** Fills in a pane with no record yet, e.g. from its transcript's modification time. */
  seed(paneId: string, at: number): Record<string, number> | null {
    if (this.has(paneId) || !Number.isFinite(at)) return null
    this.entries.set(paneId, { ...this.entries.get(paneId), at })
    this.published.set(paneId, at)
    return { [paneId]: at }
  }

  /** The pane's agent is gone: whatever turn it was in will not end. */
  forget(paneId: string): void {
    this.kinds.delete(paneId)
    const entry = this.entries.get(paneId)
    if (entry?.working) this.entries.set(paneId, entry.at === undefined ? {} : { at: entry.at })
  }
}
