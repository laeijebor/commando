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

/** A session with nothing from its agents for this long is quiet: the sidebar dims it. */
export const QUIET_AFTER_MS = 2 * 86_400_000

export type SessionAttention = {
  /** The most urgent agent state across the session's panes, ignoring pane marks. */
  attention?: PaneAttention
  /** When any of the session's agents last did real work (daemon clock). */
  lastActivityAt?: number
  /** What a blocked or failed agent is waiting on, for a second line under the name. */
  reason?: string
}

function waitingOn(status: AgentStatus): string | undefined {
  const request = status.details?.requests?.[0]
  const text = request?.questions?.[0]?.question ?? request?.prompt ?? status.details?.attention ?? status.summary
  return text?.trim() || undefined
}

export function sessionAttention(
  panes: readonly { id: string; targetId: string }[],
  statuses: Readonly<Record<string, AgentStatus>>,
  seen: Readonly<Record<string, number>>,
  activity: Readonly<Record<string, number>>,
): SessionAttention {
  const indicator = sessionIndicator(panes, statuses, {}, seen)
  const attention = indicator?.kind === 'status' ? indicator.status : undefined
  const times = panes.flatMap((pane) => activity[pane.id] !== undefined ? [activity[pane.id]] : [])
  const status = indicator && (attention === 'needs_input' || attention === 'failed') ? statuses[indicator.paneId] : undefined
  return {
    ...(attention ? { attention } : {}),
    ...(times.length ? { lastActivityAt: Math.max(...times) } : {}),
    ...(status && waitingOn(status) ? { reason: waitingOn(status) } : {}),
  }
}

/** Blocked or failed agents need you; a turn that ended since you looked is unread. */
export const needsYou = (attention: PaneAttention | undefined) => attention === 'needs_input' || attention === 'failed'
export const isUnread = (attention: PaneAttention | undefined) => needsYou(attention) || attention === 'review'

/** Quiet sessions fade; anything blocked, unread or working stays at full strength. */
export function isQuiet(session: SessionAttention, now: number): boolean {
  if (isUnread(session.attention) || session.attention === 'working') return false
  return session.lastActivityAt !== undefined && now - session.lastActivityAt >= QUIET_AFTER_MS
}

/** A short age for the sidebar: now, 4m, 3h, 6d. */
export function compactAge(at: number, now: number): string {
  const elapsed = Math.max(0, now - at)
  if (elapsed < 60_000) return 'now'
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m`
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h`
  return `${Math.floor(elapsed / 86_400_000)}d`
}
