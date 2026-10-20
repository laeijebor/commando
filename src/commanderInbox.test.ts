import { describe, expect, it } from 'vitest'
import type { ChatState } from '../shared/agent-chat'
import type { CommanderRelay, TurnBrief } from '../shared/commander'
import type { AgentStatus, SessionBrief, TmuxPane } from '../shared/protocol'
import { commanderInbox, type CommanderInboxInput } from './commanderInbox'

const pane = (id: string, overrides: Partial<TmuxPane> = {}) => ({ id, targetId: `target-${id}`, title: `Pane ${id}`, sessionId: '$1', index: 0, ...overrides }) as TmuxPane
const status = (paneId: string, overrides: Partial<AgentStatus> = {}): AgentStatus => ({ paneId, provider: 'codex', status: 'done', source: 'hook', summary: 'Headline', confidence: 'high', reason: '', updatedAt: 100, settledAt: 100, ...overrides })
const brief = (overrides: Partial<TurnBrief> = {}): TurnBrief => ({ paneId: '%1', targetId: 'target-%1', text: 'Turn complete', kind: 'done', turnKey: '100', source: 'model', endedAt: 100, createdAt: 105, ...overrides })
const chat = (overrides: Partial<ChatState> = {}): ChatState => ({ paneId: '%1', hostConnected: true, session: { paneId: '%1', provider: 'claude', status: 'idle', title: 'Chat title', cwd: '/', hostPid: 1, hostVersion: 1 }, items: [], ...overrides })
const input = (overrides: Partial<CommanderInboxInput> = {}): CommanderInboxInput => ({ snapshot: { panes: [pane('%1')], sessions: [{ id: '$1', name: 'Work', windowIds: [], activeWindowId: null, attached: true }] }, agentStatuses: { '%1': status('%1') }, paneBriefs: {}, paneSeen: {}, turnBriefs: {}, chats: {}, relays: {}, now: 1_000_000, ...overrides })

describe('commanderInbox', () => {
  it('includes only live agent/chat panes and excludes Commander', () => {
    const result = commanderInbox(input({ snapshot: { panes: [pane('%1'), pane('%2'), pane('%3'), pane('%4'), pane('%5')], sessions: [] },
      agentStatuses: { '%1': status('%1'), '%3': status('%3', { provider: 'unknown' }), '%5': status('%5'), '%gone': status('%gone') },
      chats: { '%4': chat({ paneId: '%4' }) }, commanderPaneId: '%5' }))
    expect(Object.values(result).flat().map((row) => row.paneId).sort()).toEqual(['%1', '%4'])
  })
  it('classifies attention, review, declared finish, working and seen idle with newest first', () => {
    const statuses = [status('%1', { status: 'needs_input', updatedAt: 500 }), status('%2', { status: 'working', updatedAt: 300, settledAt: undefined }), status('%3'), status('%4', { details: { recentActivities: [], checks: [], recap: { completedAt: 100, summary: 'Done', outcome: 'done', declared: true } } }), status('%5'), status('%6', { status: 'failed' })]
    const result = commanderInbox(input({ snapshot: { panes: statuses.map((s) => pane(s.paneId)), sessions: [] }, agentStatuses: Object.fromEntries(statuses.map((s) => [s.paneId, s])), paneSeen: { '%4': 100, '%5': 100 } }))
    expect(result.needs_you.map((row) => row.paneId)).toEqual(['%1', '%6'])
    expect(result.finished.map((row) => row.paneId)).toEqual(['%3', '%4'])
    expect(result.working[0]).toMatchObject({ paneId: '%2', time: 300 })
    expect(result.idle[0]).toMatchObject({ paneId: '%5', unread: false })
    expect(result.finished[0].unread).toBe(true)
  })
  it.each(['blocked', 'follow_up', 'failed'] as const)('uses recap %s as attention', (outcome) => {
    const result = commanderInbox(input({ agentStatuses: { '%1': status('%1', { details: { recentActivities: [], checks: [], recap: { outcome, completedAt: 100, summary: 'Help' } } }) } }))
    expect(result.needs_you[0]).toMatchObject({ brief: 'Help', briefTone: 'warn' })
  })
  it('uses current turn needs-you/stalled kinds even after a turn was seen', () => {
    const needs = commanderInbox(input({ paneSeen: { '%1': 200 }, turnBriefs: { 'target-%1': brief({ kind: 'needs_you' }) } }))
    expect(needs.needs_you[0]).toMatchObject({ brief: 'Turn complete', briefTone: 'warn', unread: false })
    const stalled = commanderInbox(input({ paneSeen: { '%1': 200 }, turnBriefs: { 'target-%1': brief({ kind: 'stalled' }) } }))
    expect(stalled.finished[0]).toMatchObject({ briefTone: 'warn' })
  })
  it('ignores previous-turn briefs and falls back to recap then headline', () => {
    const old = brief({ kind: 'needs_you', endedAt: 50, turnKey: '50' })
    const result = commanderInbox(input({ turnBriefs: { 'target-%1': old } }))
    expect(result.finished[0].brief).toBe('Headline')
    expect(result.needs_you).toEqual([])
    const recap = commanderInbox(input({ turnBriefs: { 'target-%1': old }, agentStatuses: { '%1': status('%1', { details: { checks: [], recentActivities: [], recap: { completedAt: 100, summary: 'Recap', outcome: 'done' } } }) } }))
    expect(recap.finished[0].brief).toBe('Recap')
  })
  it('never promotes an old brief while the next turn is working', () => {
    const result = commanderInbox(input({ agentStatuses: { '%1': status('%1', { status: 'working' }) }, turnBriefs: { 'target-%1': brief({ kind: 'needs_you' }) } }))
    expect(result.working).toHaveLength(1)
    expect(result.needs_you).toHaveLength(0)
  })
  it('respects title precedence and target ownership, including legacy session briefs', () => {
    const paneBrief = { paneId: '%1', targetId: 'target-%1', title: 'Brief title', headline: 'Brief headline' } as SessionBrief
    const withBrief = input({ paneBriefs: { '%1': paneBrief }, chats: { '%1': chat() } })
    expect(commanderInbox(withBrief).finished[0]).toMatchObject({ title: 'Brief title', sessionName: 'Work' })
    expect(commanderInbox({ ...withBrief, paneBriefs: { '%1': { ...paneBrief, targetId: 'old' } } }).finished[0]).toMatchObject({ title: 'Chat title', brief: 'Headline' })
    expect(commanderInbox({ ...withBrief, paneBriefs: { '%1': { ...paneBrief, targetId: undefined } } }).finished[0].title).toBe('Brief title')
    expect(commanderInbox(input({ snapshot: { panes: [pane('%1', { title: '', chatTitle: 'Pane chat' })], sessions: [] } })).finished[0].title).toBe('Pane chat')
    expect(commanderInbox(input({ snapshot: { panes: [pane('%1', { title: '' })], sessions: [] }, agentStatuses: { '%1': status('%1', { agentSessionName: 'Agent title' }) } })).finished[0].title).toBe('Agent title')
  })
  it('uses only the newest recent relay to the stable target', () => {
    const relay = (id: string, createdAt: number, toTargetId = 'target-%1') => ({ id, createdAt, toTargetId }) as CommanderRelay
    const result = commanderInbox(input({ relays: { old: relay('old', 1), a: relay('a', 200_000), b: relay('b', 500_000), wrong: relay('wrong', 900_000, 'other-target') } }))
    expect(result.finished[0].latestRelay?.id).toBe('b')
  })
  it('uses chat turn timing and distinct tool calls, ignoring subagent items', () => {
    const base = { turnId: 'turn', status: 'completed' as const, createdAt: 25, updatedAt: 100 }
    const state = chat({ items: [{ ...base, id: 'user', kind: 'user_message', text: 'Task' }, { ...base, id: 'tool', kind: 'tool', toolUseId: 'tool', toolName: 'Read', title: 'Read' }, { ...base, id: 'sub', kind: 'tool', parentToolUseId: 'agent', toolUseId: 'sub', toolName: 'Read', title: 'Subagent' }] })
    const result = commanderInbox(input({ chats: { '%1': state }, agentStatuses: { '%1': status('%1', { status: 'working' }) } }))
    expect(result.working[0]).toMatchObject({ time: 25, toolCount: 1 })
    const next = { ...state, items: [...state.items, { ...base, id: 'next', turnId: 'next', kind: 'user_message' as const, text: 'Next', createdAt: 200, updatedAt: 200 }] }
    expect(commanderInbox(input({ chats: { '%1': next }, turnBriefs: { 'target-%1': brief({ kind: 'needs_you' }) } })).needs_you).toEqual([])
  })
  it('handles an empty snapshot', () => expect(commanderInbox(input({ snapshot: null }))).toEqual({ needs_you: [], finished: [], working: [], idle: [] }))
})

it('matches chat briefs by settledAt even when a Stop recap arrives later, retaining recap keys for terminals', () => {
  const data = input({ chats: { '%1': chat() }, turnBriefs: { 'target-%1': brief({ kind: 'needs_you' }) },
    agentStatuses: { '%1': status('%1', { details: { recentActivities: [], checks: [], recap: { completedAt: 120, summary: 'Late recap', outcome: 'done' } } }) } })
  expect(commanderInbox(data).needs_you[0]?.brief).toBe('Turn complete')
  const terminal = commanderInbox({ ...data, chats: {} })
  expect(terminal.needs_you).toEqual([])
  expect(terminal.finished[0].brief).toBe('Late recap')
})
it('ages a finished receipt from when it left the queue, not when it was queued', () => {
  const now = 1_000_000
  const relay = { id: 'long', toTargetId: 'target-%1', createdAt: now - 60 * 60_000, status: 'delivered', deliveredAt: now - 60_000, settledAt: now - 60_000 } as CommanderRelay
  expect(commanderInbox(input({ relays: { long: relay } })).finished[0].latestRelay).toBe(relay)
  const failed = { ...relay, status: 'failed', deliveredAt: undefined, settledAt: now - 60_000 } as CommanderRelay
  expect(commanderInbox(input({ relays: { long: failed } })).finished[0].latestRelay).toBe(failed)
  const stale = { ...relay, settledAt: now - 16 * 60_000 } as CommanderRelay
  expect(commanderInbox(input({ relays: { long: stale } })).finished[0].latestRelay).toBeUndefined()
})
it('keeps old queued receipts and only expires final receipts', () => {
  const relay = { id: 'old', toTargetId: 'target-%1', createdAt: 1, status: 'queued' } as CommanderRelay
  expect(commanderInbox(input({ relays: { old: relay } })).finished[0].latestRelay).toBe(relay)
  for (const status of ['delivered', 'failed'] as const) {
    expect(commanderInbox(input({ relays: { old: { ...relay, status } } })).finished[0].latestRelay).toBeUndefined()
  }
})
