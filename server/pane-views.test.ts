import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PaneViews } from './pane-views.js'

const dirs: string[] = []
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))) })

describe('PaneViews', () => {
  it('records the latest view of each pane', () => {
    const views = new PaneViews()
    views.record(['%1', '%2'], 100)
    views.record(['%2'], 200)
    expect(views.snapshot()).toEqual({ '%1': 100, '%2': 200 })
  })

  it('keeps views across restarts of the same tmux server only', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pane-views-'))
    dirs.push(dir)
    const path = join(dir, 'pane-views.json')
    const first = new PaneViews(path)
    first.bindServer('server-a')
    first.record(['%4'], 300)
    first.flush()

    const same = new PaneViews(path)
    same.bindServer('server-a')
    expect(same.snapshot()).toEqual({ '%4': 300 })

    const other = new PaneViews(path)
    other.bindServer('server-b')
    expect(other.snapshot()).toEqual({})
  })
})
