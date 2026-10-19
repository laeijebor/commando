import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatus } from '../shared/protocol.js'
import { parseTurnBrief, TurnBriefs } from './turn-briefs.js'
const dirs: string[] = []
afterEach(async () => { vi.restoreAllMocks(); vi.useRealTimers(); await Promise.all(dirs.splice(0).map((d) => rm(d, { force: true, recursive: true }))) })
async function setup(port = 4400, spawn = vi.fn(async () => '{"brief":"Finished the fix","kind":"done"}')) {
  const dir = await mkdtemp(join(tmpdir(), 'turn-briefs-')); dirs.push(dir)
  const changed = vi.fn(), resolveExecutable = vi.fn(async () => '/claude')
  const options = { statePath: join(dir, 'briefs.json'), port, commanderTarget: () => 'commander', changed, spawn, resolveExecutable, env: {}, now: () => 5000 }
  const store = new TurnBriefs(options)
  await store.load()
  const turn = (time = 1, status = 'done', targetId = 'target') => ({ targetId, title: 'Fix bug', chat: false,
    finalMessage: 'The final private response', status: { paneId: '%1', status, source: 'hook', provider: 'claude', updatedAt: time,
      details: { intent: 'Fix it', recap: { summary: 'Agent recap', outcome: 'done', completedAt: time } } } as AgentStatus })
  store.observe(turn(0, 'working'))
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
    s.store.observe(s.turn(2.5, 'working'))
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
    seeded.observe(s.turn(0, 'working')); seeded.observe(s.turn(1)); await s.drain(seeded)
    expect(s.spawn).toHaveBeenCalledTimes(1)
    expect(JSON.parse(await readFile(s.options.statePath, 'utf8')).launches).toHaveLength(120)
    const restarted = new TurnBriefs(s.options); await restarted.load()
    restarted.observe(s.turn(1.5, 'working')); restarted.observe(s.turn(2)); await s.drain(restarted)
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
  it.each(['{}', '[]', '{"brief":"a\\nb","kind":"done"}', '{"brief":"ok","kind":"bad"}', '{"brief":"ok","kind":"done","extra":1}', JSON.stringify({ brief: 'a'.repeat(161), kind: 'done' })])('rejects invalid model output %s', (raw) => {
    expect(parseTurnBrief(raw)).toBeNull()
  })
})

it.each(['null', '', '{}', '[]', '{"briefs":null,"launches":{}}'])('starts with empty state and logs a corrupt brief file: %s', async (raw) => {
  const s = await setup(), log = vi.spyOn(console, 'error').mockImplementation(() => {})
  await writeFile(s.options.statePath, raw)
  const restarted = new TurnBriefs(s.options)
  await expect(restarted.load()).resolves.toBeUndefined()
  expect(restarted.values()).toEqual([])
  expect(log).toHaveBeenCalledWith(expect.stringContaining(s.options.statePath), expect.any(Error))
})
it('treats first and restored observations as baselines and preserves saved briefs across idle chat reconnects', async () => {
  const s = await setup(4310)
  s.store.observe(s.turn(10)); await s.drain()
  const saved = s.store.get('target')
  const restarted = new TurnBriefs(s.options); await restarted.load()
  const idle = { ...s.turn(100), chat: true, status: { ...s.turn(100).status, details: undefined, settledAt: 100 } }
  restarted.observe(idle)
  restarted.observe({ ...idle, status: { ...idle.status, settledAt: 101 } })
  restarted.observe({ ...s.turn(110), restored: true })
  expect(restarted.get('target')).toEqual(saved)
  expect(s.spawn).toHaveBeenCalledTimes(1)
  restarted.observe({ ...idle, status: { ...idle.status, status: 'working', updatedAt: 120 } })
  restarted.observe({ ...idle, status: { ...idle.status, updatedAt: 130, settledAt: 130 } })
  await s.drain(restarted)
  expect(restarted.get('target')?.turnKey).toBe('130')
  expect(s.spawn).toHaveBeenCalledTimes(2)
  // A late Stop hook in the same done run is not another chat turn.
  restarted.observe({ ...s.turn(140), chat: true, status: { ...s.turn(140).status, settledAt: 130 } })
  await s.drain(restarted)
  expect(s.spawn).toHaveBeenCalledTimes(2)
  expect(restarted.get('target')?.turnKey).toBe('130')
})
it('never replaces a saved brief with an equal or older turn, or a chat run that began before it', async () => {
  const s = await setup()
  s.store.observe(s.turn(10)); await s.drain()
  s.store.observe(s.turn(5)); s.store.observe(s.turn(10))
  s.store.observe(s.turn(9, 'working'))
  s.store.observe({ ...s.turn(20), chat: true, status: { ...s.turn(20).status, settledAt: 20 } })
  expect(s.changed).toHaveBeenCalledTimes(1)
  s.store.observe(s.turn(21)); expect(s.store.get('target')?.turnKey).toBe('21')
  await s.drain()
})
it('accepts a JSON fence', () => expect(parseTurnBrief('```json\n{"brief":"ok","kind":"done"}\n```')).toEqual({ text: 'ok', kind: 'done' }))
it.each(['off', 'OFF', '0', 'FaLsE', 'on', 'ON', '1', 'TrUe', 'default'])('honors COMMANDO_TURN_BRIEFS=%s on both ports', async (flag) => {
  const enabled = ['on', '1', 'true'].includes(flag.toLowerCase())
  const disabled = ['off', '0', 'false'].includes(flag.toLowerCase())
  for (const port of [4310, 4400]) {
    const s = await setup(port); s.options.env = { COMMANDO_TURN_BRIEFS: flag } as never
    s.store.observe(s.turn()); await s.drain()
    expect(s.spawn).toHaveBeenCalledTimes(enabled || (!disabled && port === 4310) ? 1 : 0)
  }
})
it.each(['spawn ENOENT', 'Model generation failed (exit 2)', 'Brief timed out', 'parse'])('logs %s with context, limits repeated logs and pauses after 5 failures', async (reason) => {
  const log = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const spawn = reason === 'parse' ? vi.fn(async () => 'invalid output ' + 'x'.repeat(200)) : vi.fn(async (): Promise<string> => { throw new Error(reason) })
  const s = await setup(4310, spawn)
  let now = 5000; s.options.now = () => now
  for (let i = 1; i <= 6; i++) { s.store.observe(s.turn(i)); await s.drain() }
  expect(spawn).toHaveBeenCalledTimes(5)
  expect(s.store.get('target')).toMatchObject({ turnKey: '6', source: 'fallback' })
  expect(log).toHaveBeenCalledTimes(2)
  expect(log.mock.calls[0][0]).toContain('paneId=%1 targetId=target')
  if (reason === 'parse') expect(log.mock.calls[0][0]).toContain('Parse failure: ' + ('invalid output ' + 'x'.repeat(200)).slice(0, 120))
  expect(log.mock.calls[1][0]).toContain('paused for 30 minutes')
  now += 30 * 60_000
  spawn.mockResolvedValue('{"brief":"Recovered","kind":"done"}')
  await s.store.tick(); await s.drain()
  expect(spawn).toHaveBeenCalledTimes(6)
  expect(s.store.get('target')?.source).toBe('model')
})
