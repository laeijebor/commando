import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ChatHandoffStore, carriedDraft } from './chat-handoffs.js'

const image = (n: number) => ({ id: `${String(n).repeat(64).slice(0, 64)}.png`, name: `shot-${n}.png` })
const dirs: string[] = []
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))) })

async function store(now = () => 1_000) {
  const dir = await mkdtemp(join(tmpdir(), 'chat-handoffs-'))
  dirs.push(dir)
  return new ChatHandoffStore(join(dir, 'handoffs.json'), now)
}

const switched = {
  sessionId: 'abcd1234-0000',
  cwd: '/work',
  returnFlags: ['--config-dir', '/x/.claudep', '--permission-mode', 'default'],
  draft: { text: 'half-written', images: [image(1)] },
  queue: [{ id: 'q1', text: 'queued first', images: [image(2)] }, { id: 'q2', text: 'queued second' }],
}

describe('ChatHandoffStore', () => {
  it('keeps a switch on disk until the chat is back and its composer took the draft', async () => {
    const handoffs = await store()
    await handoffs.save(switched)
    expect(handoffs.inClaudeCode()).toEqual(['abcd1234-0000'])
    // A daemon restart mid-switch reads it back.
    const reloaded = new ChatHandoffStore(handoffs.path, () => 2_000)
    await reloaded.load()
    expect(reloaded.get('abcd1234-0000')).toMatchObject({ cwd: '/work', returnFlags: switched.returnFlags })
    const carried = reloaded.returned('abcd1234-0000')
    expect(carried).toEqual({ id: reloaded.get('abcd1234-0000')!.carryId, text: 'queued first\n\nqueued second\n\nhalf-written', images: [image(2), image(1)] })
    expect(reloaded.inClaudeCode()).toEqual([])
    // A host reconnect before the composer took it offers the same draft again.
    expect(reloaded.returned('abcd1234-0000')).toEqual(carried)
    expect(reloaded.take('abcd1234-0000', 'someone-else')).toBe(false)
    expect(reloaded.take('abcd1234-0000', carried!.id)).toBe(true)
    await reloaded.flush()
    expect(JSON.parse(await readFile(handoffs.path, 'utf8'))).toEqual({ version: 1, entries: [] })
  })

  it('forgets a switch that carried nothing once the chat is back', async () => {
    const handoffs = await store()
    await handoffs.save({ ...switched, draft: { text: '  ', images: [] }, queue: [] })
    expect(handoffs.returned('abcd1234-0000')).toBeUndefined()
    expect(handoffs.get('abcd1234-0000')).toBeUndefined()
  })

  it('drops old and malformed entries when it loads', async () => {
    let now = 1_000
    const handoffs = await store(() => now)
    await handoffs.save(switched)
    now += 31 * 24 * 60 * 60 * 1_000
    const later = new ChatHandoffStore(handoffs.path, () => now)
    await later.load()
    expect(later.inClaudeCode()).toEqual([])
    expect(carriedDraft({ ...switched, carryId: 'c', createdAt: 0, draft: { text: '', images: [] }, queue: [] })).toBeUndefined()
  })

  it("doesn't keep a switch it couldn't write, and forgets one the chat gave up on", async () => {
    const handoffs = new ChatHandoffStore('/dev/null/handoffs.json', () => 1_000, () => undefined)
    await expect(handoffs.save(switched)).rejects.toThrow()
    expect(handoffs.get('abcd1234-0000')).toBeUndefined()
    const kept = await store()
    await kept.save(switched)
    expect(kept.discard('abcd1234-0000')).toBe(true)
    expect(kept.inClaudeCode()).toEqual([])
  })
})
