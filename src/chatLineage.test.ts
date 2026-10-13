import { describe, expect, it } from 'vitest'
import type { AgentStatus, TmuxPane } from '../shared/protocol'
import { chatParent, parentLabel, stripTaskPreamble } from './chatLineage'

const parent = { id: '%1', targetId: 'stable-parent', sessionId: '$1' } as TmuxPane
const child = { id: '%2', openedBy: parent.targetId } as TmuxPane
const snapshot = { panes: [parent, child], sessions: [{ id: '$1', name: 'main', attached: true, activeWindowId: null, windowIds: [] }] }

describe('chat lineage', () => {
  it('looks up stable targets and refuses missing or ambiguous parents', () => {
    expect(chatParent(child, snapshot)).toBe(parent)
    expect(chatParent({ ...child, openedBy: '%1' }, snapshot)).toBeUndefined()
    expect(chatParent(child, { ...snapshot, panes: [child] })).toBeUndefined()
    expect(chatParent(child, { ...snapshot, panes: [parent, { ...parent, id: '%3' }] })).toBeUndefined()
    expect(chatParent({ ...child, openedBy: undefined }, snapshot)).toBeUndefined()
  })
  it('uses the web-tile agent label, then the parent session, then another agent', () => {
    const status = { provider: 'claude', agentSessionName: 'implementation' } as AgentStatus
    expect(parentLabel(child, snapshot, { '%1': status })).toBe('claude · implementation')
    expect(parentLabel(child, snapshot, { '%1': { ...status, agentSessionName: undefined } })).toBe('claude')
    expect(parentLabel(child, snapshot, { '%1': { ...status, provider: 'unknown' } })).toBe('main')
    expect(parentLabel(child, snapshot)).toBe('main')
    expect(parentLabel(child, { ...snapshot, sessions: [] })).toBe('another agent')
    expect(parentLabel(child, { ...snapshot, panes: [child] })).toBe('another agent')
  })
  it('strips only the first exact preamble separator and preserves briefs without it', () => {
    expect(stripTaskPreamble('instructions\n---\nbrief\n---\nmore')).toBe('brief\n---\nmore')
    expect(stripTaskPreamble('brief without a separator')).toBe('brief without a separator')
    expect(stripTaskPreamble('---\nbrief')).toBe('---\nbrief')
  })
})
