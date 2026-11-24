import { describe, expect, it } from 'vitest'
import type { TmuxPane, TmuxSession, TmuxWindow } from '../shared/protocol'
import { matchesPaneQuery, paneRows, planPaneClose, sortPaneRows, type PaneListContext } from './panesList'

const pane = (id: string, sessionId: string, extra: Partial<TmuxPane> = {}): TmuxPane => ({
  id, targetId: `t-${id}`, index: 0, windowId: `@${sessionId}`, sessionId, title: '', command: 'zsh', path: '/work',
  active: false, dead: false, ...extra,
} as TmuxPane)
const session = (id: string, name: string): TmuxSession => ({ id, name, attached: false, activeWindowId: null, windowIds: [`@${id}`] })
const window = (sessionId: string): TmuxWindow => ({ id: `@${sessionId}`, index: 1, sessionId, name: 'w', active: true, layout: '', paneIds: [] })

function context(extra: Partial<PaneListContext> = {}): PaneListContext {
  return {
    sessions: [session('$1', 'alpha'), session('$2', 'beta'), session('$3', 'bg'), session('$9', 'commander')],
    windows: [window('$1'), window('$2'), window('$3'), window('$9')],
    panes: [
      pane('%1', '$1', { chatTitle: 'Fix login' }),
      pane('%2', '$1', { title: 'server', command: 'node' }),
      pane('%3', '$2', { empty: true }),
      pane('%4', '$3'),
      pane('%5', '$9'),
    ],
    agentStatuses: { '%1': { paneId: '%1', status: 'needs_input' } as never },
    activity: { '%1': 50 },
    viewedAt: { '%1': 300, '%2': 100 },
    viewing: new Set(['%4']),
    auxiliarySessionIds: new Set(['$3']),
    commanderSessionId: '$9',
    ...extra,
  }
}

describe('paneRows', () => {
  it('labels panes and picks how each one closes', () => {
    const rows = paneRows(context())
    expect(rows.map((row) => [row.pane.id, row.label, row.sessionName, row.status, row.closeAction])).toEqual([
      ['%1', 'Fix login', 'alpha', 'Needs you', 'pane'],
      ['%2', 'server', 'alpha', 'node', 'pane'],
      ['%3', 'zsh', 'beta', 'Empty', 'pause'],
      ['%4', 'zsh', 'bg', 'zsh', 'delete'],
      ['%5', 'zsh', 'commander', 'zsh', null],
    ])
    expect(rows[0]).toMatchObject({ viewedAt: 300, activityAt: 50, windowIndex: 1, viewing: false })
    expect(rows[3].viewing).toBe(true)
  })
})

describe('sortPaneRows', () => {
  it('puts never-viewed panes first and on-screen panes last', () => {
    const rows = paneRows(context())
    expect(sortPaneRows(rows, 'viewed').map((row) => row.pane.id)).toEqual(['%3', '%5', '%2', '%1', '%4'])
    expect(sortPaneRows(rows, 'activity').map((row) => row.pane.id)).toEqual(['%2', '%3', '%4', '%5', '%1'])
    expect(sortPaneRows(rows, 'session').map((row) => row.pane.id)).toEqual(['%1', '%2', '%3', '%4', '%5'])
  })
})

describe('matchesPaneQuery', () => {
  it('matches label, session, status and branch', () => {
    const [row] = paneRows(context({ panes: [pane('%1', '$1', { chatTitle: 'Fix login', repo: { root: '/r', name: 'app', branch: 'feat/x', isWorktree: true } })] }))
    expect(['login', 'ALPHA', 'feat/x', ''].map((query) => matchesPaneQuery(row, query))).toEqual([true, true, true, true])
    expect(matchesPaneQuery(row, 'nope')).toBe(false)
  })
})

describe('planPaneClose', () => {
  const rows = paneRows(context())

  it('kills some panes of a session and closes a session whose panes are all chosen', () => {
    expect(planPaneClose(['%1'], rows)).toEqual({ panes: ['%1'], pauseSessions: [], deleteSessions: [], kept: [] })
    expect(planPaneClose(['%1', '%2', '%3', '%4'], rows)).toEqual({ panes: [], pauseSessions: ['$1', '$2'], deleteSessions: ['$3'], kept: [] })
  })

  it("leaves the Commander session's panes open", () => {
    expect(planPaneClose(['%5'], rows)).toEqual({ panes: [], pauseSessions: [], deleteSessions: [], kept: ['%5'] })
  })
})
