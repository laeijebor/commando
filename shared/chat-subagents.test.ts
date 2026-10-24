import { describe, expect, it } from 'vitest'
import type { ChatItem } from './agent-chat'
import type { SubagentItem } from './chat-timeline'
import { subagentControls, subagentMetrics } from './chat-subagents'

const base = { turnId: 't1', status: 'completed' as const, createdAt: 1_000, updatedAt: 1_000 }
const agent = (overrides: Partial<SubagentItem> = {}): SubagentItem => ({
  ...base, id: 'a1', kind: 'subagent', toolUseId: 'a1', description: 'Map the views', state: 'completed', ...overrides,
} as SubagentItem)

describe('subagentMetrics', () => {
  it('names the state, counts tools and ticks elapsed time while live', () => {
    const own: ChatItem[] = [
      { ...base, id: 'c1', kind: 'command', parentToolUseId: 'a1', command: 'npm test' } as ChatItem,
    ]
    expect(subagentMetrics(agent({ state: 'running', background: true }), own, 66_000)).toEqual({ line: 'background · 1 tool · 1m 05s', lastAction: '$ npm test' })
    expect(subagentMetrics(agent({ toolUses: 4, durationMs: 12_000, summary: 'Found it' }), [], 0)).toEqual({ line: 'done · 4 tools · 12s', lastAction: 'Found it' })
  })

  it('reports how long an external run has been quiet, and its running command', () => {
    const quiet = agent({ runtime: 'codex', state: 'quiet', createdAt: 0, lastEventAt: 0, lastAction: 'Read a.ts' })
    expect(subagentMetrics(quiet, [], 240_000)).toMatchObject({ quiet: 'quiet for 4m', lastAction: 'last: Read a.ts' })
    const busy = agent({ runtime: 'codex', state: 'running', createdAt: 0, runningCommand: { command: 'npm test', startedAt: 50_000 } })
    expect(subagentMetrics(busy, [], 60_000)).toEqual({ line: '1m 00s · running npm test (10s)', lastAction: null })
  })
})

describe('subagentControls', () => {
  it('offers Stop for live addressable agents and Background only for foreground SDK ones', () => {
    expect(subagentControls(agent({ state: 'running', agentId: 'x' }))).toEqual({ stop: true, background: true })
    expect(subagentControls(agent({ state: 'running', agentId: 'x', background: true }))).toEqual({ stop: true, background: false })
    expect(subagentControls(agent({ state: 'running' }))).toEqual({ stop: false, background: false })
    expect(subagentControls(agent({ state: 'quiet', runtime: 'codex' }))).toEqual({ stop: true, background: false })
    expect(subagentControls(agent({ state: 'completed', agentId: 'x' }))).toEqual({ stop: false, background: false })
  })
})
