import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatAsideRecord, ChatSessionInfo } from '../shared/agent-chat.js'
import { AsideStore } from './agent-host/asides.js'
import { asideSessionIds, isMainChatKey, PersistedAsideSessions } from './chat-main-key.js'

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof fs>()
  return { ...original, readFile: vi.fn(original.readFile), readdir: vi.fn(original.readdir) }
})

describe('pane-level chat discovery and ask attribution', () => {
  it('keeps parent panes and excludes aside keys for conversation lists, sent-message search and answersAsk', () => {
    const chats = [{ paneId: '%4' }, { paneId: '%4~abcd1234' }, { paneId: '%9' }]
    expect(chats.filter((chat) => isMainChatKey(chat.paneId))).toEqual([chats[0], chats[2]])
    expect(isMainChatKey('%4~abcd1234')).toBe(false)
  })
})

describe('aside conversation picker exclusions', () => {
  const record = (sessionId: string | undefined, status: 'open' | 'closed'): ChatAsideRecord => ({
    id: 'abcd1234', title: 'Aside', mode: 'read-only', method: 'fork', readOnlyEnforced: true,
    sessionId, status, forkedFrom: { sessionId: 'parent-session' }, createdAt: 1,
  })
  const session = (sessionId?: string): ChatSessionInfo => ({
    paneId: '%4', provider: 'claude', cwd: '/x', status: 'idle', hostPid: 1, hostVersion: 9, sessionId,
  })

  it('collects every chat record and live aside session, without excluding parent transcripts', () => {
    expect(asideSessionIds([
      { paneId: '%4', session: session('parent-session'), asides: [record('open-session', 'open'), record('closed-session', 'closed'), record(undefined, 'open')] },
      { paneId: '%9', session: session('other-main'), asides: [record('other-closed-session', 'closed')] },
      { paneId: '%4~abcd1234', session: session('live-unrecorded'), asides: [record('aside-record', 'closed')] },
      { paneId: '%9~abcd1234', session: session('open-session') },
      { paneId: '%9~abcd5678', session: session() },
    ])).toEqual(new Set(['open-session', 'closed-session', 'other-closed-session', 'live-unrecorded', 'aside-record']))
  })

  it('has no exclusions for ordinary chats without aside records', () => {
    expect(asideSessionIds([{ paneId: '%4', session: session('normal-session') }])).toEqual(new Set())
  })

  it('unions persisted ids with live records and unrecorded aside hosts', () => {
    expect(asideSessionIds([
      { paneId: '%4', session: session('parent-session'), asides: [record('live-record', 'closed')] },
      { paneId: '%4~abcd1234', session: session('live-host') },
    ], new Set(['saved-only', 'live-record']))).toEqual(new Set(['saved-only', 'live-record', 'live-host']))
  })

  describe('persisted aside sessions', () => {
    let directory: string
    beforeEach(async () => {
      directory = await fs.mkdtemp(join(tmpdir(), 'commando-aside-picker-'))
      vi.stubEnv('COMMANDO_ASIDES_DIR', directory)
    })
    afterEach(async () => {
      vi.restoreAllMocks()
      vi.unstubAllEnvs()
      await fs.rm(directory, { recursive: true, force: true })
    })

    it('reads open and closed records across parent files without any live host', async () => {
      const store = new AsideStore()
      await store.save('parent/one', [record('saved-open', 'open')])
      await store.save('parent-two', [record('saved-closed', 'closed')])
      await store.save('unsaved-aside', [record(undefined, 'open')])
      expect(await new PersistedAsideSessions().sessionIds()).toEqual(new Set(['saved-open', 'saved-closed']))
    })

    it('ignores corrupt, invalid, quarantined, temporary and non-file entries without changing them', async () => {
      const valid = JSON.stringify({ version: 1, asides: [record('must-not-hide', 'open')] })
      const contents = new Map([
        ['corrupt.json', '{broken'],
        ['wrong-version.json', JSON.stringify({ version: 2, asides: [record('wrong-version', 'open')] })],
        ['invalid-record.json', JSON.stringify({ version: 1, asides: [{ sessionId: 'invalid' }] })],
        ['quarantined.json.bad-123', valid],
        ['partial.json.123.tmp', valid],
      ])
      for (const [name, content] of contents) await fs.writeFile(join(directory, name), content)
      await fs.mkdir(join(directory, 'directory.json'))
      await new AsideStore().save('valid', [record('saved-aside', 'closed')])
      expect(await new PersistedAsideSessions().sessionIds()).toEqual(new Set(['saved-aside']))
      for (const [name, content] of contents) expect(await fs.readFile(join(directory, name), 'utf8')).toBe(content)
    })

    it('accepts a missing directory, discovers it later and clears deleted history', async () => {
      await fs.rm(directory, { recursive: true })
      const reader = new PersistedAsideSessions()
      expect(await reader.sessionIds()).toEqual(new Set())
      await new AsideStore().save('parent', [record('saved-aside', 'open')])
      expect(await reader.sessionIds()).toEqual(new Set(['saved-aside']))
      await fs.rm(directory, { recursive: true })
      expect(await reader.sessionIds()).toEqual(new Set())
    })

    it('caches directory entries and parsed files, but refreshes an in-place edit by file mtime', async () => {
      const store = new AsideStore()
      await store.save('parent', [record('before', 'open')])
      await store.save('unchanged', [record('unchanged-aside', 'closed')])
      const reader = new PersistedAsideSessions()
      const read = vi.mocked(fs.readFile).mockClear()
      const list = vi.mocked(fs.readdir).mockClear()
      expect(await reader.sessionIds()).toEqual(new Set(['before', 'unchanged-aside']))
      expect(read).toHaveBeenCalledTimes(2)
      expect(list).toHaveBeenCalledTimes(1)
      expect(await reader.sessionIds()).toEqual(new Set(['before', 'unchanged-aside']))
      expect(read).toHaveBeenCalledTimes(2)
      expect(list).toHaveBeenCalledTimes(1)

      const directoryMtime = (await fs.stat(directory)).mtimeMs
      const path = join(directory, 'parent.json')
      const mtime = new Date((await fs.stat(path)).mtimeMs + 2000)
      await fs.writeFile(path, JSON.stringify({ version: 1, asides: [record('after', 'closed')] }))
      await fs.utimes(path, mtime, mtime)
      expect((await fs.stat(directory)).mtimeMs).toBe(directoryMtime)
      expect(await reader.sessionIds()).toEqual(new Set(['after', 'unchanged-aside']))
      expect(read).toHaveBeenCalledTimes(3)
      expect(list).toHaveBeenCalledTimes(1)
    })

    it('refreshes added, atomically replaced and removed files by directory mtime', async () => {
      const store = new AsideStore()
      const reader = new PersistedAsideSessions()
      let mtime = (await fs.stat(directory)).mtimeMs
      const refresh = async () => {
        const date = new Date(mtime += 2000)
        await fs.utimes(directory, date, date)
        return reader.sessionIds()
      }
      expect(await reader.sessionIds()).toEqual(new Set())
      await store.save('parent', [record('added', 'open')])
      expect(await refresh()).toEqual(new Set(['added']))
      await store.save('parent', [record('replaced', 'closed')])
      expect(await refresh()).toEqual(new Set(['replaced']))
      await fs.rm(join(directory, 'parent.json'))
      expect(await refresh()).toEqual(new Set())
    })
  })
})
