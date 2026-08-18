// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest'
import type { AgentStatus, TmuxPane, TmuxSession } from '../shared/protocol'
import type { SessionTreePreferences } from './sessionManagementApi'
import {
  AGENT_HUD_DISMISSALS_STORAGE_KEY,
  agentHudGroups,
  filterAgentHudGroups,
  storedAgentHudDismissals,
  storeAgentHudDismissals,
} from './agentHud'

function status(
  paneId: string,
  state: AgentStatus['status'],
  updatedAt: number,
  recap?: NonNullable<AgentStatus['details']>['recap'],
): AgentStatus {
  return {
    paneId,
    provider: 'claude',
    status: state,
    summary: state,
    source: 'hook',
    confidence: 'high',
    reason: 'Test',
    updatedAt,
    details: recap ? { recentActivities: [], checks: [], recap } : undefined,
  }
}

function pane(id: string, sessionId: string, index = 0): TmuxPane {
  return {
    id,
    targetId: `550e8400-e29b-41d4-a716-${id.slice(1).padStart(12, '0')}`,
    sessionId,
    index,
    windowId: `@${sessionId}`,
    title: '',
    command: 'zsh',
  } as TmuxPane
}

const sessions: TmuxSession[] = [
  { id: '$1', name: 'vivi-one', attached: true, activeWindowId: null, windowIds: [] },
  { id: '$2', name: 'vivi-two', attached: false, activeWindowId: null, windowIds: [] },
  { id: '$3', name: 'gizmo', attached: false, activeWindowId: null, windowIds: [] },
  { id: '$4', name: 'new-session', attached: false, activeWindowId: null, windowIds: [] },
]

const preferences: SessionTreePreferences = {
  version: 1,
  groups: [
    { id: 'vivi', name: 'VIVI', sessionIds: ['$1', '$2'] },
    { id: 'gizmo', name: 'GIZMO', sessionIds: ['$3'] },
  ],
  ungroupedSessionIds: [],
}

describe('Agent HUD grouping', () => {
  it('matches session-tree group order and raises attention within each group', () => {
    const statuses = {
      '%1': status('%1', 'working', 1),
      '%2': status('%2', 'done', 2, {
        outcome: 'follow_up',
        summary: 'Review requested',
        completedAt: 2,
      }),
      '%3': status('%3', 'needs_input', 3),
      '%4': status('%4', 'done', 4),
      '%999': status('%999', 'failed', 5),
    }
    const panes = new Map([
      ['%1', pane('%1', '$1')],
      ['%2', pane('%2', '$2')],
      ['%3', pane('%3', '$3')],
      ['%4', pane('%4', '$4')],
    ])

    const groups = agentHudGroups(statuses, panes, sessions, preferences)

    expect(groups.map((group) => group.name)).toEqual(['VIVI', 'GIZMO', 'Ungrouped'])
    expect(groups[0].statuses.map((candidate) => candidate.paneId)).toEqual(['%2', '%1'])
    expect(groups[1].statuses.map((candidate) => candidate.paneId)).toEqual(['%3'])
    expect(groups[2].statuses.map((candidate) => candidate.paneId)).toEqual(['%4'])
  })

  it('keeps a dismissed card hidden only until its status timestamp changes', () => {
    const panes = new Map([['%1', pane('%1', '$1')]])
    const current = status('%1', 'working', 10)

    expect(agentHudGroups({ '%1': current }, panes, sessions, preferences, { '%1': 10 })).toEqual([])

    const updated = { ...current, summary: 'New update', updatedAt: 11 }
    expect(agentHudGroups({ '%1': updated }, panes, sessions, preferences, { '%1': 10 })[0].statuses)
      .toEqual([updated])
  })

  it('filters grouped cards while preserving group order and attention recaps', () => {
    const statuses = {
      '%1': status('%1', 'working', 1),
      '%2': status('%2', 'done', 2, {
        outcome: 'follow_up',
        summary: 'Review requested',
        completedAt: 2,
      }),
      '%3': status('%3', 'needs_input', 3),
      '%4': status('%4', 'done', 4),
    }
    const panes = new Map([
      ['%1', pane('%1', '$1')],
      ['%2', pane('%2', '$2')],
      ['%3', pane('%3', '$3')],
      ['%4', pane('%4', '$4')],
    ])
    const groups = agentHudGroups(statuses, panes, sessions, preferences)

    expect(filterAgentHudGroups(groups, 'working').flatMap((group) => group.statuses.map(({ paneId }) => paneId)))
      .toEqual(['%1'])
    expect(filterAgentHudGroups(groups, 'attention').flatMap((group) => group.statuses.map(({ paneId }) => paneId)))
      .toEqual(['%2', '%3'])
    expect(filterAgentHudGroups(groups, 'done').flatMap((group) => group.statuses.map(({ paneId }) => paneId)))
      .toEqual(['%2', '%4'])
    expect(filterAgentHudGroups(groups, null)).toEqual(groups)
  })
})

describe('Agent HUD dismissal storage', () => {
  beforeEach(() => window.localStorage.clear())

  it('persists valid update markers and ignores malformed values', () => {
    storeAgentHudDismissals({ '%1': 10, '%2': 20 })
    expect(storedAgentHudDismissals()).toEqual({ '%1': 10, '%2': 20 })

    window.localStorage.setItem(AGENT_HUD_DISMISSALS_STORAGE_KEY, JSON.stringify({
      '%1': 10,
      '%2': 'not-a-timestamp',
      '%3': -1,
    }))
    expect(storedAgentHudDismissals()).toEqual({ '%1': 10 })
  })
})
