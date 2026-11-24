import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { TileViews } from './tile-views.js'

const dirs: string[] = []
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))) })

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
