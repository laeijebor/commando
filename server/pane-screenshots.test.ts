import { mkdir, mkdtemp, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { realpathSync } from 'node:fs'

import { afterEach, describe, expect, it } from 'vitest'

import {
  PaneScreenshotRegistry,
  PANE_SCREENSHOT_GLOBAL_LIMIT,
  PANE_SCREENSHOT_TTL_MS,
} from './pane-screenshots.js'

const directories: string[] = []

async function temporaryDirectory(prefix = 'commando-pane-screenshots-'): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  directories.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('PaneScreenshotRegistry', () => {
  it('keeps ids stable, lists newest images first, and confines symlinks', async () => {
    const root = await temporaryDirectory()
    const outside = await temporaryDirectory('commando-pane-screenshots-outside-')
    await writeFile(join(root, 'older.PNG'), 'old')
    await writeFile(join(root, 'newer.webp'), 'newer')
    await writeFile(join(root, 'notes.sh'), '#!/bin/sh')
    await writeFile(join(outside, 'escaped.png'), 'secret')
    await symlink(join(outside, 'escaped.png'), join(root, 'escaped.png'))
    await utimes(join(root, 'older.PNG'), new Date(1_000), new Date(1_000))
    await utimes(join(root, 'newer.webp'), new Date(2_000), new Date(2_000))
    const registry = new PaneScreenshotRegistry()

    const first = registry.register('%1', root)
    const second = registry.register('%1', root)

    expect(second.id).toBe(first.id)
    expect(second.preview.map((file) => file.name)).toEqual(['newer.webp', 'older.PNG'])
    expect(second).toMatchObject({ imageCount: 2, otherCount: 1, bytes: 3 + 5 + 9 })
    expect(registry.resolveImage(first.id, 'newer.webp')).toBe(realpathSync(join(root, 'newer.webp')))
    expect(registry.resolveImage(first.id, 'escaped.png')).toBeNull()
    expect(registry.resolveImage(first.id, '../escaped.png')).toBeNull()
  })

  it('evicts the oldest pane folder and enforces the global cap', async () => {
    let clock = 1
    const registry = new PaneScreenshotRegistry({ now: () => clock })
    const paneDirs: string[] = []
    for (let index = 0; index < 6; index += 1) {
      const directory = await temporaryDirectory()
      paneDirs.push(directory)
      registry.register('%1', directory)
      clock += 1
    }
    expect(registry.registrationsForPane('%1')).toHaveLength(5)
    expect(registry.registrationsForPane('%1').map((folder) => folder.dir)).not.toContain(paneDirs[0])

    const ids: string[] = []
    for (let index = 0; index <= PANE_SCREENSHOT_GLOBAL_LIMIT; index += 1) {
      const directory = await temporaryDirectory()
      ids.push(registry.register(`%${index + 10}`, directory).id)
      clock += 1
    }
    expect(registry.isRegisteredForPane('%10', ids[0])).toBe(false)
    expect(registry.isRegisteredForPane(`%${PANE_SCREENSHOT_GLOBAL_LIMIT + 10}`, ids.at(-1)!)).toBe(true)
  })

  it('expires registrations and reports a folder removed after publish as missing', async () => {
    let clock = 1_000
    const root = await temporaryDirectory()
    const registry = new PaneScreenshotRegistry({ now: () => clock })
    const folder = registry.register('%3', root)
    await rm(root, { recursive: true })

    expect(registry.list(folder.id)).toMatchObject({ missing: true, files: [], preview: [] })
    clock += PANE_SCREENSHOT_TTL_MS + 1
    expect(registry.list(folder.id)).toBeNull()
  })

  it('strictly revalidates persisted registrations on load', async () => {
    const parent = await temporaryDirectory()
    const root = join(parent, 'shots')
    await mkdir(root)
    const statePath = join(parent, 'registry.json')
    const first = new PaneScreenshotRegistry({ statePath, now: () => 500 })
    const folder = first.register('%4', root)

    const replay = new PaneScreenshotRegistry({ statePath, now: () => 501 })
    expect(replay.registrationsForPane('%4')[0]?.id).toBe(folder.id)

    await rm(root, { recursive: true })
    const missingReplay = new PaneScreenshotRegistry({ statePath, now: () => 502 })
    expect(missingReplay.registrationsForPane('%4')).toEqual([])
  })
})
