import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChatSendOptions, ChatSessionStatus } from '../shared/agent-chat.js'
import type { AgentStatus, TmuxPane } from '../shared/protocol.js'
import { CommanderRelays } from './commander-relays.js'
const dirs: string[] = []
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true }))) })
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'relays-')); dirs.push(dir)
  let pane: TmuxPane | undefined = { id: '%1', targetId: 'target' } as TmuxPane
  let now = 100, updatedAt = 100
  let status = 'working', chat = true, source: AgentStatus['source'] = 'hook'
  let hostStatus: ChatSessionStatus | undefined = 'running'
  const changed = vi.fn(), sendChat = vi.fn((_paneId: string, _text: string, _requestId: string, _options?: ChatSendOptions) => true), sendTerminal = vi.fn(async () => {})
  const options = { statePath: join(dir, 'relays.json'), pane: () => pane, status: () => ({ status, source, updatedAt } as AgentStatus), owns: () => chat, chatStatus: () => hostStatus, sendChat, sendTerminal, changed, now: () => now }
  const queue = new CommanderRelays(options); await queue.load()
  const enqueue = async (text: string, delivery: 'queue' | 'steer' = 'queue') => {
    const relay = await queue.enqueue({ paneId: '%1', origin: 'inbox', kind: 'relay', text, delivery }); await queue.flush(); return relay
  }
  return { queue, options, enqueue, changed, sendChat, sendTerminal, status: (s: string, from: AgentStatus['source'] = 'hook') => {
    status = s; source = from; updatedAt = ++now
    hostStatus = s === 'done' ? 'idle' : s === 'failed' ? 'error' : s === 'needs_input' ? 'waiting' : 'running'
  }, clock: (n: number) => { now = n }, chat: () => { chat = true }, hostStatus: (s: ChatSessionStatus | undefined) => { hostStatus = s }, terminal: () => { chat = false }, pane: (p?: TmuxPane) => { pane = p } }
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
    s.terminal(); s.status('working')
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
  it('keeps unavailable chat delivery queued and never delivers cancelled messages', async () => {
    const s = await setup(), relay = await s.enqueue('later')
    await s.queue.cancel(relay.id); s.status('done'); s.sendChat.mockReturnValue(false)
    expect((await s.enqueue('failed')).status).toBe('queued')
    expect(s.sendChat).toHaveBeenCalledTimes(2) // enqueue's flush and the helper's explicit retry
    expect(s.sendChat.mock.calls.every(([, text]) => text === 'failed')).toBe(true)
  })
})

it.each(['null', '', '{}', 'true'])('continues with an empty queue and logs a corrupt journal: %s', async (raw) => {
  const s = await setup(), log = vi.spyOn(console, 'error').mockImplementation(() => {})
  await writeFile(s.options.statePath, raw)
  const restarted = new CommanderRelays(s.options)
  await expect(restarted.load()).resolves.toBeUndefined()
  expect(restarted.values()).toEqual([])
  expect(log).toHaveBeenCalledWith(expect.stringContaining(s.options.statePath), expect.any(Error))
})
it('sends one terminal paste until a newer status arrives, then delivers the next queued message', async () => {
  const s = await setup(); s.terminal(); s.status('done')
  const a = await s.enqueue('A'), b = await s.enqueue('B')
  await s.queue.flush(); await s.queue.flush()
  expect(a.status).toBe('delivered'); expect(b.status).toBe('queued')
  expect(s.sendTerminal).toHaveBeenCalledExactlyOnceWith('%1', 'A')
  s.status('done'); await s.queue.flush()
  expect(b.status).toBe('delivered'); expect(s.sendTerminal).toHaveBeenCalledTimes(2)
})
it('accepts a newer working observation before the next done, while holding messages mid-turn', async () => {
  const s = await setup(); s.terminal(); s.status('done'); await s.enqueue('A')
  s.status('working'); const b = await s.enqueue('B')
  expect(b.status).toBe('queued')
  s.status('done'); await s.queue.flush()
  expect(b.status).toBe('delivered'); expect(s.sendTerminal).toHaveBeenCalledTimes(2)
})
it('sets every sent relay to delivered before one journal write, logs failure and never resends', async () => {
  const s = await setup(); s.terminal()
  const a = await s.enqueue('A'), b = await s.enqueue('B')
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  const persist = vi.spyOn(s.queue as unknown as { persist: () => Promise<void> }, 'persist').mockImplementationOnce(async () => {
    expect([a.status, b.status]).toEqual(['delivered', 'delivered'])
    throw new Error('Disk full')
  })
  s.status('done'); await expect(s.queue.flush()).resolves.toBeUndefined()
  expect(persist).toHaveBeenCalledTimes(1)
  expect(s.changed.mock.calls.slice(-2).map(([r]) => r.status)).toEqual(['delivered', 'delivered'])
  expect(log).toHaveBeenCalledWith(expect.stringContaining(s.options.statePath), expect.any(Error))
  await s.queue.flush(); expect(s.sendTerminal).toHaveBeenCalledExactlyOnceWith('%1', 'A\n\nB')
})
it('resolves enqueue once journaled, refuses cancellation in flight and keeps delivery final after journal failure', async () => {
  const s = await setup(); s.terminal(); s.status('done')
  let release!: () => void
  s.sendTerminal.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve }))
  const relay = await s.queue.enqueue({ paneId: '%1', origin: 'inbox', kind: 'relay', text: 'A', delivery: 'queue' })
  expect(JSON.parse(await readFile(s.options.statePath, 'utf8'))[0].status).toBe('queued')
  await vi.waitFor(() => expect(s.sendTerminal).toHaveBeenCalledTimes(1))
  expect(relay.status).toBe('queued')
  expect(await s.queue.cancel(relay.id)).toBeUndefined()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(s.queue as unknown as { persist: () => Promise<void> }, 'persist').mockRejectedValueOnce(new Error('Disk full'))
  release(); await s.queue.flush()
  expect(relay.status).toBe('delivered')
  await s.queue.flush(); expect(s.sendTerminal).toHaveBeenCalledTimes(1)
})
it('rolls back enqueue and rejects when its initial journal write fails', async () => {
  const s = await setup()
  await mkdir(s.options.statePath)
  await expect(s.enqueue('A')).rejects.toThrow()
  expect(s.queue.values()).toEqual([])
  expect(s.sendChat).not.toHaveBeenCalled(); expect(s.sendTerminal).not.toHaveBeenCalled()
})
it.each(['Another delivery is in progress', 'Agent is unavailable'])('retries transient terminal failure: %s', async (reason) => {
  const s = await setup(); s.terminal(); s.status('done')
  // Hold every automatic flush until the explicit retry.
  s.sendTerminal.mockRejectedValue(new Error(reason))
  const relay = await s.enqueue('retry')
  expect(relay.status).toBe('queued')
  s.sendTerminal.mockResolvedValue(); await s.queue.flush()
  expect(relay.status).toBe('delivered')
})
it('retries a false chat send and holds a restored chat relay until its host reconnects', async () => {
  const s = await setup(), relay = await s.enqueue('chat only')
  s.terminal(); s.status('done')
  const restarted = new CommanderRelays(s.options); await restarted.load(); await restarted.flush()
  expect(restarted.values()[0]).toMatchObject({ status: 'queued', toChat: true })
  expect(s.sendTerminal).not.toHaveBeenCalled()
  s.chat(); s.sendChat.mockReturnValue(false); await restarted.flush()
  expect(restarted.values()[0].status).toBe('queued')
  s.sendChat.mockReturnValue(true); await restarted.flush(); await restarted.flush()
  expect(restarted.values()[0].status).toBe('delivered')
  expect(s.sendTerminal).not.toHaveBeenCalled()
  expect(s.sendChat).toHaveBeenLastCalledWith('%1', 'chat only', relay.id)
})
it('recognizes a chat pane before its host connects, without terminal fallback', async () => {
  const s = await setup(); s.terminal(); s.status('done'); s.pane({ id: '%1', targetId: 'target', chatTitle: 'Chat' } as TmuxPane)
  const relay = await s.enqueue('chat only')
  expect(relay).toMatchObject({ toChat: true, status: 'queued' })
  expect(s.sendTerminal).not.toHaveBeenCalled()
  s.chat(); await s.queue.flush(); expect(relay.status).toBe('delivered')
})
it('expires queued messages after six hours and preserves final text rejection', async () => {
  const s = await setup(), expired = await s.enqueue('expire')
  s.clock(100 + 6 * 3_600_000); await s.queue.flush()
  expect(expired).toMatchObject({ status: 'failed', error: 'Not delivered within 6 hours' })
  s.terminal(); s.status('done'); s.sendTerminal.mockRejectedValue(new Error('Text rejected'))
  expect(await s.enqueue('bad')).toMatchObject({ status: 'failed', error: 'Text rejected' })
})
it('stamps settledAt when a relay leaves the queue, for delivery, cancellation and failure', async () => {
  const s = await setup(), held = await s.enqueue('held')
  expect(held.settledAt).toBeUndefined()
  s.clock(500); expect((await s.queue.cancel(held.id))?.settledAt).toBe(500)
  s.clock(600); s.status('done')
  const sent = await s.enqueue('sent')
  expect(sent).toMatchObject({ status: 'delivered', settledAt: sent.deliveredAt })
  s.terminal(); s.status('working')
  expect(await s.enqueue('busy', 'steer')).toMatchObject({ status: 'failed', settledAt: expect.any(Number) })
})
it('delivers to a fresh idle chat with unknown registry status', async () => {
  const s = await setup(); s.status('unknown'); s.hostStatus('idle')
  expect((await s.enqueue('first turn')).status).toBe('delivered')
  expect(s.sendChat).toHaveBeenCalledTimes(1)
})
it('sends only a steer when an idle chat also has queued input, then releases the queue after the next done', async () => {
  const s = await setup(), queued = await s.enqueue('after steer')
  // Add the steer while the host is temporarily disconnected, so both are pending at idle.
  s.hostStatus(undefined)
  const steer = await s.enqueue('steer now', 'steer')
  expect(steer.status).toBe('queued')
  s.status('done'); await s.queue.flush()
  expect(steer.status).toBe('delivered'); expect(queued.status).toBe('queued')
  expect(s.sendChat).toHaveBeenCalledExactlyOnceWith('%1', 'steer now', steer.id, { delivery: 'steer' })
  s.status('done'); await s.queue.flush()
  expect(queued.status).toBe('delivered'); expect(s.sendChat).toHaveBeenCalledTimes(2)
})
it('drops malformed journal entries and delivers restored queued input exactly once when done', async () => {
  const s = await setup(), relay = await s.enqueue('restored')
  await writeFile(s.options.statePath, JSON.stringify([null, {}, 'bad', { ...relay, createdAt: 'yesterday' }, { ...relay, toChat: 'yes' }, relay]))
  const restarted = new CommanderRelays(s.options); await restarted.load()
  expect(restarted.values()).toEqual([relay])
  await restarted.flush(); expect(s.sendChat).not.toHaveBeenCalled()
  s.status('done'); await restarted.flush(); await restarted.flush()
  expect(s.sendChat).toHaveBeenCalledExactlyOnceWith('%1', 'restored', relay.id)
})
it('cancels only queued nudges for a recovered target', async () => {
  const s = await setup(), normal = await s.enqueue('user words')
  const nudge = await s.queue.enqueue({ paneId: '%1', origin: 'commander', kind: 'nudge', text: 'wake up', delivery: 'queue' })
  await s.queue.flush(); await s.queue.cancelNudges('target')
  expect(nudge.status).toBe('cancelled'); expect(normal.status).toBe('queued')
  s.status('done'); await s.queue.flush()
  expect(s.sendChat).toHaveBeenCalledExactlyOnceWith('%1', 'user words', normal.id)
})

it('cancels a queued nudge during another relay delivery to the same target', async () => {
  const s = await setup(); s.terminal(); s.status('done')
  let release!: () => void
  s.sendTerminal.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve }))
  const first = await s.queue.enqueue({ paneId: '%1', origin: 'inbox', kind: 'relay', text: 'User words', delivery: 'queue' })
  await vi.waitFor(() => expect(s.sendTerminal).toHaveBeenCalledTimes(1))
  const nudge = await s.queue.enqueue({ paneId: '%1', origin: 'commander', kind: 'nudge', text: 'Stale nudge', delivery: 'queue' })
  await s.queue.cancelNudges('target')
  expect(nudge.status).toBe('cancelled')
  expect(await s.queue.cancel(first.id)).toBeUndefined()
  release(); await s.queue.flush()
  s.status('done'); await s.queue.flush()
  expect(first.status).toBe('delivered')
  expect(s.sendTerminal).toHaveBeenCalledTimes(1)
})

it('keeps unclassified transport errors queued, failing only when the pane is gone', async () => {
  const s = await setup(); s.terminal(); s.status('done')
  const log = vi.spyOn(console, 'warn').mockImplementation(() => {})
  s.sendTerminal.mockRejectedValue(new Error('Transport disconnected'))
  const relay = await s.enqueue('retry')
  expect(relay.status).toBe('queued')
  expect(log).toHaveBeenCalledWith(expect.stringContaining('Relay delivery will retry paneId=%1 targetId=target'))
  s.sendTerminal.mockImplementationOnce(async () => { s.pane(undefined); throw new Error('Agent is unavailable') })
  await s.queue.flush()
  expect(relay).toMatchObject({ status: 'failed', error: 'Target pane no longer exists or changed identity' })
})
