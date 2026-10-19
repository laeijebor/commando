import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChatSessionStatus } from '../shared/agent-chat.js'
import type { AgentStatus, TmuxPane } from '../shared/protocol.js'
import { CommanderRelays } from './commander-relays.js'
const dirs: string[] = []
afterEach(async () => { await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true }))) })
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'relays-')); dirs.push(dir)
  let pane: TmuxPane | undefined = { id: '%1', targetId: 'target' } as TmuxPane
  let status = 'working', chat = true, source: AgentStatus['source'] = 'hook'
  let hostStatus: ChatSessionStatus | undefined = 'running'
  const changed = vi.fn(), sendChat = vi.fn(() => true), sendTerminal = vi.fn(async () => {})
  const options = { statePath: join(dir, 'relays.json'), pane: () => pane, status: () => ({ status, source } as AgentStatus), owns: () => chat, chatStatus: () => hostStatus, sendChat, sendTerminal, changed, now: () => 100 }
  const queue = new CommanderRelays(options); await queue.load()
  const enqueue = (text: string, delivery: 'queue' | 'steer' = 'queue') => queue.enqueue({ paneId: '%1', origin: 'inbox', kind: 'relay', text, delivery })
  return { queue, options, enqueue, changed, sendChat, sendTerminal, status: (s: string, from: AgentStatus['source'] = 'hook') => {
    status = s; source = from
    hostStatus = s === 'done' ? 'idle' : s === 'failed' ? 'error' : s === 'needs_input' ? 'waiting' : 'running'
  }, hostStatus: (s: ChatSessionStatus | undefined) => { hostStatus = s }, terminal: () => { chat = false }, pane: (p?: TmuxPane) => { pane = p } }
}
describe('CommanderRelays', () => {
  it('holds working and needs-input relays, combines them only when done, and broadcasts every change', async () => {
    const s = await setup(), a = await s.enqueue('  user\nwords  ')
    s.status('needs_input'); const b = await s.enqueue('second')
    expect(s.sendChat).not.toHaveBeenCalled()
    s.status('done'); await s.queue.flush()
    expect(s.sendChat).toHaveBeenCalledExactlyOnceWith('%1', '  user\nwords  \n\nsecond', a.id)
    expect(a.status).toBe('delivered'); expect(b.status).toBe('delivered')
    expect(s.changed.mock.calls.map(([r]) => r.status)).toEqual(['queued', 'queued', 'delivered', 'delivered'])
  })
  it.each(['chat', 'terminal'])('delivers a queued nudge to a %s after a hook-reported failure', async (kind) => {
    const s = await setup()
    if (kind === 'terminal') s.terminal()
    const relay = await s.queue.enqueue({ paneId: '%1', origin: 'commander', kind: 'nudge', text: '[nudge from Commander] Continue', delivery: 'queue' })
    expect(relay.status).toBe('queued')
    s.status('failed'); await s.queue.flush()
    expect(relay.status).toBe('delivered')
    if (kind === 'chat') expect(s.sendChat).toHaveBeenCalledExactlyOnceWith('%1', relay.text, relay.id)
    else expect(s.sendTerminal).toHaveBeenCalledExactlyOnceWith('%1', relay.text)
  })
  it.each(['chat', 'terminal'])('holds a %s relay while working or needing input, even if the host appears idle', async (kind) => {
    const s = await setup()
    if (kind === 'terminal') s.terminal()
    const relay = await s.enqueue('Wait for me')
    s.hostStatus('idle'); await s.queue.flush()
    expect(relay.status).toBe('queued')
    s.status('needs_input'); s.hostStatus('idle'); await s.queue.flush()
    expect(relay.status).toBe('queued')
    expect(s.sendChat).not.toHaveBeenCalled(); expect(s.sendTerminal).not.toHaveBeenCalled()
  })
  it.each(['heuristic', 'process'] as const)('holds failed targets reported by %s rather than hooks', async (source) => {
    const s = await setup(), relay = await s.enqueue('Not yet')
    s.status('failed', source); await s.queue.flush()
    expect(relay.status).toBe('queued'); expect(s.sendChat).not.toHaveBeenCalled()
    s.terminal(); await s.queue.flush()
    expect(relay.status).toBe('queued'); expect(s.sendTerminal).not.toHaveBeenCalled()
  })
  it.each(['starting', 'running', 'waiting', 'closed', undefined] as const)('holds chat relays when the host is %s despite a done status', async (hostStatus) => {
    const s = await setup(), relay = await s.enqueue('Not yet')
    s.status('done'); s.hostStatus(hostStatus); await s.queue.flush()
    expect(relay.status).toBe('queued'); expect(s.sendChat).not.toHaveBeenCalled()
    s.hostStatus('idle'); await s.queue.flush()
    expect(relay.status).toBe('delivered')
  })
  it('steers chats immediately but rejects steering a busy terminal', async () => {
    const s = await setup()
    const chat = await s.enqueue('interrupt', 'steer')
    expect(s.sendChat).toHaveBeenCalledWith('%1', 'interrupt', chat.id, { delivery: 'steer' })
    s.terminal()
    expect(await s.enqueue('interrupt', 'steer')).toMatchObject({ status: 'failed', error: "can't interrupt a terminal agent mid-turn; queue it instead" })
    s.status('done')
    expect((await s.enqueue('idle', 'steer')).status).toBe('delivered')
    expect(s.sendTerminal).toHaveBeenCalledWith('%1', 'idle')
  })
  it('restores queued messages across daemon restarts and cancels only queued relays', async () => {
    const s = await setup(), relay = await s.enqueue('later')
    const restarted = new CommanderRelays(s.options); await restarted.load()
    expect(restarted.values()).toEqual([relay])
    expect(await restarted.cancel(relay.id)).toMatchObject({ status: 'cancelled' })
    expect(await restarted.cancel(relay.id)).toBeUndefined()
    const again = new CommanderRelays(s.options); await again.load()
    expect(again.values()[0].status).toBe('cancelled')
  })
  it.each([undefined, { id: '%1', targetId: 'replacement' } as TmuxPane, { id: '%1', targetId: 'target', dead: true } as TmuxPane])('fails queued deliveries after pane removal, reuse or death', async (pane) => {
    const s = await setup(), relay = await s.enqueue('later')
    s.pane(pane); s.status('done'); await s.queue.flush()
    expect(relay.status).toBe('failed'); expect(s.sendChat).not.toHaveBeenCalled()
  })
  it('marks unsuccessful delivery failed and never delivers cancelled messages', async () => {
    const s = await setup(), relay = await s.enqueue('later')
    await s.queue.cancel(relay.id); s.status('done'); s.sendChat.mockReturnValue(false)
    expect((await s.enqueue('failed')).status).toBe('failed')
    expect(s.sendChat).toHaveBeenCalledTimes(1)
  })
})
