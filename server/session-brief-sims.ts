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

/** Resolve once for the whole client payload: parallel per-pane lookups prune each other's repo cache. */
export async function assembleClientSessionBriefs(
  storedBriefs: SessionBrief[],
  dependencies: {
    panes: TmuxPane[]
    leases: () => Array<SimLease & { idle: boolean }>
    resolveRepos: (paths: string[]) => Promise<Map<string, PaneRepo | undefined>>
  },
  includeLeaseOnly = true,
): Promise<SessionBrief[]> {
  const { panes, resolveRepos } = dependencies
  const repos = await resolveRepos(panes.map((pane) => pane.path))
  const leases = dependencies.leases()
  const briefs = new Map(storedBriefs.map((brief) => [brief.paneId, brief]))
  if (includeLeaseOnly) {
    for (const lease of leases) {
      const pane = panes.find((candidate) => candidate.id === lease.paneId)
      if (pane && !briefs.has(pane.id)) briefs.set(pane.id, withSimulatorClaim(null, pane, lease.sessionName))
    }
  }
  return [...briefs.values()].map((brief) => {
    const pane = panes.find((candidate) => candidate.id === brief.paneId)
    if (!pane) return brief
    const lease = leases.find((entry) => entry.paneId === pane.id)
    return withSimulatorClaim(brief, pane, brief.sessionName, lease, repos.get(pane.path) ?? pane.repo)
  })
}
