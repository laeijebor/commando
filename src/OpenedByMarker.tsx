import type { AgentStatus, TmuxPane } from '../shared/protocol'
import { chatParent, parentLabel, type LineageSnapshot } from './chatLineage'

export function OpenedByMarker({ pane, snapshot, statuses, onSelect, placement }: {
  pane: TmuxPane
  snapshot: LineageSnapshot
  statuses: Record<string, AgentStatus>
} & ({ placement: 'session'; onSelect?: never } | { placement: 'pane'; onSelect: (paneId: string) => void })) {
  const parent = chatParent(pane, snapshot)
  if (!parent || (parent.sessionId === pane.sessionId) !== (placement === 'pane')) return null
  const session = snapshot.sessions.find((session) => session.id === parent.sessionId)
  const title = `Opened by ${parentLabel(pane, snapshot, statuses)}`
  const label = `↳ ${session?.name ?? 'another agent'}`
  if (placement === 'session') return <span className="opened-by-marker" title={title}>{label}</span>
  return (
    <button type="button" className="opened-by-marker" title={title}
      onClick={(event) => { event.stopPropagation(); onSelect(parent.id) }}>
      {label}
    </button>
  )
}
