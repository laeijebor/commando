import type { PaneRepo, TmuxPane, TmuxSession } from '../shared/protocol'
import type { SessionGroupingMode, SessionTreePreferences } from './sessionManagementApi'

export const EMPTY_SESSION_TREE_PREFERENCES: SessionTreePreferences = {
  version: 1,
  groups: [],
  ungroupedSessionIds: [],
}

export const DEFAULT_GROUPING_MODE: SessionGroupingMode = 'repository'

export type SessionTreeContainerKind = 'manual' | 'ungrouped' | 'repository' | 'no-repo'

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

/** The repository a session belongs to: its first pane's repo, else the most common one across its panes. */
export function sessionRepo(session: TmuxSession, panes: readonly TmuxPane[]): PaneRepo | undefined {
  const sessionPanes = panes.filter((pane) => pane.sessionId === session.id)
  if (sessionPanes.length === 0) return undefined
  const windowOrder = new Map(session.windowIds.map((windowId, index) => [windowId, index]))
  const ordered = [...sessionPanes].sort((left, right) =>
    (windowOrder.get(left.windowId) ?? Number.MAX_SAFE_INTEGER) - (windowOrder.get(right.windowId) ?? Number.MAX_SAFE_INTEGER) ||
    left.index - right.index,
  )
  if (ordered[0].repo) return ordered[0].repo
  const counts = new Map<string, { repo: PaneRepo; count: number }>()
  for (const pane of ordered) {
    if (!pane.repo) continue
    const current = counts.get(pane.repo.root)
    counts.set(pane.repo.root, { repo: current?.repo ?? pane.repo, count: (current?.count ?? 0) + 1 })
  }
  return [...counts.values()].sort((left, right) => right.count - left.count)[0]?.repo
}

const byName = (left: string, right: string) => left.localeCompare(right, undefined, { sensitivity: 'base' })

function repositoryContainers(
  sessions: readonly TmuxSession[],
  panes: readonly TmuxPane[],
): SessionTreeContainer[] {
  const byRoot = new Map<string, SessionTreeContainer>()
  const noRepo: SessionTreeContainer = { id: 'no-repo', kind: 'no-repo', name: 'No repository', sessionIds: [], group: null }
  const sorted = [...sessions].sort((left, right) => byName(left.name, right.name))
  for (const session of sorted) {
    const repo = sessionRepo(session, panes)
    if (!repo) {
      noRepo.sessionIds.push(session.id)
      continue
    }
    let container = byRoot.get(repo.root)
    if (!container) {
      container = {
        id: `repo:${repo.root}`,
        kind: 'repository',
        name: repo.name,
        sessionIds: [],
        group: null,
        repo: { root: repo.root, name: repo.name, ...(repo.defaultBranch ? { defaultBranch: repo.defaultBranch } : {}) },
        sessionBranches: {},
      }
      byRoot.set(repo.root, container)
    }
    container.sessionIds.push(session.id)
    if (repo.branch && repo.branch !== repo.defaultBranch && repo.branch !== 'HEAD') {
      container.sessionBranches![session.id] = repo.branch
    }
  }
  const containers = [...byRoot.values()].sort((left, right) => byName(left.name, right.name) || byName(left.id, right.id))
  if (noRepo.sessionIds.length > 0) containers.push(noRepo)
  return containers
}

export function sessionTreeContainers(
  preferences: SessionTreePreferences,
  sessions: readonly TmuxSession[],
  options: SessionTreeContainerOptions = { mode: 'manual', panes: [] },
): SessionTreeContainer[] {
  return options.mode === 'repository'
    ? repositoryContainers(sessions, options.panes)
    : manualContainers(preferences, sessions)
}
