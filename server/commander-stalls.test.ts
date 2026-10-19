import { afterEach, expect, it, vi } from 'vitest'
import type { AgentStatus } from '../shared/protocol.js'
import type { CommanderAgent, CommanderState } from '../shared/commander.js'
import { CommanderStalls } from './commander-stalls.js'
afterEach(() => vi.restoreAllMocks())
function setup() {
  let now = 0
  const status = { status: 'working', source: 'hook', updatedAt: 0 } as AgentStatus
  const agent = { paneId: '%1', targetId: 'target', title: 'Fix bug', sessionName: 'work', headline: 'Working' } as CommanderAgent
  const enqueue = vi.fn(async () => ({} as never)), state: CommanderState = { targetId: 'commander', paneId: '%9' }
  const agents = [agent], cancelNudges = vi.fn(async () => {})
  const stalls = new CommanderStalls({ agents: () => agents, status: () => status, commander: () => state, relays: { enqueue, cancelNudges }, now: () => now, env: {} })
  return { agents, cancelNudges, stalls, status, agent, state, enqueue, clock: (n: number) => { now = n } }
}
it('notices quiet working agents once per episode and permits one nudge per episode', async () => {
  const s = setup(); await s.stalls.check(); s.clock(30 * 60_000); await s.stalls.check()
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
  const s = setup(); await s.stalls.check(); s.status.status = 'failed'; delete s.state.paneId
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

it('baselines existing episodes after startup without notices, but allows one requested nudge', async () => {
  const s = setup(); s.clock(40 * 60_000)
  await s.stalls.check(); await s.stalls.check()
  expect(s.stalls.stalled('target')).toBe(true)
  expect(s.enqueue).not.toHaveBeenCalled()
  expect(s.stalls.takeNudge('target')).toBe(true)
  expect(s.stalls.takeNudge('target')).toBe(false)
  s.status.updatedAt = 40 * 60_000; await s.stalls.check()
  s.clock(70 * 60_000); await s.stalls.check()
  expect(s.enqueue).toHaveBeenCalledTimes(1)
})
it('returns the same in-flight check and only counts successful notices, isolating agent failures', async () => {
  const s = setup(); await s.stalls.check()
  s.agents.push({ ...s.agent, paneId: '%2', targetId: 'second' })
  s.clock(30 * 60_000)
  let release!: () => void
  s.enqueue.mockImplementationOnce(() => new Promise((_, reject) => { release = () => reject(new Error('Disk full')) }))
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  const first = s.stalls.check(), second = s.stalls.check()
  expect(first).toBe(second)
  await vi.waitFor(() => expect(s.enqueue).toHaveBeenCalledTimes(1))
  let finished = false; void second.then(() => { finished = true })
  expect(finished).toBe(false)
  release(); await first
  expect(s.enqueue).toHaveBeenCalledTimes(2)
  expect(log).toHaveBeenCalledWith(expect.stringContaining('paneId=%1 targetId=target'), expect.any(Error))
  await s.stalls.check()
  expect(s.enqueue).toHaveBeenCalledTimes(3) // The failed first agent retries, the second is already noticed.
  await s.stalls.check(); expect(s.enqueue).toHaveBeenCalledTimes(3)
})
it.each(['working', 'done'] as const)('cancels queued nudges when an episode clears via %s', async (status) => {
  const s = setup(); s.status.status = 'failed'; await s.stalls.check()
  expect(s.stalls.takeNudge('target')).toBe(true)
  s.status.status = status; s.status.updatedAt = 1
  if (status === 'done') s.agent.brief = { endedAt: 1, kind: 'done' } as never
  await s.stalls.check()
  expect(s.stalls.stalled('target')).toBe(false)
  expect(s.cancelNudges).toHaveBeenCalledExactlyOnceWith('target')
})
it('releases a failed nudge reservation and its hourly quota', async () => {
  const s = setup(); s.status.status = 'failed'; await s.stalls.check()
  for (let i = 0; i < 7; i++) {
    expect(s.stalls.takeNudge('target')).toBe(true)
    s.stalls.releaseNudge('target')
  }
  expect(s.stalls.takeNudge('target')).toBe(true)
  expect(s.stalls.takeNudge('target')).toBe(false)
})
