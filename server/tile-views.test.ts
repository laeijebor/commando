import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { WebPane } from '../shared/protocol.js'
import { TileViews, tilesOnScreen } from './tile-views.js'

const dirs: string[] = []
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))) })

const tile = (id: string, anchorPaneId: string, extra: Partial<WebPane> = {}): WebPane => ({
  id, url: 'http://localhost:3000/', sessionId: '$1', windowId: '@1', anchorPaneId, placement: 'right', dock: 'panel',
  engine: 'webkit', openedBy: 'user', status: 'open', createdAt: 1, ...extra,
} as WebPane)

describe('tilesOnScreen', () => {
  it('counts split tiles and selected tabs of streaming panes only', () => {
    const tiles = [
      tile('w-split', '%1', { dock: 'split' }),
      tile('w-tab', '%1', { activeTab: true }),
      tile('w-behind', '%1'),
      tile('w-other', '%2', { activeTab: true }),
      tile('w-pending', '%1', { dock: 'split', status: 'pending' }),
    ]
    expect([...tilesOnScreen(tiles, new Set(['%1']))]).toEqual(['w-split', 'w-tab'])
  })
})

describe('TileViews', () => {
  it('records when tiles come on and go off screen', () => {
    const views = new TileViews()
    views.update(new Set(['w-a', 'w-b']), 100)
    views.update(new Set(['w-b']), 200)
    views.update(new Set(['w-b']), 300)
    expect(views.snapshot()).toEqual({ viewedAt: { 'w-a': 200, 'w-b': 100 }, viewing: ['w-b'] })
  })

  it('saves times across restarts and forgets closed tiles', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tile-views-'))
    dirs.push(dir)
    const path = join(dir, 'tile-views.json')
    const first = new TileViews(path)
    first.update(new Set(['w-a', 'w-b']), 100)
    first.update(new Set(), 150)
    first.retain(new Set(['w-a']))
    first.flush()
    expect(new TileViews(path).snapshot()).toEqual({ viewedAt: { 'w-a': 150 }, viewing: [] })
  })
})
