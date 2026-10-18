import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChatConversation } from '../shared/chat-conversations.js'
import type { ConversationBriefRecord } from './session-briefs.js'
import { ConversationTitles, sanitiseGeneratedTitle } from './conversation-titles.js'

// No test in this suite may launch a real command, even if injection regresses.
vi.mock('node:child_process', () => ({ spawn: () => { throw new Error('Real CLI forbidden in tests') } }))

const directories: string[] = []
afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function setup(count = 1) {
  const directory = await mkdtemp(join(tmpdir(), 'commando-titles-'))
  directories.push(directory)
  let now = 10_000_000
  const records: ConversationBriefRecord[] = Array.from({ length: count }, (_, index) => ({
    provider: 'claude', id: `conversation-${index}`, sessionId: '$1', sessionName: 'work', paneOpen: true,
    latestHeadline: 'Implementing stable titles', references: [], updatedAt: now,
  }))
  const conversations: ChatConversation[] = records.map((record) => ({
    provider: 'claude', sessionId: record.id, title: 'Give conversations stable human titles', cwd: '/checkout/conversation-finder', updatedAt: now,
    configDir: '/Users/me/.claudep',
  }))
  const applyGeneratedTitle = vi.fn(async (session: { id: string }, title: string) => {
    records.find((record) => record.id === session.id)!.title = title
    return []
  })
  const spawn = vi.fn(async () => 'Stable conversation topic')
  const resolveExecutable = vi.fn(async () => '/resolved/bin/claude')
  const options = {
    briefs: { statePath: join(directory, 'briefs.json'), conversationRecords: () => records, applyGeneratedTitle },
    index: { list: vi.fn(async () => conversations) },
    spawn, resolveExecutable, env: { PATH: '/resolved/bin', CLAUDE_CONFIG_DIR: '/daemon/profile' }, now: () => now,
  }
  return { records, conversations, spawn, options, applyGeneratedTitle, advance: (milliseconds: number) => { now += milliseconds } }
}

describe('ConversationTitles', () => {
  it('uses resolved Haiku print mode, transcript context and the conversation profile', async () => {
    const fixture = await setup()
    await new ConversationTitles(fixture.options).tick()
    expect(fixture.options.resolveExecutable).toHaveBeenCalledWith('claude', expect.objectContaining({ CLAUDE_CONFIG_DIR: '/Users/me/.claudep' }))
    expect(fixture.spawn).toHaveBeenCalledWith('/resolved/bin/claude', ['-p', '--model', 'haiku', expect.stringContaining('3–6 word')], expect.objectContaining({
      env: expect.objectContaining({ CLAUDE_CONFIG_DIR: '/Users/me/.claudep' }), signal: expect.any(AbortSignal),
    }))
    const args = (fixture.spawn.mock.calls as unknown as [string, string[]][])[0]![1]
    expect(args[3]).toContain('Give conversations stable human titles')
    expect(args[3]).toContain('Implementing stable titles')
    expect(args[3]).toContain('conversation-finder')
    expect(fixture.applyGeneratedTitle).toHaveBeenCalledWith({ provider: 'claude', id: 'conversation-0' }, 'Stable conversation topic')
    await new ConversationTitles(fixture.options).tick()
    expect(fixture.spawn).toHaveBeenCalledTimes(1)
  })

  it('waits ten minutes without a headline and skips titles and unindexed records', async () => {
    const fixture = await setup(3)
    delete fixture.records[0]!.latestHeadline
    fixture.records[1]!.title = 'Agent topic title'
    fixture.conversations.pop()
    const generator = new ConversationTitles(fixture.options)
    await generator.tick()
    expect(fixture.spawn).not.toHaveBeenCalled()
    fixture.advance(10 * 60_000)
    await generator.tick()
    expect(fixture.spawn).toHaveBeenCalledTimes(1)
    expect(fixture.records[1]!.title).toBe('Agent topic title')
  })

  it('has one generation in flight across overlapping ticks', async () => {
    const fixture = await setup(2)
    let release!: (title: string) => void
    let started!: () => void
    const launched = new Promise<void>((resolve) => { started = resolve })
    fixture.spawn.mockImplementationOnce(() => { started(); return new Promise((resolve) => { release = resolve }) })
    const generator = new ConversationTitles(fixture.options)
    const first = generator.tick()
    await launched
    await generator.tick()
    expect(fixture.spawn).toHaveBeenCalledTimes(1)
    release('First conversation topic')
    await first
    expect(fixture.spawn).toHaveBeenCalledTimes(2)
  })

  it('persists the rolling twenty-per-hour budget across restarts', async () => {
    const fixture = await setup(25)
    await new ConversationTitles(fixture.options).tick()
    expect(fixture.spawn).toHaveBeenCalledTimes(20)
    await new ConversationTitles(fixture.options).tick()
    expect(fixture.spawn).toHaveBeenCalledTimes(20)
    fixture.advance(60 * 60_000)
    await new ConversationTitles(fixture.options).tick()
    expect(fixture.spawn).toHaveBeenCalledTimes(25)
  })

  it.each(['failure', 'invalid output'] as const)('persists two attempts, including permanent %s', async (kind) => {
    const fixture = await setup()
    if (kind === 'failure') fixture.spawn.mockRejectedValue(new Error('auth failed'))
    else fixture.spawn.mockResolvedValue('x')
    await new ConversationTitles(fixture.options).tick()
    expect(JSON.parse(await readFile(`${fixture.options.briefs.statePath}.generated-titles.json`, 'utf8')).attempts).toEqual({ 'claude:conversation-0': 1 })
    await new ConversationTitles(fixture.options).tick()
    await new ConversationTitles(fixture.options).tick()
    expect(fixture.spawn).toHaveBeenCalledTimes(2)
    expect(fixture.applyGeneratedTitle).not.toHaveBeenCalled()
  })

  it('aborts a generation after thirty seconds', async () => {
    vi.useFakeTimers()
    const fixture = await setup()
    let started!: () => void
    let signal!: AbortSignal
    const launched = new Promise<void>((resolve) => { started = resolve })
    const injected = vi.fn((_executable: string, _args: string[], options: { signal: AbortSignal }) => {
      signal = options.signal
      started()
      return new Promise<string>(() => {})
    })
    const running = new ConversationTitles({ ...fixture.options, spawn: injected }).tick()
    await launched
    await vi.advanceTimersByTimeAsync(30_000)
    await running
    expect(signal.aborted).toBe(true)
    expect(fixture.applyGeneratedTitle).not.toHaveBeenCalled()
  })

  it('does nothing when disabled, including scheduling, indexing and persistence', async () => {
    const fixture = await setup()
    const generator = new ConversationTitles({ ...fixture.options, env: { COMMANDO_GENERATED_TITLES: '0' } })
    generator.start()
    await generator.tick()
    generator.stop()
    expect(fixture.options.index.list).not.toHaveBeenCalled()
    expect(fixture.spawn).not.toHaveBeenCalled()
    await expect(readFile(`${fixture.options.briefs.statePath}.generated-titles.json`)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('fails closed on corrupt attempt history', async () => {
    const fixture = await setup()
    await writeFile(`${fixture.options.briefs.statePath}.generated-titles.json`, '{}')
    await expect(new ConversationTitles(fixture.options).tick()).rejects.toThrow('Invalid generated title state')
    expect(fixture.spawn).not.toHaveBeenCalled()
  })
})

describe('sanitiseGeneratedTitle', () => {
  it.each([
    ['  "Stable   conversation titles"\n', 'Stable conversation titles'],
    ['### **Stable conversation titles**', 'Stable conversation titles'],
    ['`Stable conversation titles`', 'Stable conversation titles'],
    ['“Stable conversation titles”', 'Stable conversation titles'],
    ['- Stable **conversation** titles', 'Stable conversation titles'],
    ['[Stable conversation titles](https://example.com)', 'Stable conversation titles'],
    ['ab', null], ['x'.repeat(81), null], ['First line\nSecond line', null], ['bad\u0000title', null], ['***', null],
  ])('sanitises %j', (output, expected) => {
    expect(sanitiseGeneratedTitle(output!)).toBe(expected)
  })
})
