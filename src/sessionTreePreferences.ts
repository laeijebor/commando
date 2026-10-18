import type { PaneRepo, TmuxPane, TmuxSession } from '../shared/protocol'
import { repositoryContainers } from '../shared/session-repositories'
import type { SessionGroupingMode, SessionTreePreferences } from './sessionManagementApi'

export { sessionRepo } from '../shared/session-repositories'

export const EMPTY_SESSION_TREE_PREFERENCES: SessionTreePreferences = {
  version: 1,
  groups: [],
  ungroupedSessionIds: [],
}

export const DEFAULT_GROUPING_MODE: SessionGroupingMode = 'repository'

export type SessionTreeContainerKind = 'manual' | 'ungrouped' | 'repository' | 'no-repo' | 'auxiliary'

export type SessionTreeContainer = {
  id: string
  kind: SessionTreeContainerKind
  name: string
  sessionIds: string[]
  group: SessionTreePreferences['groups'][number] | null
  /** Repository behind a `repository` container. */
  repo?: Pick<PaneRepo, 'root' | 'name' | 'defaultBranch'>
  /** Branch per session when it differs from the repository default (repository mode only). */
  sessionBranches?: Record<string, string>
}

export type SessionTreeContainerOptions = {
  mode: SessionGroupingMode
  panes: readonly TmuxPane[]
}

function manualContainers(
  preferences: SessionTreePreferences,
  sessions: readonly TmuxSession[],
): SessionTreeContainer[] {
  const containers: SessionTreeContainer[] = [
    ...preferences.groups.map((group) => ({
      id: group.id,
      kind: 'manual' as const,
      name: group.name,
      sessionIds: [...group.sessionIds],
      group,
    })),
    {
      id: 'ungrouped',
      kind: 'ungrouped',
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

export function sessionTreeContainers(
  preferences: SessionTreePreferences,
  sessions: readonly TmuxSession[],
  options: SessionTreeContainerOptions = { mode: 'manual', panes: [] },
): SessionTreeContainer[] {
  return options.mode === 'repository'
    ? repositoryContainers(preferences, sessions, options.panes)
    : manualContainers(preferences, sessions)
}
