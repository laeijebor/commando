import { describe, expect, it } from 'vitest'
import type { AgentStatus, PaneMark } from '../shared/protocol'
import { sessionIndicator } from './sessionIndicator'

const status = (paneId: string, value: AgentStatus['status']): AgentStatus => ({
  paneId, provider: 'claude', status: value, summary: '', source: 'hook', confidence: 'high', reason: '', updatedAt: 1,
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
      .toEqual({ kind: 'status', paneId: '%1', status: 'done' })
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
})
