import type { AgentRow } from '../agents/selectors'
import { compareAgentRows } from '../agents/selectors'

export type FocusInputs = {
  /** Every agent row the host currently reports, in any order. */
  rows: readonly AgentRow[]
  /** What the cockpit is showing, if anything. */
  current?: string | undefined
  /** Panes the snapshot knows about, used when no agent reports on them. */
  paneIds?: readonly string[]
}

/**
 * Which pane the cockpit's centre column shows.
 *
 * A pane the owner picked stays picked for as long as it exists. Otherwise the
 * cockpit opens on whatever is most likely to need the owner: the oldest
 * Needs-you pane, then the busiest working pane, then anything at all — the
 * same ordering the attention inbox uses, so the highlighted row is the one at
 * the top of the list.
 */
export function chooseFocusedPane({ rows, current, paneIds = [] }: FocusInputs): string | undefined {
  if (current && (rows.some((row) => row.paneId === current) || paneIds.includes(current))) {
    return current
  }

  const sorted = rows.slice().sort(compareAgentRows)
  const needsYou = sorted.find((row) => row.group === 'needs_you')
  if (needsYou) return needsYou.paneId
  const working = sorted.find((row) => row.group === 'working')
  if (working) return working.paneId
  return sorted[0]?.paneId ?? paneIds[0]
}
