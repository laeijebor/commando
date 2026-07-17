import type { TmuxSession } from '../shared/protocol'
import type { SessionTreePreferences } from './sessionManagementApi'

export const EMPTY_SESSION_TREE_PREFERENCES: SessionTreePreferences = {
  version: 1,
  groups: [],
  ungroupedSessionIds: [],
}

export type SessionTreeContainer = {
  id: string
  name: string
  sessionIds: string[]
  group: SessionTreePreferences['groups'][number] | null
}

export function sessionTreeContainers(
  preferences: SessionTreePreferences,
  sessions: readonly TmuxSession[],
): SessionTreeContainer[] {
  const containers: SessionTreeContainer[] = [
    ...preferences.groups.map((group) => ({
      id: group.id,
      name: group.name,
      sessionIds: [...group.sessionIds],
      group,
    })),
    {
      id: 'ungrouped',
      name: 'Ungrouped',
      sessionIds: [...preferences.ungroupedSessionIds],
      group: null,
    },
  ]
  const knownSessionIds = new Set(containers.flatMap((container) => container.sessionIds))
  const missingSessionIds = sessions
    .map((session) => session.id)
    .filter((sessionId) => !knownSessionIds.has(sessionId))
  containers[containers.length - 1].sessionIds.push(...missingSessionIds)
  return containers
}
