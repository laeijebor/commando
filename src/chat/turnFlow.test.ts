import { describe, expect, it } from 'vitest'
import type { ChatItem, ChatSessionInfo } from '../../shared/agent-chat'
import { canCollapsePlan, collapsedPlanPreview, deriveTimelineRows, latestTodos, planBody, type SubagentItem } from '../../shared/chat-timeline'
import {
  elapsedLabel,
  implementPermissionMode,
  launchPermissionMode,
  planAwaitingFollowUp,
  relayAvailability,
  subagentActivity,
  switcherSubagents,
} from './turnFlow'

const base = { turnId: 't1', status: 'completed' as const, createdAt: 1_000, updatedAt: 1_000 }
const session = (overrides: Partial<ChatSessionInfo> = {}): ChatSessionInfo => ({ paneId: '%5', provider: 'claude', cwd: '/w', status: 'idle', hostPid: 1, hostVersion: 4, ...overrides })
const agent = (id: string, overrides: Partial<SubagentItem> = {}): SubagentItem => ({
  ...base, id, kind: 'subagent', toolUseId: id, description: `agent ${id}`, state: 'completed', ...overrides,
} as SubagentItem)

describe('plan helpers', () => {
  const long = ['# Ship it', '', ...Array.from({ length: 25 }, (_, index) => `- step ${index + 1}`)].join('\n')

  it('collapses long plans to a ten-line preview without the title heading', () => {
    expect(canCollapsePlan('# Short\n- one')).toBe(false)
    expect(canCollapsePlan(long)).toBe(true)
    expect(canCollapsePlan('x'.repeat(901))).toBe(true)
    const preview = collapsedPlanPreview(long)
    expect(preview.split('\n')).toEqual([...Array.from({ length: 10 }, (_, index) => `- step ${index + 1}`), '', '…'])
    expect(planBody('# Title\n\n## Summary\n\nDo it')).toBe('Do it')
  })

  it('offers the latest plan until something is sent, and not while Claude works', () => {
    const plan: ChatItem = { ...base, id: 'plan-1', kind: 'plan', toolUseId: 'tu', text: '# Plan' }
    const reply: ChatItem = { ...base, id: 'm', kind: 'assistant_message', text: 'Here is the plan.' }
    expect(planAwaitingFollowUp([plan, reply], session())).toBe(plan)
    expect(planAwaitingFollowUp([plan, reply], session({ status: 'running' }))).toBeNull()
    expect(planAwaitingFollowUp([plan, { ...base, id: 'u', kind: 'user_message', text: 'go' }], session())).toBeNull()
    // A subagent's plan isn't the chat's.
    expect(planAwaitingFollowUp([{ ...plan, parentToolUseId: 'tu-agent' }], session())).toBeNull()
  })

  it('implements in the mode the chat had before plan mode, and launches new panes in a launch mode', () => {
    expect(implementPermissionMode(session({ prePlanPermissionMode: 'acceptEdits' }))).toBe('acceptEdits')
    expect(implementPermissionMode(session())).toBe('default')
    expect(implementPermissionMode(session({ prePlanPermissionMode: 'plan' }))).toBe('default')
    expect(launchPermissionMode('bypassPermissions')).toBe('bypassPermissions')
    expect(launchPermissionMode('auto')).toBe('default')
  })
})

describe('subagent helpers', () => {
  it('groups adjacent subagents and keeps their own work in their view only', () => {
    const items: ChatItem[] = [
      { ...base, id: 'u', kind: 'user_message', text: 'go' },
      agent('a1', { state: 'running', status: 'running' }),
      { ...base, id: 'own', kind: 'command', toolUseId: 'own', command: 'ls', parentToolUseId: 'a1' },
      { ...base, id: 'own-text', kind: 'assistant_message', text: 'I listed it', parentToolUseId: 'a1' },
      agent('a2'),
      { ...base, id: 'todo', kind: 'todo_list', todos: [{ content: 'sub todo', status: 'pending' }], parentToolUseId: 'a1' },
      { ...base, id: 'm', kind: 'assistant_message', text: 'Both done' },
    ]
    const rows = deriveTimelineRows(items)
    expect(rows.map((row) => row.kind)).toEqual(['user', 'subagents', 'assistant'])
    expect(rows[1]).toMatchObject({ kind: 'subagents', live: true, items: [expect.objectContaining({ id: 'a1' }), expect.objectContaining({ id: 'a2' })] })
    expect(deriveTimelineRows(items, 'a1').map((row) => row.kind)).toEqual(['work', 'assistant'])
    expect(latestTodos(items)).toBeUndefined()
  })

  it('reports tools, elapsed time and the last action, live or from Claude’s totals', () => {
    const items: ChatItem[] = [
      { ...base, id: 'c1', kind: 'command', toolUseId: 'c1', command: 'npm test', parentToolUseId: 'a1' },
    ]
    expect(subagentActivity(agent('a1', { state: 'running', status: 'running' }), items, 13_000)).toEqual({ toolUses: 1, elapsedMs: 12_000, lastAction: '$ npm test' })
    expect(subagentActivity(agent('a1', { state: 'running', status: 'running', toolUses: 4, summary: 'Reading the tests' }), items, 2_000))
      .toMatchObject({ toolUses: 4, lastAction: 'Reading the tests' })
    expect(subagentActivity(agent('a1', { durationMs: 65_000 }), [], 99_000)).toMatchObject({ toolUses: null, elapsedMs: 65_000, lastAction: null })
    // Nothing reported: no made-up zeros.
    expect(subagentActivity(agent('a1'), [], 99_000)).toEqual({ toolUses: null, elapsedMs: null, lastAction: null })
    // Stopped after 20s, with a progress report from its third second.
    expect(subagentActivity(agent('a1', { state: 'stopped', durationMs: 3_000, updatedAt: 21_000 }), [], 99_000)).toMatchObject({ elapsedMs: 20_000 })
    expect(elapsedLabel(65_000)).toBe('1m 05s')
    expect(elapsedLabel(3_720_000)).toBe('1h 02m')
  })

  it('lists running subagents, the latest turn’s, and the viewed one', () => {
    const items: ChatItem[] = [
      agent('old', { turnId: 't0' }),
      agent('bg', { turnId: 't0', state: 'running', status: 'running', background: true }),
      agent('viewed', { turnId: 't0' }),
      agent('new1', { turnId: 't2' }),
      agent('nested', { turnId: 't2', parentToolUseId: 'new1' }),
    ]
    expect(switcherSubagents(items).map((item) => item.id)).toEqual(['bg', 'new1'])
    expect(switcherSubagents(items, 'viewed').map((item) => item.id)).toEqual(['bg', 'viewed', 'new1'])
  })

  it('relays only where SendMessage can reach the subagent', () => {
    expect(relayAvailability(agent('a', { agentId: 'a711', state: 'running', background: true }))).toEqual({ ok: true })
    expect(relayAvailability(agent('a', { agentId: 'a711' }))).toEqual({ ok: true })
    expect(relayAvailability(agent('a', { agentId: 'a711', state: 'running' }))).toMatchObject({ ok: false, reason: expect.stringContaining('Background') })
    expect(relayAvailability(agent('a'))).toMatchObject({ ok: false })
  })
})
