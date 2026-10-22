import { describe, expect, it } from 'vitest'
import type { PaneRepo, TmuxPane, TmuxSession } from './protocol.js'
import { moveRepositoryItem, repositoryContainers, repositoryItemId, ungroupRepositoryItem } from './session-repositories.js'

const repo: PaneRepo = { root: '/work/vivifit', name: 'vivifit', branch: 'main', defaultBranch: 'main', isWorktree: false }
const otherRepo = { ...repo, root: '/work/other', name: 'other' }
const sessions: TmuxSession[] = Array.from({ length: 5 }, (_, index) => ({ id: '$' + (index + 1), name: 'session-' + (index + 1), attached: false, activeWindowId: null, windowIds: ['@1'] }))
// Repository selection only reads these pane fields.
const panes = sessions.map((session, index) => ({ id: '%' + index, sessionId: session.id, windowId: '@1', index: 0, repo: index === 4 ? otherRepo : repo }) as TmuxPane)
const landing = { id: 'landing', name: 'Landing', repoRoot: repo.root, sessionIds: ['$3', '$2'], collapsed: true }
const empty = { id: 'empty', name: 'Empty', repoRoot: repo.root, sessionIds: [] }
const preferences = { repositoryGroups: [landing, empty], repositorySessionIds: ['$1', 'group:landing', '$4', 'group:empty', '$5'] }
const container = () => repositoryContainers(preferences, sessions, panes).find((item) => item.repo?.root === repo.root)!
const ids = (value: typeof preferences) => repositoryContainers(value, sessions, panes).find((item) => item.repo?.root === repo.root)!.items.map(repositoryItemId)

describe('repositoryContainers sub-groups', () => {
  it('interleaves loose sessions and groups in saved order and flattens in visual order', () => {
    expect(container().items).toEqual([
      { kind: 'session', id: '$1' }, { kind: 'group', group: landing, sessionIds: ['$3', '$2'] },
      { kind: 'session', id: '$4' }, { kind: 'group', group: empty, sessionIds: [] },
    ])
    expect(container().sessionIds).toEqual(['$1', '$3', '$2', '$4'])
  })

  it('places unpositioned groups first and ignores membership after a repo change', () => {
    const value = { repositoryGroups: [{ ...landing, sessionIds: ['$3', '$5'] }, empty], repositorySessionIds: ['$1', '$2'] }
    const containers = repositoryContainers(value, sessions, panes)
    const vivi = containers.find((item) => item.repo?.root === repo.root)!
    expect(vivi.items.map(repositoryItemId)).toEqual(['group:landing', 'group:empty', '$1', '$2', '$4'])
    expect(vivi.sessionIds).toEqual(['$3', '$1', '$2', '$4'])
    expect(containers.find((item) => item.repo?.root === otherRepo.root)!.items).toEqual([{ kind: 'session', id: '$5' }])
    expect(repositoryContainers(value, [sessions[4]], panes).map((item) => item.repo?.root)).toEqual([otherRepo.root])
    expect(repositoryContainers(value, [sessions[0]], []).map((item) => item.items)).toEqual([[{ kind: 'session', id: '$1' }]])
  })
})

describe('repository item movement', () => {
  it('appends a loose session on a header, or inserts before a member', () => {
    const appended = moveRepositoryItem(preferences, container(), '$4', undefined, landing.id)
    expect(appended.repositoryGroups[0].sessionIds).toEqual(['$3', '$2', '$4'])
    expect(ids(appended)).toEqual(['$1', 'group:landing', 'group:empty'])
    const inserted = moveRepositoryItem(preferences, container(), '$4', '$2', landing.id)
    expect(inserted.repositoryGroups[0].sessionIds).toEqual(['$3', '$4', '$2'])
    expect(inserted.repositorySessionIds).toContain('$5')
  })

  it('moves a group member before a loose row, leaving its group intact', () => {
    const moved = moveRepositoryItem(preferences, container(), '$2', '$1')
    expect(moved.repositoryGroups[0].sessionIds).toEqual(['$3'])
    expect(ids(moved)).toEqual(['$2', '$1', 'group:landing', '$4', 'group:empty'])
  })

  it('moves groups before loose sessions or other groups without changing members', () => {
    const moved = moveRepositoryItem(preferences, container(), 'group:landing', '$1')
    expect(ids(moved)).toEqual(['group:landing', '$1', '$4', 'group:empty'])
    expect(moved.repositoryGroups).toEqual(preferences.repositoryGroups)
    expect(ids(moveRepositoryItem(preferences, container(), 'group:empty', 'group:landing'))).toEqual(['$1', 'group:empty', 'group:landing', '$4'])
  })

  it('rejects moves across repositories, nesting groups and invalid targets', () => {
    expect(moveRepositoryItem(preferences, container(), '$5', undefined, landing.id)).toBe(preferences)
    expect(moveRepositoryItem(preferences, container(), 'group:landing', undefined, empty.id)).toBe(preferences)
    expect(moveRepositoryItem(preferences, container(), '$1', '$5')).toBe(preferences)
    expect(moveRepositoryItem(preferences, container(), '$1', undefined, 'missing')).toBe(preferences)
    expect(moveRepositoryItem(preferences, container(), '$1', '$1')).toBe(preferences)
  })

  it('ungroups members at the group position, preserving empty groups and other repositories', () => {
    const ungrouped = ungroupRepositoryItem(preferences, container(), landing.id)
    expect(ungrouped.repositoryGroups).toEqual([empty])
    expect(ids(ungrouped)).toEqual(['$1', '$3', '$2', '$4', 'group:empty'])
    expect(ungrouped.repositorySessionIds).toContain('$5')
  })
})
