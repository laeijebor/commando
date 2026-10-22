import type { PaneRepo, TmuxPane, TmuxSession } from './protocol.js'

// Structural subset shared by the daemon and web preference types.
type RepositoryGroup = { id: string; name: string; repoRoot: string; sessionIds: string[]; collapsed?: boolean }
export type RepositorySessionItem = { kind: 'session'; id: string } | { kind: 'group'; group: RepositoryGroup; sessionIds: string[] }
type RepositoryPreferences = { repositorySessionIds?: string[]; repositoryGroups?: RepositoryGroup[] }

export const repositoryItemId = (item: RepositorySessionItem): string => item.kind === 'session' ? item.id : `group:${item.group.id}`

export type RepositorySessionContainer = {
  id: string
  kind: 'repository' | 'no-repo'
  name: string
  sessionIds: string[]
  items: RepositorySessionItem[]
  group: null
  repo?: Pick<PaneRepo, 'root' | 'name' | 'defaultBranch'>
  sessionBranches?: Record<string, string>
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

export function repositoryContainers(
  preferences: RepositoryPreferences,
  sessions: readonly TmuxSession[],
  panes: readonly TmuxPane[],
): RepositorySessionContainer[] {
  const byRoot = new Map<string, RepositorySessionContainer>()
  const noRepo: RepositorySessionContainer = { id: 'no-repo', kind: 'no-repo', name: 'No repository', sessionIds: [], items: [], group: null }
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
        items: [],
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
  const order = new Map(preferences.repositorySessionIds?.map((id, index) => [id, index]))
  for (const container of containers) {
    const live = new Set(container.sessionIds)
    const claimed = new Set<string>()
    const groups: RepositorySessionItem[] = (preferences.repositoryGroups ?? [])
      .filter((group) => container.repo && group.repoRoot === container.repo.root)
      .map((group) => ({ kind: 'group', group, sessionIds: group.sessionIds.filter((id) => {
        if (!live.has(id) || claimed.has(id)) return false
        claimed.add(id)
        return true
      }) }))
    container.items = [...groups, ...container.sessionIds.filter((id) => !claimed.has(id)).map((id) => ({ kind: 'session' as const, id }))]
    const position = (item: RepositorySessionItem) => order.get(repositoryItemId(item)) ?? (item.kind === 'group' ? -1 : Number.MAX_SAFE_INTEGER)
    container.items.sort((left, right) => position(left) - position(right))
    container.sessionIds = container.items.flatMap((item) => item.kind === 'session' ? [item.id] : item.sessionIds)
  }
  return containers
}

/** Move a session or group within one repository, preserving all other repositories' saved order. */
export function moveRepositoryItem<T extends RepositoryPreferences>(
  preferences: T,
  container: RepositorySessionContainer,
  sourceId: string,
  beforeId?: string,
  destinationGroupId?: string,
): T {
  const sourceGroup = container.items.find((item) => item.kind === 'group' && repositoryItemId(item) === sourceId)
  if ((!sourceGroup && !container.sessionIds.includes(sourceId)) || sourceId === beforeId) return preferences
  const destinationGroup = container.items.find((item) => item.kind === 'group' && item.group.id === destinationGroupId)
  if (destinationGroupId && (!destinationGroup || destinationGroup.kind !== 'group' || sourceGroup)) return preferences
  if (beforeId && !(destinationGroup?.kind === 'group' ? destinationGroup.sessionIds.includes(beforeId) : container.items.some((item) => repositoryItemId(item) === beforeId))) return preferences

  const repositoryGroups = preferences.repositoryGroups?.map((group) => {
    if (sourceGroup) return group
    const sessionIds = group.sessionIds.filter((id) => id !== sourceId)
    if (group.id === destinationGroupId) {
      const index = beforeId ? sessionIds.indexOf(beforeId) : sessionIds.length
      sessionIds.splice(index, 0, sourceId)
    }
    return { ...group, sessionIds }
  })
  const order = container.items.map(repositoryItemId).filter((id) => id !== sourceId)
  if (!destinationGroupId) order.splice(beforeId ? order.indexOf(beforeId) : order.length, 0, sourceId)
  const containerIds = new Set([...container.items.map(repositoryItemId), ...container.sessionIds])
  const otherIds = (preferences.repositorySessionIds ?? []).filter((id) => !containerIds.has(id))
  return { ...preferences, ...(repositoryGroups ? { repositoryGroups } : {}), repositorySessionIds: [...otherIds, ...order] }
}

/** Materialize the mixed visual order before replacing a group token with loose members. */
export function ungroupRepositoryItem<T extends RepositoryPreferences>(preferences: T, container: RepositorySessionContainer, groupId: string): T {
  const containerIds = new Set([...container.items.map(repositoryItemId), ...container.sessionIds])
  return {
    ...preferences,
    repositoryGroups: preferences.repositoryGroups?.filter((group) => group.id !== groupId),
    repositorySessionIds: [
      ...(preferences.repositorySessionIds ?? []).filter((id) => !containerIds.has(id)),
      ...container.items.flatMap((item) => item.kind === 'group' && item.group.id === groupId ? item.sessionIds : [repositoryItemId(item)]),
    ],
  }
}
