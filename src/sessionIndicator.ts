import type { AgentStatus, PaneMark } from '../shared/protocol'

export type SessionIndicator =
  | { kind: 'status'; paneId: string; status: AgentStatus['status'] }
  | { kind: 'mark'; paneId: string; mark: PaneMark }

// Lower wins. Agents that need you outrank a pane mark; a mark outranks routine agent states.
const statusRank: Record<AgentStatus['status'], number> = { needs_input: 0, failed: 1, working: 3, done: 4, stale: 5, unknown: 6 }
const markRank = (mark: PaneMark) => mark.activityCount ? 2 : 2.5

/** The single status-column indicator for a session row. Earlier panes win ties. */
export function sessionIndicator(
  panes: readonly { id: string; targetId: string }[],
  statuses: Readonly<Record<string, AgentStatus>>,
  marks: Readonly<Record<string, PaneMark>>,
): SessionIndicator | null {
  const candidates: { rank: number; indicator: SessionIndicator }[] = []
  for (const pane of panes) {
    const status = statuses[pane.id]
    if (status) candidates.push({ rank: statusRank[status.status], indicator: { kind: 'status', paneId: pane.id, status: status.status } })
    const mark = marks[pane.targetId]
    if (mark) candidates.push({ rank: markRank(mark), indicator: { kind: 'mark', paneId: pane.id, mark } })
  }
  const best = candidates.reduce<typeof candidates[number] | null>((current, candidate) => !current || candidate.rank < current.rank ? candidate : current, null)
  return best?.indicator ?? null
}
