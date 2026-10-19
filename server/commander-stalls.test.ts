import { expect, it, vi } from 'vitest'
import type { AgentStatus } from '../shared/protocol.js'
import type { CommanderAgent, CommanderState } from '../shared/commander.js'
import { CommanderStalls } from './commander-stalls.js'
function setup() {
  let now = 0
  const status = { status: 'working', source: 'hook', updatedAt: 0 } as AgentStatus
  const agent = { paneId: '%1', targetId: 'target', title: 'Fix bug', sessionName: 'work', headline: 'Working' } as CommanderAgent
  const enqueue = vi.fn(async () => ({} as never)), state: CommanderState = { targetId: 'commander', paneId: '%9' }
  const stalls = new CommanderStalls({ agents: () => [agent], status: () => status, commander: () => state, relays: { enqueue }, now: () => now, env: {} })
  return { stalls, status, agent, state, enqueue, clock: (n: number) => { now = n } }
}
it('notices quiet working agents once per episode and permits one nudge per episode', async () => {
  const s = setup(); s.clock(30 * 60_000); await s.stalls.check()
  expect(s.stalls.stalled('target')).toBe(true)
  expect(s.enqueue).toHaveBeenCalledWith(expect.objectContaining({ paneId: '%9', delivery: 'queue', text: expect.stringContaining('commando-agents nudge %1') }))
  await s.stalls.check(); expect(s.enqueue).toHaveBeenCalledTimes(1)
  expect(s.stalls.takeNudge('target')).toBe(true); expect(s.stalls.takeNudge('target')).toBe(false)
  s.status.updatedAt = 30 * 60_000; await s.stalls.check()
  expect(s.stalls.stalled('target')).toBe(false)
  s.clock(60 * 60_000); await s.stalls.check()
  expect(s.enqueue).toHaveBeenCalledTimes(2); expect(s.stalls.takeNudge('target')).toBe(true)
})
it('uses hook failures and stalled briefs, then clears a fresh successful turn', async () => {
  const s = setup(); s.status.status = 'failed'; await s.stalls.check()
  expect(s.stalls.stalled('target')).toBe(true)
  s.status.status = 'done'; s.agent.brief = { endedAt: 1, kind: 'done' } as never
  await s.stalls.check(); expect(s.stalls.stalled('target')).toBe(false)
  s.agent.brief = { endedAt: 2, kind: 'stalled' } as never
  await s.stalls.check(); expect(s.stalls.stalled('target')).toBe(true)
  s.status.status = 'working'; s.status.updatedAt = 3
  await s.stalls.check(); expect(s.stalls.stalled('target')).toBe(false)
})
it('does not notify for Commander itself or absent Commander, and caps notices and nudges per hour', async () => {
  const s = setup(); s.status.status = 'failed'; delete s.state.paneId
  await s.stalls.check(); expect(s.enqueue).not.toHaveBeenCalled()
  s.state.paneId = '%9'
  for (let i = 0; i < 8; i++) {
    s.agent.targetId = `target-${i}`; await s.stalls.check()
    expect(s.stalls.takeNudge(s.agent.targetId)).toBe(i < 6)
  }
  expect(s.enqueue).toHaveBeenCalledTimes(6)
  s.agent.targetId = 'commander'; await s.stalls.check(); expect(s.enqueue).toHaveBeenCalledTimes(6)
})
it('does not revive an old stalled brief when a newer working turn asks a question', async () => {
  const s = setup()
  s.agent.brief = { endedAt: 1, kind: 'stalled' } as never
  s.status.status = 'done'; await s.stalls.check()
  expect(s.stalls.stalled('target')).toBe(true)
  s.status.status = 'working'; s.status.updatedAt = 2; await s.stalls.check()
  s.status.status = 'needs_input'; s.status.updatedAt = 3; await s.stalls.check()
  expect(s.stalls.stalled('target')).toBe(false)
})
