import type { AgentStatus, TmuxPane, TmuxSession } from '../shared/protocol'
import type { SessionTreePreferences } from './sessionManagementApi'
import { sessionTreeContainers } from './sessionTreePreferences'

export const AGENT_HUD_DISMISSALS_STORAGE_KEY = 'commando.agent-hud.dismissed-updates'

const MAX_DISMISSALS = 500

const STATUS_PRIORITY: Record<AgentStatus['status'], number> = {
  needs_input: 0,
  failed: 1,
  working: 2,
  stale: 3,
  done: 4,
  unknown: 5,
}

export type AgentHudGroup = {
  id: string
  name: string
  statuses: AgentStatus[]
}

export type AgentHudDismissals = Record<string, number>
export type AgentHudFilter = 'working' | 'attention' | 'done'

export function agentNeedsAttention(status: AgentStatus): boolean {
  return status.status === 'needs_input' ||
    status.status === 'failed' ||
    status.details?.recap?.outcome === 'follow_up' ||
    status.details?.recap?.outcome === 'blocked' ||
    status.details?.recap?.outcome === 'failed'
}

export function agentMatchesHudFilter(status: AgentStatus, filter: AgentHudFilter): boolean {
  if (filter === 'attention') return agentNeedsAttention(status)
  return status.status === filter
}

export function filterAgentHudGroups(
  groups: readonly AgentHudGroup[],
  filter: AgentHudFilter | null,
): AgentHudGroup[] {
  if (!filter) return [...groups]
  return groups.flatMap((group) => {
    const statuses = group.statuses.filter((status) => agentMatchesHudFilter(status, filter))
    return statuses.length ? [{ ...group, statuses }] : []
  })
}

export function agentHudGroups(
  statuses: Record<string, AgentStatus>,
  panes: ReadonlyMap<string, TmuxPane>,
  sessions: readonly TmuxSession[],
  preferences: SessionTreePreferences,
  dismissedUpdates: Readonly<AgentHudDismissals> = {},
): AgentHudGroup[] {
  const containers = sessionTreeContainers(preferences, sessions)
  const sessionOrder = new Map(
    containers.flatMap((container) => (
      container.sessionIds.map((sessionId, index) => [sessionId, index] as const)
    )),
  )
  const containerBySession = new Map(
    containers.flatMap((container) => (
      container.sessionIds.map((sessionId) => [sessionId, container.id] as const)
    )),
  )
  const grouped = new Map(containers.map((container) => [container.id, [] as AgentStatus[]]))

  for (const status of Object.values(statuses)) {
    const pane = panes.get(status.paneId)
    if (!pane || dismissedUpdates[status.paneId] === status.updatedAt) continue
    const containerId = containerBySession.get(pane.sessionId)
    if (containerId) grouped.get(containerId)?.push(status)
  }

  return containers.flatMap((container) => {
    const containerStatuses = grouped.get(container.id) ?? []
    containerStatuses.sort((left, right) => {
      const attentionDifference = Number(agentNeedsAttention(right)) - Number(agentNeedsAttention(left))
      if (attentionDifference) return attentionDifference
      const leftPane = panes.get(left.paneId)
      const rightPane = panes.get(right.paneId)
      const sessionDifference = (sessionOrder.get(leftPane?.sessionId ?? '') ?? Number.MAX_SAFE_INTEGER) -
        (sessionOrder.get(rightPane?.sessionId ?? '') ?? Number.MAX_SAFE_INTEGER)
      if (sessionDifference) return sessionDifference
      const statusDifference = STATUS_PRIORITY[left.status] - STATUS_PRIORITY[right.status]
      if (statusDifference) return statusDifference
      return (leftPane?.index ?? Number.MAX_SAFE_INTEGER) -
        (rightPane?.index ?? Number.MAX_SAFE_INTEGER)
    })
    return containerStatuses.length
      ? [{ id: container.id, name: container.name, statuses: containerStatuses }]
      : []
  })
}

export function storedAgentHudDismissals(): AgentHudDismissals {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(AGENT_HUD_DISMISSALS_STORAGE_KEY) ?? '{}')
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    return Object.fromEntries(
      Object.entries(parsed)
        .filter((entry): entry is [string, number] => (
          Boolean(entry[0]) && typeof entry[1] === 'number' && Number.isFinite(entry[1]) && entry[1] >= 0
        ))
        .slice(-MAX_DISMISSALS),
    )
  } catch {
    return {}
  }
}

export function storeAgentHudDismissals(dismissals: AgentHudDismissals): void {
  try {
    const bounded = Object.fromEntries(Object.entries(dismissals).slice(-MAX_DISMISSALS))
    window.localStorage.setItem(AGENT_HUD_DISMISSALS_STORAGE_KEY, JSON.stringify(bounded))
  } catch {
    // Dismissal still works in memory when storage is unavailable.
  }
}
