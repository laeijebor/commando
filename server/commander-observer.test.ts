import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { ChatItem, ChatSessionInfo } from '../shared/agent-chat.js'
import type { AgentStatus, TmuxPane } from '../shared/protocol.js'
import { createCommanderStatusObserver } from './commander-observer.js'
import { TurnBriefs } from './turn-briefs.js'

const dirs: string[] = []
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))) })
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'commander-observer-')); dirs.push(dir)
  const changed = vi.fn(), spawn = vi.fn()
  const briefs = new TurnBriefs({ statePath: join(dir, 'briefs.json'), port: 4400, env: {}, commanderTarget: () => null, changed, spawn })
  const observe = vi.spyOn(briefs, 'observe'), remove = vi.spyOn(briefs, 'remove')
  const stalls = { observe: vi.fn(async () => {}), check: vi.fn(async () => {}) }, relays = { flush: vi.fn(async () => {}) }
  const items: ChatItem[] = [
    { kind: 'assistant_message', id: 'main', text: 'Parent final answer', turnId: 'turn' } as ChatItem,
    { kind: 'assistant_message', id: 'sub', text: 'Subagent answer', turnId: 'turn', parentToolUseId: 'tool' } as ChatItem,
  ]
  const error = vi.fn()
  const observer = createCommanderStatusObserver({ pane: () => ({ id: '%1', targetId: 'target', title: 'Pane' } as TmuxPane),
    owns: () => true, items: () => items, finalMessage: () => 'Terminal final', sessionBrief: () => undefined,
    chatSession: () => ({ title: 'Chat', configDir: '/profile' } as ChatSessionInfo), briefs, stalls, relays, error })
  const status = (status: AgentStatus['status'], time: number): AgentStatus => ({ paneId: '%1', status, updatedAt: time, ...(status === 'done' ? { settledAt: time } : {}) } as AgentStatus)
  return { observer, status, briefs, observe, remove, stalls, relays, error, changed, spawn }
}
it('observes briefs and stalls, flushes relays on done, removes panes, and ignores subagent final messages', async () => {
  const s = await setup()
  s.observer({ type: 'upsert', status: s.status('working', 1) })
  const done = s.status('done', 2)
  s.observer({ type: 'upsert', status: done })
  expect(s.stalls.observe).toHaveBeenLastCalledWith('target', done)
  expect(s.observe).toHaveBeenLastCalledWith(expect.objectContaining({ finalMessage: 'Parent final answer', title: 'Chat', configDir: '/profile', restored: false }))
  expect(s.briefs.get('target')).toMatchObject({ turnKey: '2', text: 'Parent final answer' })
  expect(s.relays.flush).toHaveBeenCalledTimes(2); expect(s.stalls.check).toHaveBeenCalledTimes(2)
  s.observer({ type: 'remove', paneId: '%1' })
  expect(s.remove).toHaveBeenCalledExactlyOnceWith('%1')
  s.observer({ type: 'upsert', status: s.status('done', 3) }) // Removed state starts with a baseline.
  expect(s.changed).toHaveBeenCalledTimes(1)
  s.observer(null); expect(s.relays.flush).toHaveBeenCalledTimes(4)
  expect(s.error).not.toHaveBeenCalled()
  await s.briefs.saved()
})
it('passes restored changes through as baselines, then briefs a genuinely new turn', async () => {
  const s = await setup()
  s.observer({ type: 'upsert', status: s.status('working', 1) })
  s.observer({ type: 'upsert', status: s.status('done', 2) }, true)
  expect(s.observe).toHaveBeenLastCalledWith(expect.objectContaining({ restored: true }))
  expect(s.changed).not.toHaveBeenCalled(); expect(s.spawn).not.toHaveBeenCalled()
  s.observer({ type: 'upsert', status: s.status('done', 3) })
  expect(s.changed).not.toHaveBeenCalled()
  s.observer({ type: 'upsert', status: s.status('working', 4) })
  s.observer({ type: 'upsert', status: s.status('done', 5) })
  expect(s.briefs.get('target')?.turnKey).toBe('5')
  await s.briefs.saved()
})
