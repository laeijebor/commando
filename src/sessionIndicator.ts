import type { AgentStatus, PaneMark } from '../shared/protocol'

/**
 * What a pane's dot tells the user. `done` splits three ways: `finished` when
 * the agent declared all the work complete, `review` when the turn ended after
 * the user last looked at the pane, and `idle` once they have seen it.
 */
export type PaneAttention = 'needs_input' | 'failed' | 'review' | 'working' | 'idle' | 'finished' | 'unknown'

export const paneAttentionLabels: Record<PaneAttention, string> = {
  needs_input: 'blocked on you',
  failed: 'failed',
  review: 'to review',
  working: 'working',
  idle: 'idle',
  finished: 'finished',
  unknown: 'unknown',
}

export function paneAttention(status: AgentStatus, seenAt: number | undefined): PaneAttention {
  if (status.status === 'stale') return 'idle'
  if (status.status !== 'done') return status.status
  const recap = status.details?.recap
  if (recap?.outcome === 'done' && recap.declared) return 'finished'
  return status.settledAt !== undefined && status.settledAt > (seenAt ?? -Infinity) ? 'review' : 'idle'
}

export type SessionIndicator =
  | { kind: 'status'; paneId: string; status: PaneAttention }
  | { kind: 'mark'; paneId: string; mark: PaneMark }

// Lower wins. Agents that need you outrank a pane mark; a mark outranks routine agent states.
// Idle outranks finished so a session only shows finished once every agent in it is.
const attentionRank: Record<PaneAttention, number> = { needs_input: 0, failed: 1, review: 2, working: 4, idle: 5, finished: 6, unknown: 7 }
const markRank = (mark: PaneMark) => mark.activityCount ? 3 : 3.5

/** The single status-column indicator for a session row. Earlier panes win ties. */
export function sessionIndicator(
  panes: readonly { id: string; targetId: string }[],
  statuses: Readonly<Record<string, AgentStatus>>,
  marks: Readonly<Record<string, PaneMark>>,
  seen: Readonly<Record<string, number>> = {},
): SessionIndicator | null {
  const candidates: { rank: number; indicator: SessionIndicator }[] = []
  for (const pane of panes) {
    const status = statuses[pane.id]
    if (status) {
      const attention = paneAttention(status, seen[pane.id])
      candidates.push({ rank: attentionRank[attention], indicator: { kind: 'status', paneId: pane.id, status: attention } })
    }
    const mark = marks[pane.targetId]
    if (mark) candidates.push({ rank: markRank(mark), indicator: { kind: 'mark', paneId: pane.id, mark } })
  }
  const best = candidates.reduce<typeof candidates[number] | null>((current, candidate) => !current || candidate.rank < current.rank ? candidate : current, null)
  return best?.indicator ?? null
}
