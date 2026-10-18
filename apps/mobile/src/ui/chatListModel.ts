import type { AgentStatus, PaneMark, TmuxPane } from '@commando/protocol'
import { sessionIdentityForName, type SessionIdentities } from '@commando/session-identity'
import type { HostDaemonState } from '../daemon/state'
import type { ChatState } from '@commando/agent-chat'
import { buildSessionTree } from '../agents/selectors'

export type Attention = 'needs_input' | 'failed' | 'review' | 'working' | 'idle' | 'finished' | 'unknown'
export function paneAttention(status: AgentStatus | undefined, seenAt?: number): Attention {
  if (!status) return 'unknown'
  if (status.status === 'stale') return 'idle'
  if (status.status !== 'done') return status.status
  if (status.details?.recap?.outcome === 'done' && status.details.recap.declared) return 'finished'
  return status.settledAt !== undefined && status.settledAt > (seenAt ?? -Infinity) ? 'review' : 'idle'
}
// Mirrors src/sessionIndicator.ts: lower wins; marks sit between review and working.
const RANK: Record<Attention, number> = { needs_input: 0, failed: 1, review: 2, working: 4, idle: 5, finished: 6, unknown: 7 }
export function sessionIndicator(panes: readonly TmuxPane[], statuses: Record<string, AgentStatus>, marks: Record<string, PaneMark>, seen: Record<string, number> = {}, chats: Record<string, ChatState> = {}) {
  const candidates = panes.flatMap((pane) => {
    const attention = chatPaneAttention(statuses[pane.id], chats[pane.id], seen[pane.id])
    const mark = marks[pane.targetId]
    return [
      { rank: RANK[attention], attention, paneId: pane.id, mark: undefined as PaneMark | undefined },
      ...(mark ? [{ rank: mark.activityCount ? 3 : 3.5, attention, paneId: pane.id, mark }] : []),
    ]
  })
  return candidates.sort((a, b) => a.rank - b.rank)[0]
}
export function chatPaneAttention(status: AgentStatus | undefined, chat: ChatState | undefined, seenAt?: number): Attention {
  if (status || !chat) return paneAttention(status, seenAt)
  switch (chat.session.status) {
    case 'starting': case 'running': return 'working'
    case 'waiting': return 'needs_input'
    case 'error': return 'failed'
    case 'closed': return 'finished'
    default: return 'idle'
  }
}

// Mirrors shared/session-repositories.ts sessionRepo/repositoryContainers used by desktop Repo mode.
function repositoryGroups(state: HostDaemonState) {
  const snapshot = state.snapshot
  const groups = new Map<string, { id: string; name: string; sessions: ReturnType<typeof buildSessionTree>[number]['sessions'] }>()
  for (const node of buildSessionTree(snapshot).flatMap((group) => group.sessions)) {
    const windowOrder = new Map(node.session.windowIds.map((id, index) => [id, index]))
    const panes = (snapshot?.panes ?? []).filter((pane) => pane.sessionId === node.session.id).sort((a, b) =>
      (windowOrder.get(a.windowId) ?? Infinity) - (windowOrder.get(b.windowId) ?? Infinity) || a.index - b.index,
    )
    const counts = new Map<string, { repo: NonNullable<TmuxPane['repo']>; count: number }>()
    for (const pane of panes) {
      if (!pane.repo) continue
      const current = counts.get(pane.repo.root)
      counts.set(pane.repo.root, { repo: current?.repo ?? pane.repo, count: (current?.count ?? 0) + 1 })
    }
    const repo = panes[0]?.repo ?? [...counts.values()].sort((a, b) => b.count - a.count)[0]?.repo
    const id = repo ? `repo:${repo.root}` : 'no-repo'
    const group = groups.get(id) ?? { id, name: repo?.name ?? 'No repository', sessions: [] }
    group.sessions.push({ ...node, branch: repo?.branch })
    groups.set(id, group)
  }
  const compare = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: 'base' })
  return [...groups.values()].sort((a, b) => a.id === 'no-repo' ? 1 : b.id === 'no-repo' ? -1 : compare(a.name, b.name) || compare(a.id, b.id))
    .map((group) => ({ ...group, sessions: group.sessions.sort((a, b) => compare(a.session.name, b.session.name)) }))
}

export function buildChatGroups(state: HostDaemonState, chats: Record<string, ChatState> = {}, identities: SessionIdentities = {}, seen: Record<string, number> = {}) {
  const background: ReturnType<typeof buildSessionTree>[number]['sessions'] = []
  if (!state.snapshot) return []
  const repoGroups = repositoryGroups(state)
  const groups = repoGroups.map((group) => ({ ...group, sessions: group.sessions.filter((node) => {
    const panes = state.snapshot!.panes.filter((pane) => pane.sessionId === node.session.id)
    const root = panes.find((pane) => pane.repo?.worktreeRoot)?.repo?.worktreeRoot
    // Mirrors shared/auxiliary-session.ts and src/SessionTree.ts ownership checks.
    const auxiliary = /^(?:native_app|tilt)-(.+)$/u.exec(node.session.name)
    if (root && auxiliary?.[1] === root.replace(/\/+$/u, '').split('/').at(-1) && panes.every((pane) => pane.repo?.worktreeRoot === root && (pane.path === root || pane.path.startsWith(`${root}/`)))) {
      background.push(node)
      return false
    }
    return true
  }) })).filter((group) => group.sessions.length)
  if (background.length) groups.push({ id: 'background', name: 'Background', sessions: background })
  return groups.map((group) => ({ ...group, sessions: group.sessions.map((node) => {
    const panes = state.snapshot!.panes.filter((pane) => pane.sessionId === node.session.id)
    const agents = panes.filter((pane) => state.agentStatuses[pane.id] || chats[pane.id])
    const indicator = sessionIndicator(panes, state.agentStatuses, state.marks, seen, chats)
    const latest = [...agents].sort((a, b) => (state.briefs[b.id]?.updatedAt ?? state.agentStatuses[b.id]?.updatedAt ?? chats[b.id]?.items.at(-1)?.updatedAt ?? 0) - (state.briefs[a.id]?.updatedAt ?? state.agentStatuses[a.id]?.updatedAt ?? chats[a.id]?.items.at(-1)?.updatedAt ?? 0))[0]
    const status = latest ? state.agentStatuses[latest.id] : undefined
    const identity = sessionIdentityForName(identities, node.session.name)
    return { ...node, identity, indicator, agents, openPaneId: agents.length === 1 ? agents[0]!.id : agents.length === 0 ? panes[0]?.id : undefined,
      provider: latest ? chats[latest.id]?.session.provider ?? status?.provider : undefined,
      subtitle: (latest ? state.briefs[latest.id]?.headline : undefined) || status?.details?.currentActivity?.label || status?.summary || (latest ? chats[latest.id]?.session.title : undefined) || identity.codename,
      updatedAt: latest ? state.briefs[latest.id]?.updatedAt ?? status?.updatedAt ?? chats[latest.id]?.items.at(-1)?.updatedAt : undefined,
      pending: agents.some((pane) => state.agentStatuses[pane.id]?.details?.requests?.length || chats[pane.id]?.items.some((item) => item.kind === 'request' && item.status === 'running' && !item.answer)),
    }
  }) }))
}
