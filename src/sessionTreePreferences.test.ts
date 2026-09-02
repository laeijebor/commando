import { describe, expect, it } from 'vitest'
import type { PaneRepo, TmuxPane, TmuxSession } from '../shared/protocol'
import { sessionTreeContainers } from './sessionTreePreferences'

const SAVE_ALL: PaneRepo = { root: '/Users/dev/gizmo/Save-All', name: 'Save-All', branch: 'main', isWorktree: false, defaultBranch: 'main' }
const COINS: PaneRepo = { ...SAVE_ALL, branch: 'referral-coins-reward', isWorktree: true }
const VIVIFIT: PaneRepo = { root: '/Users/dev/vivifit', name: 'vivifit', branch: 'main', isWorktree: false, defaultBranch: 'main' }

function session(id: string, name: string, windowIds: string[] = [`@${id.slice(1)}`]): TmuxSession {
  return { id, name, attached: false, activeWindowId: windowIds[0] ?? null, windowIds }
}

function pane(id: string, sessionId: string, windowId: string, index: number, path: string, repo?: PaneRepo): TmuxPane {
  return {
    id, sessionId, windowId, index, path, repo,
    targetId: `t-${id}`, title: '', command: 'zsh', active: index === 0, dead: false,
    width: 80, height: 24, cursorX: 0, cursorY: 0, alternateSavedX: 0, alternateSavedY: 0, alternateOn: false,
    cursorVisible: true, cursorShape: 'default', cursorBlinking: false, scrollRegionUpper: 0, scrollRegionLower: 23,
    wrapFlag: false, originFlag: false, insertFlag: false, keypadFlag: false, keypadCursorFlag: false,
    mouseAnyFlag: false, mouseSgrFlag: false, paneTabs: [],
  }
}

const manual = { version: 1 as const, groups: [{ id: 'g1', name: 'Gizmo', sessionIds: ['$2'] }], ungroupedSessionIds: ['$1'] }

describe('sessionTreeContainers in repository mode', () => {
  const sessions = [
    session('$1', 'work'),
    session('$2', 'Team Battles'),
    session('$3', 'Coins everywhere'),
    session('$4', 'CI'),
    session('$5', 'scratch'),
  ]
  const panes = [
    pane('%1', '$1', '@1', 0, '/Users/dev/commando', { root: '/Users/dev/commando', name: 'commando', branch: 'main', isWorktree: false, defaultBranch: 'main' }),
    pane('%2', '$2', '@2', 0, SAVE_ALL.root, SAVE_ALL),
    pane('%3', '$2', '@2', 1, `${SAVE_ALL.root}-worktrees/team`, COINS),
    pane('%4', '$3', '@3', 0, `${SAVE_ALL.root}-worktrees/coins`, COINS),
    pane('%5', '$4', '@4', 0, VIVIFIT.root, VIVIFIT),
    pane('%6', '$5', '@5', 0, '/tmp/plain'),
  ]

  it('groups sessions by the repository of their first pane, repositories and sessions sorted by name', () => {
    const containers = sessionTreeContainers(manual, sessions, { mode: 'repository', panes })
    expect(containers.map((container) => [container.id, container.name, container.sessionIds])).toEqual([
      ['repo:/Users/dev/commando', 'commando', ['$1']],
      ['repo:/Users/dev/gizmo/Save-All', 'Save-All', ['$3', '$2']],
      ['repo:/Users/dev/vivifit', 'vivifit', ['$4']],
      ['no-repo', 'No repository', ['$5']],
    ])
  })

  it('describes each repository container so the sidebar can create sessions in it', () => {
    const [, saveAll] = sessionTreeContainers(manual, sessions, { mode: 'repository', panes })
    expect(saveAll).toMatchObject({ kind: 'repository', repo: { root: SAVE_ALL.root, name: 'Save-All', defaultBranch: 'main' }, group: null })
  })

  it('omits the no-repository container when every session has a repository', () => {
    const containers = sessionTreeContainers(manual, sessions.slice(0, 4), { mode: 'repository', panes })
    expect(containers.map((container) => container.id)).not.toContain('no-repo')
  })

  it('falls back to the most common repository when the first pane is outside any repo', () => {
    const mixed = [
      pane('%1', '$1', '@1', 0, '/tmp/plain'),
      pane('%2', '$1', '@1', 1, VIVIFIT.root, VIVIFIT),
      pane('%3', '$1', '@1', 2, VIVIFIT.root, VIVIFIT),
    ]
    const [container] = sessionTreeContainers(manual, [session('$1', 'work')], { mode: 'repository', panes: mixed })
    expect(container.id).toBe('repo:/Users/dev/vivifit')
  })

  it('reports the branch a session is on when it differs from the default branch', () => {
    const containers = sessionTreeContainers(manual, sessions, { mode: 'repository', panes })
    const saveAll = containers.find((container) => container.name === 'Save-All')!
    expect(saveAll.sessionBranches).toEqual({ $3: 'referral-coins-reward' })
  })
})

describe('sessionTreeContainers in manual mode', () => {
  it('keeps the stored groups, order, and ungrouped tail exactly as before', () => {
    const sessions = [session('$1', 'work'), session('$2', 'Team Battles'), session('$3', 'new')]
    const containers = sessionTreeContainers(manual, sessions, { mode: 'manual', panes: [] })
    expect(containers.map((container) => [container.id, container.kind, container.sessionIds])).toEqual([
      ['g1', 'manual', ['$2']],
      ['ungrouped', 'ungrouped', ['$1', '$3']],
    ])
  })
})
