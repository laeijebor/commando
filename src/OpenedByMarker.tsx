import { CornerDownRight } from 'lucide-react'
import type { AgentStatus, TmuxPane } from '../shared/protocol'
import { chatParent, parentLabel, type LineageSnapshot } from './chatLineage'

/** Session-row glyph for a session another agent opened; jumps to the parent pane. */
export function OpenedByMarker({ pane, snapshot, statuses, onSelect }: {
  pane: TmuxPane
  snapshot: LineageSnapshot
  statuses: Record<string, AgentStatus>
  onSelect: (paneId: string) => void
}) {
  const parent = chatParent(pane, snapshot)
  if (!parent || parent.sessionId === pane.sessionId) return null
  const session = snapshot.sessions.find((candidate) => candidate.id === parent.sessionId)
  const opener = parentLabel(pane, snapshot, statuses)
  const label = `Opened by ${opener}${session && session.name !== opener ? ` in ${session.name}` : ''}`
  return (
    <button type="button" className="opened-by-marker" aria-label={label} title={label}
      onClick={(event) => { event.stopPropagation(); onSelect(parent.id) }}>
      <CornerDownRight />
    </button>
  )
}
