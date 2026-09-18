import {
  agentCounts,
  agentGroupFor,
  agentMatchesHudFilter,
  agentNeedsAttention,
  buildAgentRows,
  buildSessionTree,
  compareAgentRows,
  groupAgentRows,
  sortStatusKinds,
  STATUS_PRIORITY,
} from './selectors'
import {
  BRIEFS,
  CHECKING_STATUS,
  DONE_STATUS,
  FOLLOW_UP_STATUS,
  NEEDS_INPUT_STATUS,
  SNAPSHOT,
  WORKING_STATUS,
} from '../testing/fixtures'

const STATUSES = {
  '%14': NEEDS_INPUT_STATUS,
  '%20': WORKING_STATUS,
  '%30': CHECKING_STATUS,
  '%40': DONE_STATUS,
  '%15': FOLLOW_UP_STATUS,
}

describe('attention', () => {
  it('matches the desktop STATUS_PRIORITY order', () => {
    expect(STATUS_PRIORITY).toEqual({
      needs_input: 0,
      failed: 1,
      working: 2,
      done: 3,
      stale: 4,
      unknown: 5,
    })
  })

  it('treats pending questions and follow-up recaps as needing attention', () => {
    expect(agentNeedsAttention(NEEDS_INPUT_STATUS)).toBe(true)
    expect(agentNeedsAttention(FOLLOW_UP_STATUS)).toBe(true)
    expect(agentNeedsAttention(WORKING_STATUS)).toBe(false)
    expect(agentNeedsAttention(DONE_STATUS)).toBe(false)
  })

  it('filters the way the desktop HUD filters', () => {
    expect(agentMatchesHudFilter(NEEDS_INPUT_STATUS, 'attention')).toBe(true)
    expect(agentMatchesHudFilter(WORKING_STATUS, 'working')).toBe(true)
    expect(agentMatchesHudFilter(DONE_STATUS, 'done')).toBe(true)
    expect(agentMatchesHudFilter(DONE_STATUS, 'working')).toBe(false)
  })

  it('routes a done-but-follow-up agent into Needs you, not Done', () => {
    expect(agentGroupFor(FOLLOW_UP_STATUS)).toBe('needs_you')
    expect(agentGroupFor(DONE_STATUS)).toBe('done')
    expect(agentGroupFor(CHECKING_STATUS)).toBe('working')
  })
})

describe('buildAgentRows', () => {
  const rows = buildAgentRows({ statuses: STATUSES, snapshot: SNAPSHOT, briefs: BRIEFS })

  it('joins each status to its tmux session and window', () => {
    const row = rows.find((candidate) => candidate.paneId === '%14')
    expect(row?.sessionName).toBe('commando')
    expect(row?.windowName).toBe('island')
    expect(row?.provider).toBe('claude')
  })

  it('shows the pending question ahead of the summary', () => {
    const row = rows.find((candidate) => candidate.paneId === '%14')
    expect(row?.headline).toBe('Which auth flow should the companion use?')
    expect(row?.activity).toBe('Question · 3 options')
    expect(row?.pendingQuestionCount).toBe(1)
  })

  it('prefers the session brief headline when there is no pending request', () => {
    const row = rows.find((candidate) => candidate.paneId === '%40')
    expect(row?.headline).toBe('🟢 Visor shortcut works on non-notch Macs')
    expect(row?.activity).toBe('2 files changed')
  })

  it('carries the running check and the todo progress', () => {
    expect(rows.find((candidate) => candidate.paneId === '%30')?.activity).toBe('▶ vitest · running')
    expect(rows.find((candidate) => candidate.paneId === '%20')?.progress).toEqual({
      completed: 4,
      total: 7,
    })
  })
})

describe('groupAgentRows', () => {
  const rows = buildAgentRows({ statuses: STATUSES, snapshot: SNAPSHOT, briefs: BRIEFS })
  const groups = groupAgentRows(rows)

  it('orders the groups the way the mockup does', () => {
    expect(groups.map((group) => group.id)).toEqual(['needs_you', 'working', 'done'])
  })

  it('puts the pending question above the follow-up recap', () => {
    expect(groups[0]?.rows.map((row) => row.paneId)).toEqual(['%14', '%15'])
  })

  it('sorts equal statuses by recency', () => {
    expect(groups[1]?.rows.map((row) => row.paneId)).toEqual(['%20', '%30'])
    expect(compareAgentRows(groups[1]!.rows[0]!, groups[1]!.rows[1]!)).toBeLessThan(0)
  })

  it('drops empty groups instead of rendering an empty header', () => {
    expect(groups.some((group) => group.id === 'idle')).toBe(false)
  })

  it('counts what the host card shows', () => {
    expect(agentCounts(rows, SNAPSHOT)).toEqual({
      needsYou: 2,
      working: 2,
      done: 1,
      idle: 0,
      sessions: 4,
    })
  })
})

describe('buildSessionTree', () => {
  const tree = buildSessionTree(SNAPSHOT, STATUSES, [
    {
      id: 'tile-1',
      url: 'http://127.0.0.1:5173/mockups',
      sessionId: '$1',
      windowId: '@1',
      anchorPaneId: '%14',
      placement: 'right',
      engine: 'chromium',
      openedBy: 'agent',
      status: 'open',
      createdAt: 1_758_196_000_000,
    },
  ])

  it('groups sessions under the repo their panes live in', () => {
    expect(tree.map((group) => group.name)).toEqual(['commando', 'island', 'lavish', 'notes-vault'])
    expect(tree[0]?.path).toBe('/Users/leo/code/commando')
  })

  it('records the branch and the window and pane counts', () => {
    const commando = tree[0]?.sessions[0]
    expect(commando?.session.name).toBe('commando')
    expect(commando?.branch).toBe('feat/companion-app')
    expect(commando?.windowCount).toBe(2)
    expect(commando?.paneCount).toBe(2)
  })

  it('hangs tiles off the window they were opened in', () => {
    const window = tree[0]?.sessions[0]?.windows[0]
    expect(window?.children.map((child) => child.kind)).toEqual(['pane', 'tile'])
  })

  it('orders the status-dot cluster worst first', () => {
    expect(sortStatusKinds(['done', 'needs_input', 'working'])).toEqual([
      'needs_input',
      'working',
      'done',
    ])
  })

  it('returns nothing before the first snapshot', () => {
    expect(buildSessionTree(null)).toEqual([])
  })
})
