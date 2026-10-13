import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { WebSocket } from 'ws'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentHostHub } from './agent-host-hub.js'
import { decidePrAutofix, PrAutofixStore, PrAutofixWatcher, setAutofixEnabled, type PrAutofixSnapshot } from './pr-autofix.js'

const repo = 'acme/widgets'
const targetId = '123e4567-e89b-42d3-a456-426614174000'
const initial = () => setAutofixEnabled(null, repo, 12, targetId, true)
const snapshot = (overrides: Partial<PrAutofixSnapshot> = {}): PrAutofixSnapshot => ({
  state: 'open', url: `https://github.com/${repo}/pull/12`, headSha: 'sha1', failingChecks: ['lint', 'test'], viewer: 'leo', comments: [], ...overrides,
})
const noLinkedPrs = async () => []
const directories: string[] = []
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))) })
async function store() {
  const directory = await mkdtemp(join(tmpdir(), 'commando-autofix-'))
  directories.push(directory)
  return new PrAutofixStore(directory)
}

describe('PR auto-fix decisions', () => {
  it('dedupes head plus sorted, unique failing checks and triggers on new heads or failures', () => {
    const first = decidePrAutofix(snapshot(), initial(), false, 10)
    expect(first.action).toBe('send')
    expect(first.state).toMatchObject({ rounds: 1, status: 'fix-requested', lastEventAt: 10 })
    expect(decidePrAutofix(snapshot({ failingChecks: ['test', 'lint', 'lint'] }), first.state, false, 11).action).toBe('none')
    expect(decidePrAutofix(snapshot({ headSha: 'sha2' }), first.state, false, 12).action).toBe('send')
    expect(decidePrAutofix(snapshot({ failingChecks: ['build'] }), first.state, false, 13).action).toBe('send')
    expect(decidePrAutofix(snapshot({ headSha: '' }), initial(), false, 14).action).toBe('none')
  })

  it('dedupes comment ids, excludes viewer comments, and combines comments and CI in one round', () => {
    const comments = [
      { id: '0:1', author: 'reviewer', body: 'Handle the empty input', url: 'https://github.com/comment/1' },
      { id: '1:1', author: 'coderabbitai[bot]', body: 'Changes requested', url: 'https://github.com/review/1' },
      { id: '2:1', author: 'LEO', body: 'My own note', url: '' },
    ]
    const first = decidePrAutofix(snapshot({ comments }), initial(), false, 10)
    expect(first.state.handledComments).toEqual(['0:1', '1:1'])
    expect(first.state.rounds).toBe(1)
    if (first.action !== 'send') throw new Error('Expected prompt')
    expect(first.prompt).toContain(`${repo}#12`)
    expect(first.prompt).toContain('https://github.com/comment/1')
    expect(first.prompt).toContain('Handle the empty input')
    expect(first.prompt).toContain('Reply on any threads you choose not to fix')
    expect(first.prompt).not.toContain('My own note')
    expect(decidePrAutofix(snapshot({ comments }), first.state, false, 11).action).toBe('none')
    expect(decidePrAutofix(snapshot({ comments: [...comments, { ...comments[0], id: '0:2' }] }), first.state, false, 12).action).toBe('send')
  })

  it('does not consume events while busy, and sends them when idle', () => {
    const current = initial()
    const deferred = decidePrAutofix(snapshot(), current, true, 10)
    expect(deferred).toEqual({ action: 'none', state: current })
    expect(decidePrAutofix(snapshot(), deferred.state, false, 11).action).toBe('send')
  })

  it('caps after exactly five prompts and resets only on a disable/enable transition', () => {
    let current = initial()
    for (let round = 1; round <= 5; round++) {
      const result = decidePrAutofix(snapshot({ headSha: `sha${round}` }), current, false, round)
      expect(result.action).toBe('send')
      current = result.state
    }
    expect(current).toMatchObject({ rounds: 5, status: 'capped' })
    expect(decidePrAutofix(snapshot({ headSha: 'sha6' }), current, false, 6).action).toBe('none')
    expect(setAutofixEnabled(current, repo, 12, targetId, true)).toEqual(current)
    const disabled = setAutofixEnabled(current, repo, 12, targetId, false)
    expect(decidePrAutofix(snapshot(), disabled, false, 7).action).toBe('none')
    const enabled = setAutofixEnabled(disabled, repo, 12, targetId, true)
    expect(enabled).toEqual(initial())
    expect(decidePrAutofix(snapshot(), enabled, false, 8).action).toBe('send')
  })

  it.each(['merged', 'closed', 'missing'] as const)('stops watching a %s PR', (state) => {
    const result = decidePrAutofix(snapshot({ state }), initial(), false, 10)
    expect(result.action).toBe('none')
    expect(result.state).toMatchObject({ status: 'stopped', enabled: false })
    expect(result.state.reason).toBeTruthy()
  })
})

describe('PR auto-fix persistence and delivery', () => {
  it('round-trips handled events, target and cap state, with a directory env override', async () => {
    const original = await store()
    vi.stubEnv('COMMANDO_PR_AUTOFIX_DIR', original.directory)
    const state = decidePrAutofix(snapshot(), initial(), false, 123).state
    await original.update(repo, 12, () => state)
    const reopened = new PrAutofixStore()
    expect(await reopened.get('Acme/Widgets', 12)).toEqual(state)
    expect(await reopened.get(repo, 99)).toBeNull()
    expect(JSON.parse(await readFile(join(original.directory, 'watches.json'), 'utf8')).version).toBe(1)
  })

  it('refuses to overwrite malformed persisted state', async () => {
    const persisted = await store()
    await writeFile(join(persisted.directory, 'watches.json'), JSON.stringify({ version: 1, watches: [{ ...initial(), rounds: 7 }] }))
    await expect(persisted.list()).rejects.toThrow('Invalid PR auto-fix state')
  })

  it('defers busy/disconnected agents, retries refused delivery, and dedupes after a daemon restart', async () => {
    const persisted = await store()
    await persisted.update(repo, 12, () => initial())
    let busy = true
    let connected = true
    const send = vi.fn(() => false)
    const deps = { snapshot: vi.fn(async () => snapshot()), linkedPrs: noLinkedPrs, target: () => ({ paneId: '%9', busy, connected }), send }
    const watcher = new PrAutofixWatcher(persisted, deps)
    await watcher.tick()
    expect(send).not.toHaveBeenCalled()
    busy = false; connected = false
    await watcher.tick()
    expect(send).not.toHaveBeenCalled()
    connected = true
    await watcher.tick()
    expect(send).toHaveBeenCalledOnce()
    expect((await persisted.get(repo, 12))?.rounds).toBe(0)
    send.mockReturnValue(true)
    await watcher.tick()
    expect((await persisted.get(repo, 12))?.rounds).toBe(1)
    await new PrAutofixWatcher(new PrAutofixStore(persisted.directory), deps).tick()
    expect(send).toHaveBeenCalledTimes(2)
  })

  it('stops when the durable target no longer has a pane/agent', async () => {
    const persisted = await store()
    await persisted.update(repo, 12, () => initial())
    const send = vi.fn()
    const read = vi.fn(async () => snapshot())
    await new PrAutofixWatcher(persisted, { snapshot: read, linkedPrs: noLinkedPrs, target: () => undefined, send }).tick()
    expect(read).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
    expect(await persisted.get(repo, 12)).toMatchObject({ enabled: false, status: 'stopped', reason: 'Pane or agent no longer exists' })
  })

  it('does not send or re-enable a watch disabled during an upstream read', async () => {
    const persisted = await store()
    await persisted.update(repo, 12, () => initial())
    let finish!: (value: PrAutofixSnapshot) => void
    let started!: () => void
    const reading = new Promise<void>((resolve) => { started = resolve })
    const read = () => { started(); return new Promise<PrAutofixSnapshot>((resolve) => { finish = resolve }) }
    const send = vi.fn(() => true)
    const watcher = new PrAutofixWatcher(persisted, { snapshot: read, linkedPrs: noLinkedPrs, target: () => ({ paneId: '%1', busy: false, connected: true }), send })
    const tick = watcher.tick()
    await reading
    await persisted.update(repo, 12, (current) => setAutofixEnabled(current, repo, 12, targetId, false))
    finish(snapshot())
    await tick
    expect(send).not.toHaveBeenCalled()
    expect(await persisted.get(repo, 12)).toMatchObject({ enabled: false, rounds: 0 })
  })

  it('remembers the last choice and checks a watch on demand', async () => {
    const persisted = await store()
    expect(await persisted.defaultChoice()).toBeNull()
    await persisted.update(repo, 12, () => initial())
    await persisted.setDefaultChoice(true, 100)
    expect(await persisted.defaultChoice()).toEqual({ enabled: true, at: 100 })
    expect(await persisted.get(repo, 12)).toMatchObject({ enabled: true })
    const send = vi.fn(() => true)
    const watcher = new PrAutofixWatcher(persisted, { snapshot: async () => snapshot(), linkedPrs: noLinkedPrs, target: () => ({ paneId: '%1', busy: false, connected: true }), send })
    await watcher.check(repo, 12)
    expect(send).toHaveBeenCalledWith('%1', expect.stringContaining('- lint'))
    await watcher.check('acme/other', 1)
    expect(send).toHaveBeenCalledOnce()
    await writeFile(join(persisted.directory, 'watches.json'), JSON.stringify({ version: 1, watches: [], default: { enabled: 'yes', at: 1 } }))
    await expect(persisted.list()).rejects.toThrow('Invalid PR auto-fix default')
  })

  it('adopts new PRs from panes that asked for a marker when the remembered choice is on', async () => {
    const persisted = await store()
    const choiceAt = Date.parse('2026-10-12T12:00:00Z')
    let now = choiceAt + 1_000
    const linked = [
      { repo, number: 12, state: 'open' as const, createdAt: '2026-10-12T12:05:00Z' },
      { repo, number: 13, state: 'open' as const, createdAt: '2026-10-12T11:00:00Z' },
      { repo, number: 14, state: 'merged' as const, createdAt: '2026-10-12T12:05:00Z' },
      { repo, number: 15, state: 'open' as const, createdAt: '2026-10-12T12:06:00Z' },
    ]
    const linkedPrs = vi.fn(async () => linked)
    const send = vi.fn(() => true)
    const watcher = new PrAutofixWatcher(persisted, { snapshot: async () => snapshot(), linkedPrs,
      target: (id) => id === targetId ? { paneId: '%1', busy: false, connected: true } : undefined, send, now: () => now })
    await persisted.update(repo, 15, () => setAutofixEnabled(null, repo, 15, targetId, false))
    await persisted.setDefaultChoice(true, choiceAt)
    await watcher.tick()
    expect(linkedPrs).not.toHaveBeenCalled()
    watcher.noteMarkerRequest(targetId)
    await watcher.tick()
    expect((await persisted.list()).map((state) => [state.number, state.enabled])).toEqual([[15, false], [12, true]])
    expect(send).toHaveBeenCalledOnce()
    await persisted.setDefaultChoice(false, now)
    linked.push({ repo, number: 16, state: 'open', createdAt: '2026-10-12T12:07:00Z' })
    await watcher.tick()
    expect(await persisted.get(repo, 16)).toBeNull()
    await persisted.setDefaultChoice(true, choiceAt)
    now += 31 * 60_000
    linkedPrs.mockClear()
    await watcher.tick()
    expect(linkedPrs).not.toHaveBeenCalled()
  })

  it('delivers the reserved prompt through the actual daemon chat hub', async () => {
    class Socket extends EventEmitter {
      readonly OPEN = 1
      readyState = 1
      sent: unknown[] = []
      send(raw: string) { this.sent.push(JSON.parse(raw)) }
    }
    const socket = new Socket()
    const hub = new AgentHostHub({ paneExists: () => true, targetIdFor: () => targetId, broadcast: () => {} })
    hub.connect(socket as unknown as WebSocket)
    socket.emit('message', Buffer.from(JSON.stringify({ type: 'session_snapshot', session: { paneId: '%9', provider: 'claude', cwd: '/work', status: 'idle', hostPid: 10, hostVersion: 1 }, items: [] })), false)
    await new Promise((resolve) => setTimeout(resolve, 0))
    const persisted = await store()
    await persisted.update(repo, 12, () => initial())
    const watcher = new PrAutofixWatcher(persisted, {
      snapshot: async () => snapshot(),
      linkedPrs: noLinkedPrs,
      target: () => { const chat = hub.states()[0]; return chat ? { paneId: chat.paneId, connected: chat.hostConnected, busy: chat.session.status !== 'idle' } : undefined },
      send: (paneId, prompt) => hub.send(paneId, prompt, 'autofix-test'),
    })
    await watcher.tick()
    expect(socket.sent).toEqual([expect.objectContaining({ type: 'send', paneId: '%9', requestId: 'autofix-test', text: expect.stringContaining(`${repo}#12`) })])
  })
})
