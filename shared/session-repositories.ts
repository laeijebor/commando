import type { PaneRepo, TmuxPane, TmuxSession } from './protocol.js'

export type RepositorySessionContainer = {
  id: string
  kind: 'repository' | 'no-repo'
  name: string
  sessionIds: string[]
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
  preferences: { repositorySessionIds?: string[] },
  sessions: readonly TmuxSession[],
  panes: readonly TmuxPane[],
): RepositorySessionContainer[] {
  const byRoot = new Map<string, RepositorySessionContainer>()
  const noRepo: RepositorySessionContainer = { id: 'no-repo', kind: 'no-repo', name: 'No repository', sessionIds: [], group: null }
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
  const order = new Map(preferences.repositorySessionIds?.map((id, index) => [id, index]))
  for (const container of containers) {
    container.sessionIds.sort((left, right) =>
      (order.get(left) ?? Number.MAX_SAFE_INTEGER) - (order.get(right) ?? Number.MAX_SAFE_INTEGER),
    )
  }
  return containers
}
