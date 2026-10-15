import { describe, expect, it } from 'vitest'
import type { AgentStatus, PaneMark } from '../shared/protocol'
import { paneAttention, sessionIndicator } from './sessionIndicator'

const status = (paneId: string, value: AgentStatus['status'], extra: Partial<AgentStatus> = {}): AgentStatus => ({
  paneId, provider: 'claude', status: value, summary: '', source: 'hook', confidence: 'high', reason: '', updatedAt: 1, ...extra,
})
const ended = (paneId: string, settledAt: number, declared = false): AgentStatus => status(paneId, 'done', {
  settledAt,
  details: { recentActivities: [], checks: [], recap: { outcome: 'done', summary: 'Done', completedAt: settledAt, ...(declared ? { declared: true as const } : {}) } },
})
const mark = (targetId: string, activityCount = 0): PaneMark => ({ targetId, label: 'Blocked', tone: 'red', markedAt: 1, activityCount })
const panes = [{ id: '%1', targetId: 't1' }, { id: '%2', targetId: 't2' }, { id: '%3', targetId: 't3' }]

describe('sessionIndicator', () => {
  it('returns null without statuses or marks', () => {
    expect(sessionIndicator(panes, {}, {})).toBeNull()
  })

  it('picks the most urgent agent status across panes', () => {
    expect(sessionIndicator(panes, { '%1': status('%1', 'done'), '%2': status('%2', 'working'), '%3': status('%3', 'needs_input') }, {}))
      .toEqual({ kind: 'status', paneId: '%3', status: 'needs_input' })
  })

  it('lets earlier panes win ties', () => {
    expect(sessionIndicator(panes, { '%2': status('%2', 'done'), '%1': status('%1', 'done') }, {}))
      .toEqual({ kind: 'status', paneId: '%1', status: 'idle' })
  })

  it('shows a pane mark over routine agent states', () => {
    const blocked = mark('t2')
    expect(sessionIndicator(panes, { '%1': status('%1', 'working') }, { t2: blocked }))
      .toEqual({ kind: 'mark', paneId: '%2', mark: blocked })
  })

  it('keeps agents that need input or failed above a pane mark', () => {
    expect(sessionIndicator(panes, { '%3': status('%3', 'failed') }, { t1: mark('t1', 4) }))
      .toEqual({ kind: 'status', paneId: '%3', status: 'failed' })
  })

  it('prefers a mark with activity since marking', () => {
    const active = mark('t3', 2)
    expect(sessionIndicator(panes, {}, { t1: mark('t1'), t3: active })).toEqual({ kind: 'mark', paneId: '%3', mark: active })
  })

  it('shows a turn that ended since the pane was last seen as to review', () => {
    expect(sessionIndicator(panes, { '%1': status('%1', 'working'), '%2': ended('%2', 10) }, { t1: mark('t1', 3) }, { '%2': 5 }))
      .toEqual({ kind: 'status', paneId: '%2', status: 'review' })
    expect(sessionIndicator(panes, { '%2': ended('%2', 10) }, {}, { '%2': 10 }))
      .toEqual({ kind: 'status', paneId: '%2', status: 'idle' })
  })

  it('shows finished only when every agent in the session finished', () => {
    expect(sessionIndicator(panes, { '%1': ended('%1', 10, true), '%2': ended('%2', 10) }, {}, { '%2': 20 }))
      .toEqual({ kind: 'status', paneId: '%2', status: 'idle' })
    expect(sessionIndicator(panes, { '%1': ended('%1', 10, true), '%3': status('%3', 'unknown') }, {}, {}))
      .toEqual({ kind: 'status', paneId: '%1', status: 'finished' })
  })
})

describe('paneAttention', () => {
  it('maps agent statuses to what the dot tells the user', () => {
    expect(paneAttention(status('%1', 'working'), undefined)).toBe('working')
    expect(paneAttention(status('%1', 'needs_input'), undefined)).toBe('needs_input')
    expect(paneAttention(status('%1', 'stale'), undefined)).toBe('idle')
    expect(paneAttention(status('%1', 'done'), undefined)).toBe('idle')
    expect(paneAttention(ended('%1', 10), undefined)).toBe('review')
    expect(paneAttention(ended('%1', 10), 9)).toBe('review')
    expect(paneAttention(ended('%1', 10), 10)).toBe('idle')
    expect(paneAttention(ended('%1', 10, true), undefined)).toBe('finished')
  })

  it('keeps a declared recap that did not end as done out of finished', () => {
    const followUp = status('%1', 'done', {
      settledAt: 10,
      details: { recentActivities: [], checks: [], recap: { outcome: 'follow_up', summary: 'More', completedAt: 10, declared: true } },
    })
    expect(paneAttention(followUp, 20)).toBe('idle')
  })
})
