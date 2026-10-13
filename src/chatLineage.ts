import type { AgentStatus, CommandoSnapshot, TmuxPane } from '../shared/protocol'

export type LineageSnapshot = Pick<CommandoSnapshot, 'panes' | 'sessions'>

export function chatParent(pane: TmuxPane, snapshot: LineageSnapshot): TmuxPane | undefined {
  if (!pane.openedBy) return undefined
  const parents = snapshot.panes.filter((candidate) => candidate.targetId === pane.openedBy)
  return parents.length === 1 ? parents[0] : undefined
}

export function parentLabel(pane: TmuxPane, snapshot: LineageSnapshot, statuses: Record<string, AgentStatus> = {}): string {
  const parent = chatParent(pane, snapshot)
  if (!parent) return 'another agent'
  const status = statuses[parent.id]
  if (status && status.provider !== 'unknown') {
    return status.agentSessionName ? `${status.provider} · ${status.agentSessionName}` : status.provider
  }
  return snapshot.sessions.find((session) => session.id === parent.sessionId)?.name || 'another agent'
}

export function stripTaskPreamble(text: string): string {
  const separator = text.indexOf('\n---\n')
  return separator === -1 ? text : text.slice(separator + 5)
}
