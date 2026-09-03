import { mkdir, mkdtemp, rm, symlink, truncate, utimes, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { realpathSync } from 'node:fs'
import { PassThrough } from 'node:stream'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  PaneScreenshotRegistry,
  handlePaneScreenshotImage,
  MAX_SCREENSHOT_FILE_BYTES,
  MAX_SCREENSHOT_FILES,
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

    const first = await registry.register('%1', root)
    const second = await registry.register('%1', root)

    expect(second.id).toBe(first.id)
    expect(second.preview.map((file) => file.name)).toEqual(['newer.webp', 'older.PNG'])
    expect(second).toMatchObject({ imageCount: 2, otherCount: 1, bytes: 3 + 5 + 9 })
    await expect(registry.resolveImage(first.id, 'newer.webp')).resolves.toBe(realpathSync(join(root, 'newer.webp')))
    await expect(registry.resolveImage(first.id, 'escaped.png')).resolves.toBeNull()
    await expect(registry.resolveImage(first.id, '../escaped.png')).resolves.toBeNull()
  })

  it('evicts the oldest pane folder and enforces the global cap', async () => {
    let clock = 1
    const registry = new PaneScreenshotRegistry({ now: () => clock })
    const paneDirs: string[] = []
    for (let index = 0; index < 6; index += 1) {
      const directory = await temporaryDirectory()
      paneDirs.push(directory)
      await registry.register('%1', directory)
      clock += 1
    }
    await expect(registry.registrationsForPane('%1')).resolves.toHaveLength(5)
    expect((await registry.registrationsForPane('%1')).map((folder) => folder.dir)).not.toContain(paneDirs[0])

    const ids: string[] = []
    for (let index = 0; index <= PANE_SCREENSHOT_GLOBAL_LIMIT; index += 1) {
      const directory = await temporaryDirectory()
      ids.push((await registry.register(`%${index + 10}`, directory)).id)
      clock += 1
    }
    expect(registry.isRegisteredForPane('%10', ids[0])).toBe(false)
    expect(registry.isRegisteredForPane(`%${PANE_SCREENSHOT_GLOBAL_LIMIT + 10}`, ids.at(-1)!)).toBe(true)
  })

  it('expires registrations and reports a folder removed after publish as missing', async () => {
    let clock = 1_000
    const root = await temporaryDirectory()
    const registry = new PaneScreenshotRegistry({ now: () => clock })
    const folder = await registry.register('%3', root)
    await rm(root, { recursive: true })

    await expect(registry.list(folder.id)).resolves.toMatchObject({ missing: true, files: [], preview: [] })
    clock += PANE_SCREENSHOT_TTL_MS + 1
    await expect(registry.list(folder.id)).resolves.toBeNull()
  })

  it('strictly revalidates persisted registrations on load', async () => {
    const parent = await temporaryDirectory()
    const root = join(parent, 'shots')
    await mkdir(root)
    const statePath = join(parent, 'registry.json')
    const first = new PaneScreenshotRegistry({ statePath, now: () => 500 })
    const folder = await first.register('%4', root)

    const replay = new PaneScreenshotRegistry({ statePath, now: () => 501 })
    expect((await replay.registrationsForPane('%4'))[0]?.id).toBe(folder.id)

    await rm(root, { recursive: true })
    const missingReplay = new PaneScreenshotRegistry({ statePath, now: () => 502 })
    await expect(missingReplay.registrationsForPane('%4')).resolves.toEqual([])
  })

  it('caps scans, marks truncated listings, and omits oversized images', async () => {
    const capped = await temporaryDirectory()
    await Promise.all(Array.from({ length: MAX_SCREENSHOT_FILES + 1 }, (_, index) => (
      writeFile(join(capped, `${String(index).padStart(3, '0')}.png`), '')
    )))
    const registry = new PaneScreenshotRegistry()
    const folder = await registry.register('%5', capped)
    const listing = await registry.list(folder.id)
    expect(listing).toMatchObject({ imageCount: MAX_SCREENSHOT_FILES, truncated: true })
    expect(listing?.preview).toHaveLength(6)

    const oversized = await temporaryDirectory()
    const oversizedPath = join(oversized, 'huge.png')
    await writeFile(oversizedPath, '')
    await truncate(oversizedPath, MAX_SCREENSHOT_FILE_BYTES + 1)
    const oversizedFolder = await registry.register('%6', oversized)
    await expect(registry.list(oversizedFolder.id)).resolves.toMatchObject({ imageCount: 0, files: [] })
  })

  it('returns 404 for an escaping symlink and streams a confined image with descriptor headers', async () => {
    const root = await temporaryDirectory()
    const outside = await temporaryDirectory('commando-pane-screenshots-outside-route-')
    await writeFile(join(root, 'inside.png'), 'streamed-image')
    await writeFile(join(outside, 'outside.png'), 'secret')
    await symlink(join(outside, 'outside.png'), join(root, 'escaped.png'))
    const registry = new PaneScreenshotRegistry()
    const folder = await registry.register('%7', root)

    const request = { method: 'GET' } as IncomingMessage
    const escaped = new PassThrough() as unknown as ServerResponse
    escaped.writeHead = vi.fn().mockReturnValue(escaped)
    const escapedDone = once(escaped, 'finish')
    await expect(handlePaneScreenshotImage(request, escaped, new URL(`http://localhost/screenshots/${folder.id}/escaped.png`), registry)).resolves.toBe(true)
    await escapedDone
    expect(escaped.writeHead).toHaveBeenCalledWith(404, { 'Cache-Control': 'no-store' })

    const streamed = new PassThrough() as unknown as ServerResponse
    const chunks: Buffer[] = []
    streamed.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
    streamed.writeHead = vi.fn().mockReturnValue(streamed)
    const streamedDone = once(streamed, 'finish')
    await expect(handlePaneScreenshotImage(request, streamed, new URL(`http://localhost/screenshots/${folder.id}/inside.png`), registry)).resolves.toBe(true)
    await streamedDone
    expect(streamed.writeHead).toHaveBeenCalledWith(200, expect.objectContaining({
      'Content-Length': 14,
      'Content-Type': 'image/png',
      'X-Content-Type-Options': 'nosniff',
    }))
    expect(Buffer.concat(chunks).toString()).toBe('streamed-image')
  })
})
