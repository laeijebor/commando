import { describe, expect, it } from 'vitest'
import type { TmuxPane, WebPane } from '../shared/protocol'
import { embeddableUrl, matchesTileQuery, sortTileRows, tileKind, tileRows, type TileListContext } from './tilesList'

const tile = (id: string, extra: Partial<WebPane> = {}): WebPane => ({
  id, url: `http://localhost:3000/${id}`, sessionId: '$1', windowId: '@1', anchorPaneId: '%1', placement: 'right', dock: 'panel',
  engine: 'webkit', openedBy: 'user', status: 'open', createdAt: 10, ...extra,
} as WebPane)

function context(tiles: WebPane[], extra: Partial<TileListContext> = {}): TileListContext {
  return {
    tiles,
    sessions: [{ id: '$1', name: 'alpha', attached: false, activeWindowId: null, windowIds: [] }],
    panes: [{ id: '%1', targetId: 't', index: 0, windowId: '@1', sessionId: '$1', title: '', command: 'claude', path: '/', active: true, dead: false, chatTitle: 'Fix login' } as TmuxPane],
    viewedAt: {},
    viewing: new Set(),
    label: (item) => `label ${item.id}`,
    ...extra,
  }
}

describe('tileKind', () => {
  it('names each kind of tile', () => {
    expect([
      tile('a'),
      tile('b', { url: '', content: { kind: 'simulator', udid: 'U' } }),
      tile('c', { url: '', content: { kind: 'canvas', artifactId: 'x', manifest: 'deck.html' } }),
      tile('d', { url: '', content: { kind: 'canvas', artifactId: 'x', manifest: 'canvas.json' } }),
      tile('e', { url: '', content: { kind: 'guide', artifactId: 'x', file: 'guide.md' } }),
    ].map(tileKind)).toEqual(['Page', 'Simulator', 'Slides', 'Canvas', 'Guide'])
  })
})

describe('tileRows', () => {
  it('describes where each tile lives and who opened it', () => {
    const [row] = tileRows(context([tile('w-1', { dock: 'split', openedBy: 'agent', openerLabel: 'claude' })], { viewedAt: { 'w-1': 50 } }))
    expect(row).toMatchObject({ label: 'label w-1', sessionName: 'alpha', paneLabel: 'Fix login', placement: 'Split', openedBy: 'claude', viewedAt: 50, viewing: false })
  })
})

describe('sortTileRows', () => {
  it('puts never-viewed tiles first and on-screen tiles last', () => {
    const rows = tileRows(context([tile('a', { createdAt: 3 }), tile('b', { createdAt: 2 }), tile('c', { createdAt: 1 })], {
      viewedAt: { a: 100, b: 200 }, viewing: new Set(['b']),
    }))
    expect(sortTileRows(rows, 'viewed').map((row) => row.tile.id)).toEqual(['c', 'a', 'b'])
    expect(sortTileRows(rows, 'created').map((row) => row.tile.id)).toEqual(['c', 'b', 'a'])
  })
})

describe('matchesTileQuery', () => {
  it('matches label, kind, pane and url', () => {
    const [row] = tileRows(context([tile('w-1')]))
    expect(['label w-1', 'page', 'fix login', 'localhost:3000', 'nope'].map((query) => matchesTileQuery(row, query))).toEqual([true, true, true, true, false])
  })
})

describe('embeddableUrl', () => {
  it('embeds only confirmed http pages', () => {
    expect(embeddableUrl(tile('a'))).toBe('http://localhost:3000/a')
    expect(embeddableUrl(tile('b', { status: 'pending' }))).toBeUndefined()
    expect(embeddableUrl(tile('c', { url: '', content: { kind: 'simulator', udid: 'U' } }))).toBeUndefined()
    expect(embeddableUrl(tile('d', { url: 'file:///etc/passwd' }))).toBeUndefined()
  })
})
