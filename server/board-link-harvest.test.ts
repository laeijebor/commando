import { describe, expect, it } from 'vitest'
import { BoardStore } from './boards.js'
import { BoardLinkHarvest, extractBoardLinks } from './board-link-harvest.js'
import type { AgentStatus } from '../shared/protocol.js'
const target = '00000000-0000-4000-8000-000000000001'
const status = (state: AgentStatus['status'], at: number): AgentStatus => ({ paneId: '%1', provider: 'codex', agentSessionId: 'session-one', status: state, summary: state, source: 'hook', confidence: 'high', reason: 'test', updatedAt: at, ...(state === 'done' ? { settledAt: at } : {}) })
const turn = (state: AgentStatus['status'], at: number, finalMessage = 'See https://example.com/result') => ({ status: status(state, at), targetId: target, title: 'Turn', chat: true, finalMessage })

describe('Board link harvest', () => {
  it('extracts markdown and bare URLs, keeps balanced parentheses and inline code, skips fenced code', () => {
    const links = extractBoardLinks('[Article](https://example.com/a?utm_source=chat) and https://example.com/a.\n`https://inline.example/doc` (https://example.com/wiki/Foo_(bar)).\n~~~ts\nhttps://hidden.example\n~~~\n```\nhttps://hidden2.example\n```\nhttps://last.example/a!?', 4491)
    expect(links).toEqual([
      { url: 'https://example.com/a', title: 'Article' }, { url: 'https://inline.example/doc', title: undefined },
      { url: 'https://example.com/wiki/Foo_(bar)', title: undefined }, { url: 'https://last.example/a', title: undefined },
    ])
  })
  it('ignores own daemon origins, local paths, credentials and duplicate PR identities; caps at 20', () => {
    const links = extractBoardLinks('http://localhost:4491/redline/a http://127.0.0.1:4491/a http://[::1]:4491/x /tmp/image.png file:///tmp/image.jpg https://user:pass@example.com https://github.com/Owner/Repo/pull/12?x=1 https://github.com/owner/repo/pull/12 https://other.example/image.png http://localhost:4492/test', 4491)
    expect(links.map((l) => l.url)).toEqual(['https://github.com/Owner/Repo/pull/12?x=1', 'https://other.example/image.png', 'http://localhost:4492/test'])
    expect(links[0].pr).toEqual({ repo: 'Owner/Repo', number: 12 })
    expect(extractBoardLinks(Array.from({ length: 50 }, (_, n) => `https://example.com/${n}`).join(' '), 4491)).toHaveLength(20)
  })
  it('harvests once on completion with origin and no placement, never during work/restoration', () => {
    const store = new BoardStore({ now: () => 500 }), harvest = new BoardLinkHarvest(store, 4491)
    harvest.observe({ ...turn('done', 100), restored: true }); expect(store.get(target).items).toHaveLength(0)
    harvest.observe(turn('working', 200)); expect(store.get(target).items).toHaveLength(0)
    harvest.observe(turn('done', 300), 'User asked for sources')
    const board = store.get(target)
    expect(board.items).toHaveLength(1); expect(board.placements).toEqual({})
    expect(board.items[0]).toMatchObject({ source: 'auto', origin: { at: 300, agentSession: { provider: 'codex', id: 'session-one' }, prompt: 'User asked for sources' } })
    harvest.observe(turn('done', 300)); expect(store.get(target).rev).toBe(board.rev)
    store.remove(target, board.items[0].key); harvest.observe(turn('done', 300)); expect(store.get(target).items).toHaveLength(0)
    harvest.observe(turn('working', 400)); harvest.observe(turn('done', 500)); expect(store.get(target).items).toHaveLength(1)
  })
  it('waits for a late final message and excludes restored final messages', () => {
    const store = new BoardStore(), harvest = new BoardLinkHarvest(store, 4491)
    harvest.observe(turn('working', 1))
    harvest.observe({ ...turn('done', 2), finalMessage: undefined })
    expect(store.get(target).items).toHaveLength(0)
    harvest.observe(turn('done', 2)); expect(store.get(target).items).toHaveLength(1)
    harvest.observe({ ...turn('done', 3, 'https://restored.example'), restored: true })
    expect(store.get(target).items).toHaveLength(1)
    expect(extractBoardLinks('https://[2606:4700::1111]/path', 4491)[0].url).toBe('https://[2606:4700::1111]/path')
  })
  it('maps PR URLs to existing identities without overwriting a real title', () => {
    const store = new BoardStore(), harvest = new BoardLinkHarvest(store, 4491)
    store.capturePr(target, { repo: 'owner/repo', number: 12 })
    store.capturePr(target, { repo: 'owner/repo', number: 13, title: 'GitHub title' })
    harvest.observe(turn('working', 1))
    harvest.observe(turn('done', 2, '[Helpful title](https://github.com/owner/repo/pull/12) [Other title](https://github.com/owner/repo/pull/13) https://github.com/owner/repo/pull/14'))
    const items = store.get(target).items
    expect(items).toHaveLength(3); expect(items.map((i) => i.kind)).toEqual(['pr', 'pr', 'pr'])
    expect(items[0].title).toBe('Helpful title'); expect(items[1].title).toBe('GitHub title')
  })
  it('handles terminal recap completion and resets pane state on removal', () => {
    const store = new BoardStore(), harvest = new BoardLinkHarvest(store, 4491)
    harvest.observe({ ...turn('working', 1), chat: false })
    harvest.observe({ ...turn('done', 2), chat: false, status: { ...status('done', 2), details: { recentActivities: [], checks: [], recap: { summary: 'Done', outcome: 'done', completedAt: 2 } } } })
    expect(store.get(target).items).toHaveLength(1)
    harvest.remove('%1'); harvest.observe(turn('done', 3, 'https://fresh.example'))
    expect(store.get(target).items).toHaveLength(1)
  })
})
