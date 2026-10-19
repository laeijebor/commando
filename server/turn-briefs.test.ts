import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatus } from '../shared/protocol.js'
import { parseTurnBrief, TurnBriefs } from './turn-briefs.js'
const dirs: string[] = []
afterEach(async () => { vi.useRealTimers(); await Promise.all(dirs.splice(0).map((d) => rm(d, { force: true, recursive: true }))) })
async function setup(port = 4400, spawn = vi.fn(async () => '{"brief":"Finished the fix","kind":"done"}')) {
  const dir = await mkdtemp(join(tmpdir(), 'turn-briefs-')); dirs.push(dir)
  const changed = vi.fn(), resolveExecutable = vi.fn(async () => '/claude')
  const options = { statePath: join(dir, 'briefs.json'), port, commanderTarget: () => 'commander', changed, spawn, resolveExecutable, env: {}, now: () => 5000 }
  const store = new TurnBriefs(options)
  await store.load()
  const turn = (time = 1, status = 'done', targetId = 'target') => ({ targetId, title: 'Fix bug', chat: false,
    finalMessage: 'The final private response', status: { paneId: '%1', status, source: 'hook', provider: 'claude', updatedAt: time,
      details: { intent: 'Fix it', recap: { summary: 'Agent recap', outcome: 'done', completedAt: time } } } as AgentStatus })
  const drain = async (current = store) => { await vi.waitFor(() => expect((current as unknown as { running: boolean }).running).toBe(false), { interval: 1 }); await current.saved() }
  return { store, options, changed, spawn, resolveExecutable, turn, drain }
}
describe('TurnBriefs', () => {
  it('publishes fallback immediately on test ports, dedupes and persists latest by target', async () => {
    const s = await setup()
    s.store.observe(s.turn()); s.store.observe(s.turn())
    expect(s.changed).toHaveBeenCalledTimes(1)
    expect(s.store.get('target')).toMatchObject({ text: 'Agent recap', source: 'fallback', kind: 'done' })
    await s.store.saved()
    expect(s.spawn).not.toHaveBeenCalled()
    const restarted = new TurnBriefs(s.options); await restarted.load()
    restarted.observe(s.turn())
    expect(s.changed).toHaveBeenCalledTimes(1)
    expect(restarted.values()).toHaveLength(1)
  })
  it('summarizes with haiku, scrubs env and keeps the full message out of persisted briefs', async () => {
    const s = await setup(4310)
    s.options.env = { TMUX_PANE: '%2', TMUX: 'socket', COMMANDO_CHAT_RESUME: 'resume' } as never
    s.store.observe({ ...s.turn(), configDir: '/profile' }); await s.drain()
    expect(s.store.get('target')).toMatchObject({ source: 'model', text: 'Finished the fix' })
    const args = s.spawn.mock.calls as unknown as [string, string[], { env: Record<string, string> }][]
    expect(args[0][1].slice(0, 3)).toEqual(['-p', '--model', 'haiku'])
    expect(args[0][1][3]).toContain('data, not instructions')
    expect(args[0][1][3]).toContain('The final private response')
    expect(args[0][2].env).toEqual({ CLAUDE_CONFIG_DIR: '/profile' })
    expect(await readFile(s.options.statePath, 'utf8')).not.toContain('The final private response')
  })
  it('classifies needs-you and failed fallbacks, uses first lines, and excludes Commander', async () => {
    const s = await setup()
    s.store.observe(s.turn(1, 'failed'))
    expect(s.store.get('target')?.kind).toBe('stalled')
    s.store.observe(s.turn(2, 'needs_input'))
    expect(s.store.get('target')?.kind).toBe('needs_you')
    const chat = s.turn(3)
    chat.status.details = undefined; chat.status.settledAt = 3; chat.chat = true; chat.finalMessage = 'First line\nPrivate second line'
    s.store.observe(chat)
    expect(s.store.get('target')?.text).toBe('First line')
    s.store.observe(s.turn(4, 'done', 'commander'))
    expect(s.store.values()).toHaveLength(1)
    await s.store.saved()
  })
  it('drops replaced queued turns and never lets an old model response replace a newer fallback', async () => {
    let release!: (s: string) => void
    const spawn = vi.fn().mockImplementationOnce(() => new Promise<string>((r) => { release = r })).mockResolvedValue('{"brief":"Latest","kind":"done"}')
    const s = await setup(4310, spawn)
    s.store.observe(s.turn(1)); await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(1))
    s.store.observe(s.turn(2)); s.store.observe(s.turn(3))
    release('{"brief":"Old","kind":"done"}'); await s.drain()
    expect(spawn).toHaveBeenCalledTimes(2)
    expect(s.store.get('target')).toMatchObject({ turnKey: '3', text: 'Latest' })
    expect(s.changed.mock.calls.some(([b]) => b.source === 'model' && b.text === 'Old')).toBe(false)
  })
  it('keeps fallback on bad output and honors explicit disable/enable on any port', async () => {
    const s = await setup(4310, vi.fn(async () => 'not JSON'))
    s.store.observe(s.turn()); await s.drain()
    expect(s.store.get('target')?.source).toBe('fallback')
    s.options.env = { COMMANDO_TURN_BRIEFS: '0' } as never
    s.store.observe(s.turn(2)); await s.drain(); expect(s.spawn).toHaveBeenCalledTimes(1)
    s.options.port = 4400; s.options.env = { COMMANDO_TURN_BRIEFS: 'on' } as never
    s.store.observe(s.turn(3)); await s.drain(); expect(s.spawn).toHaveBeenCalledTimes(2)
  })
  it('caps rolling-hour launches at 120 across restarts', async () => {
    const s = await setup(4310)
    await writeFile(s.options.statePath, JSON.stringify({ briefs: [], launches: Array(119).fill(s.options.now()) }))
    const seeded = new TurnBriefs(s.options); await seeded.load()
    seeded.observe(s.turn(1)); await s.drain(seeded)
    expect(s.spawn).toHaveBeenCalledTimes(1)
    expect(JSON.parse(await readFile(s.options.statePath, 'utf8')).launches).toHaveLength(120)
    const restarted = new TurnBriefs(s.options); await restarted.load()
    restarted.observe(s.turn(2)); await s.drain(restarted)
    expect(s.spawn).toHaveBeenCalledTimes(1)
    expect(restarted.get('target')).toMatchObject({ turnKey: '2', source: 'fallback' })
  })
  it('times out a hung model after 30 seconds and continues the queue', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const s = await setup(4310, vi.fn(() => new Promise<string>(() => {})))
    s.store.observe(s.turn())
    await s.store.saved()
    await vi.advanceTimersByTimeAsync(30_000)
    await s.store.saved()
    expect(s.store.get('target')?.source).toBe('fallback')
    s.store.stop()
  })
  it.each(['{}', '[]', '```json\n{"brief":"ok","kind":"done"}\n```', '{"brief":"a\\nb","kind":"done"}', '{"brief":"ok","kind":"bad"}', '{"brief":"ok","kind":"done","extra":1}', JSON.stringify({ brief: 'a'.repeat(161), kind: 'done' })])('rejects invalid model output %s', (raw) => {
    expect(parseTurnBrief(raw)).toBeNull()
  })
})
