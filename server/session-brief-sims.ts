import type { PaneRepo, SessionBrief, TmuxPane } from '../shared/protocol.js'
import type { SimLease } from './sim-leases.js'

/** Client-only projection: neither claims nor empty fallback briefs enter the store. */
export function withSimulatorClaim(
  brief: SessionBrief | null,
  pane: Pick<TmuxPane, 'id' | 'targetId' | 'sessionId'>,
  sessionName: string,
  lease?: SimLease & { idle: boolean },
  repo?: PaneRepo,
): SessionBrief {
  const base: SessionBrief = brief ?? {
    paneId: pane.id, targetId: pane.targetId, sessionId: pane.sessionId, sessionName,
    state: 'unknown', headline: 'Pane worklog', headlineSource: 'hook', updates: [], updatedAt: 0,
  }
  const { simulator: _previousClaim, ...content } = base
  if (!lease) return content
  const branch = lease.branchOverride ?? repo?.branch
  return { ...content, simulator: {
    udid: lease.udid, label: lease.label, task: lease.task, sessionName: lease.sessionName,
    ...(branch !== undefined ? { branch } : {}), ports: lease.ports.map((port) => ({ ...port })), idle: lease.idle,
  } }
}
