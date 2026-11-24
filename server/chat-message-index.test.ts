import { mkdir, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ChatMessageIndex } from './chat-message-index.js'

const tempDirs: string[] = []
const openIndexes: ChatMessageIndex[] = []

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'commando-msg-index-'))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  for (const index of openIndexes.splice(0)) index.close()
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('ChatMessageIndex', () => {
  it('indexes Claude and Codex transcripts, searches arbitrary 3+ char substrings, and orders by recency', async () => {
    const home = await makeTempDir()
    const claudeDir = join(home, '.claude', 'projects', 'demo')
    const codexDir = join(home, '.codex', 'sessions', '2026', '11', '24')
    await mkdir(claudeDir, { recursive: true })
    await mkdir(codexDir, { recursive: true })

    await writeFile(join(claudeDir, '11111111-1111-1111-1111-111111111111.jsonl'), [
      JSON.stringify({
        type: 'user',
        uuid: 'c1',
        cwd: '/repo/payments',
        gitBranch: 'feat/billing',
        timestamp: '2026-11-20T10:00:00.000Z',
        message: { content: 'Refactor the authentication middleware for billing' },
      }),
      JSON.stringify({
        type: 'user',
        uuid: 'c2',
        cwd: '/repo/payments',
        timestamp: '2026-11-24T09:00:00.000Z',
        message: { content: 'Add retry backoff to authentication webhook' },
      }),
      JSON.stringify({ type: 'summary', customTitle: 'Billing auth' }),
    ].join('\n') + '\n')

    await writeFile(join(codexDir, 'rollout-2026-11-24.jsonl'), [
      JSON.stringify({
        type: 'session_meta',
        payload: { id: '22222222-2222-2222-2222-222222222222', cwd: '/repo/api', git: { branch: 'main' } },
      }),
      JSON.stringify({
        type: 'event_msg',
        timestamp: '2026-11-22T12:00:00.000Z',
        payload: { type: 'user_message', message: 'Check authentication header parsing in proxy' },
      }),
    ].join('\n') + '\n')

    const index = new ChatMessageIndex({
      dbPath: ':memory:',
      home,
      codexHome: join(home, '.codex'),
      xdgDataHome: join(home, '.local', 'share'),
      claudeConfigDirs: async () => [join(home, '.claude')],
      minRefreshMs: 0,
    })
    openIndexes.push(index)

    await index.triggerSync(true)

    // Fewer than 3 chars returns nothing.
    expect(index.search('au')).toEqual([])

    // Arbitrary substring match (trigram) ordered newest first.
    const hits = index.search('thentic')
    expect(hits.map((h) => h.text)).toEqual([
      'Add retry backoff to authentication webhook',
      'Check authentication header parsing in proxy',
      'Refactor the authentication middleware for billing',
    ])
    expect(hits[0]).toMatchObject({ provider: 'claude', title: 'Billing auth', branch: 'feat/billing' })
    expect(hits[1]).toMatchObject({ provider: 'codex', cwd: '/repo/api', branch: 'main' })

    // Multi-word query with a short token (<3 chars).
    const multi = index.search('auth we')
    expect(multi.map((h) => h.text)).toEqual(['Add retry backoff to authentication webhook'])

    // All-short-word query with 3+ total characters.
    const shortWords = index.search('zz yy')
    expect(shortWords).toEqual([])
    const shortMatch = index.search('ry we')
    expect(shortMatch.map((h) => h.text)).toEqual(['Add retry backoff to authentication webhook'])
  })

  it('re-indexes modified transcripts and prunes deleted files', async () => {
    const home = await makeTempDir()
    const claudeDir = join(home, '.claude', 'projects', 'demo')
    await mkdir(claudeDir, { recursive: true })
    const file = join(claudeDir, '33333333-3333-3333-3333-333333333333.jsonl')

    await writeFile(file, `${JSON.stringify({
      type: 'user',
      uuid: 'm1',
      cwd: '/repo/demo',
      timestamp: '2026-11-24T08:00:00.000Z',
      message: { content: 'Initial zebra prompt' },
    })}\n`)

    const index = new ChatMessageIndex({
      dbPath: join(home, 'index.sqlite'),
      home,
      codexHome: join(home, '.codex'),
      xdgDataHome: join(home, '.local', 'share'),
      claudeConfigDirs: async () => [join(home, '.claude')],
      minRefreshMs: 0,
    })
    openIndexes.push(index)

    await index.triggerSync(true)
    expect(index.search('zebra')).toHaveLength(1)

    await writeFile(file, [
      JSON.stringify({
        type: 'user',
        uuid: 'm1',
        cwd: '/repo/demo',
        timestamp: '2026-11-24T08:00:00.000Z',
        message: { content: 'Initial zebra prompt' },
      }),
      JSON.stringify({
        type: 'user',
        uuid: 'm2',
        cwd: '/repo/demo',
        timestamp: '2026-11-24T09:00:00.000Z',
        message: { content: 'Follow-up giraffe question' },
      }),
    ].join('\n') + '\n')

    await index.triggerSync(true)
    expect(index.search('giraffe')).toHaveLength(1)

    await unlink(file)
    await index.triggerSync(true)
    expect(index.search('zebra')).toEqual([])
    expect(index.search('giraffe')).toEqual([])
  })
})
