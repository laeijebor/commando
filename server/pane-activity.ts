import type { AgentStatus, AgentStatusKind } from '../shared/protocol.js'
import { PaneTimes } from './pane-times.js'

/** A busy agent republishes often; clients only need its age to the minute. */
const PUBLISH_INTERVAL_MS = 60_000

/**
 * When each pane's agent last did real work: a hook-reported working state, the
 * end of one, or a turn recap (at its completion time). Any other status first
 * seen after a restart is not activity: an agent re-reporting `done` on
 * reconnect did nothing new. Saved to `path` when given, so ages and the
 * sidebar's quiet sessions survive restarts.
 */
export class PaneActivity {
  private readonly at: PaneTimes
  private readonly kinds = new Map<string, AgentStatusKind>()
  private readonly published = new Map<string, number>()

  constructor(path?: string) { this.at = new PaneTimes(path) }

  get(paneId: string): number | undefined { return this.at.get(paneId) }
  has(paneId: string): boolean { return this.at.has(paneId) }
  snapshot(): Record<string, number> { return this.at.snapshot() }
  flush(): void { this.at.flush() }

  /** Records a published status; returns the entry to broadcast, if any. */
  record(status: AgentStatus): Record<string, number> | null {
    const { paneId, status: kind, updatedAt } = status
    const previousKind = this.kinds.get(paneId)
    this.kinds.set(paneId, kind)
    if (status.source !== 'hook') return null
    const at = kind === 'working' || previousKind === 'working' ? updatedAt : status.details?.recap?.completedAt
    if (at === undefined || at <= (this.at.get(paneId) ?? -Infinity)) return null
    this.at.set(paneId, at)
    const lastPublished = this.published.get(paneId)
    if (kind === previousKind && lastPublished !== undefined && at - lastPublished < PUBLISH_INTERVAL_MS) return null
    this.published.set(paneId, at)
    return { [paneId]: at }
  }

  /** Fills in a pane with no record yet, e.g. from its transcript's modification time. */
  seed(paneId: string, at: number): Record<string, number> | null {
    if (this.at.has(paneId) || !Number.isFinite(at)) return null
    this.at.set(paneId, at)
    this.published.set(paneId, at)
    return { [paneId]: at }
  }

  forget(paneId: string): void { this.kinds.delete(paneId) }
}
