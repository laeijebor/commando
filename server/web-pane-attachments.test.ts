import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  MAX_WEB_PANE_ATTACHMENT_SIZE,
  WebPaneAttachmentError,
  WebPaneAttachmentStore,
} from './web-pane-attachments.js'

const dirs: string[] = []

function makeStore(): { dir: string; store: WebPaneAttachmentStore } {
  const root = mkdtempSync(join(tmpdir(), 'commando-attachments-'))
  dirs.push(root)
  const dir = join(root, 'attachments')
  return { dir, store: new WebPaneAttachmentStore({ dir }) }
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const images = [
  { contentType: 'image/png', extension: 'png', data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]) },
  { contentType: 'image/jpeg', extension: 'jpg', data: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1]) },
  { contentType: 'image/gif', extension: 'gif', data: Buffer.from('GIF89a payload') },
  { contentType: 'image/webp', extension: 'webp', data: Buffer.from('RIFF\x04\x00\x00\x00WEBPdata', 'binary') },
] as const

const mismatchedImages = images.map((image, index) => ({
  contentType: image.contentType,
  data: images[(index + 1) % images.length]!.data,
}))

function expectStatus(action: () => unknown, status: number): void {
  try {
    action()
    throw new Error('Expected attachment operation to fail')
  } catch (error) {
    expect(error).toBeInstanceOf(WebPaneAttachmentError)
    expect((error as WebPaneAttachmentError).status).toBe(status)
  }
}

describe('WebPaneAttachmentStore', () => {
  it.each(images)('saves and reads $contentType with a validated .$extension id', ({ contentType, extension, data }) => {
    const { dir, store } = makeStore()
    const metadata = store.save({ name: `capture.${extension}`, contentType, data })

    expect(metadata).toEqual({
      id: expect.stringMatching(new RegExp(`^[0-9a-f-]{36}\\.${extension}$`)),
      name: `capture.${extension}`,
      contentType,
      size: data.byteLength,
    })
    expect(store.listIds()).toEqual([metadata.id])
    expect(new WebPaneAttachmentStore({ dir }).read(metadata.id)).toEqual({ metadata, data })
  })

  it('accepts both valid GIF signatures', () => {
    const { store } = makeStore()
    const first = store.save({ name: 'old.gif', contentType: 'image/gif', data: Buffer.from('GIF87a data') })
    const second = store.save({ name: 'new.gif', contentType: 'image/gif', data: Buffer.from('GIF89a data') })
    expect(store.listIds()).toEqual([first.id, second.id].sort())
  })

  it.each(mismatchedImages)('rejects bytes that do not match $contentType', ({ contentType, data }) => {
    const { store } = makeStore()
    expectStatus(() => store.save({ name: 'mismatch', contentType, data }), 415)
  })

  it('rejects unsupported and disguised MIME types', () => {
    const { store } = makeStore()
    expectStatus(() => store.save({ name: 'image.bmp', contentType: 'image/bmp', data: images[0].data }), 415)
    expectStatus(() => store.save({ name: 'image.png', contentType: 'application/octet-stream', data: images[0].data }), 415)
    expectStatus(() => store.save({ name: 'image.png', contentType: 'image/png; charset=binary', data: images[0].data }), 415)
  })

  it('rejects empty and oversized images while accepting the exact limit', () => {
    const { store } = makeStore()
    expectStatus(() => store.save({ name: 'empty.png', contentType: 'image/png', data: Buffer.alloc(0) }), 400)

    const atLimit = Buffer.alloc(MAX_WEB_PANE_ATTACHMENT_SIZE)
    images[0].data.copy(atLimit)
    expect(store.save({ name: 'limit.png', contentType: 'image/png', data: atLimit }).size).toBe(MAX_WEB_PANE_ATTACHMENT_SIZE)

    const oversized = Buffer.alloc(MAX_WEB_PANE_ATTACHMENT_SIZE + 1)
    images[0].data.copy(oversized)
    expectStatus(() => store.save({ name: 'large.png', contentType: 'image/png', data: oversized }), 413)
  })

  it('sanitizes POSIX and Windows paths, control characters, long names, and empty names', () => {
    const { store } = makeStore()
    const posix = store.save({ name: '/tmp/\u0000screen\n.png', contentType: 'image/png', data: images[0].data })
    const windows = store.save({ name: 'C:\\temp\\photo.png', contentType: 'image/png', data: images[0].data })
    const fallback = store.save({ name: '../\u0000', contentType: 'image/png', data: images[0].data })
    const long = store.save({ name: `${'x'.repeat(300)}.png`, contentType: 'image/png', data: images[0].data })

    expect(posix.name).toBe('screen.png')
    expect(windows.name).toBe('photo.png')
    expect(fallback.name).toBe('image.png')
    expect([...long.name]).toHaveLength(255)
    for (const metadata of [posix, windows, fallback, long]) {
      expect(metadata.name).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/)
      expect(metadata.name).not.toContain('/')
      expect(metadata.name).not.toContain('\\')
    }
  })

  it('persists exact bytes and sanitized metadata across store instances', () => {
    const { dir, store } = makeStore()
    const data = Buffer.concat([images[1].data, Buffer.from([0, 1, 2, 255])])
    const metadata = store.save({ name: '../camera.jpg', contentType: 'IMAGE/JPEG', data })

    const reopened = new WebPaneAttachmentStore({ dir }).read(metadata.id)
    expect(reopened.metadata).toEqual({ ...metadata, name: 'camera.jpg', contentType: 'image/jpeg' })
    expect(Buffer.compare(reopened.data, data)).toBe(0)
  })

  it('rejects malformed and unsafe ids before touching paths', () => {
    const { store } = makeStore()
    const unsafe = [
      '../escape.png',
      'a/b.png',
      'not-a-uuid.png',
      '00000000-0000-4000-8000-000000000000.exe',
      '00000000-0000-4000-8000-000000000000.PNG',
      '00000000-0000-1000-8000-000000000000.png',
    ]
    for (const id of unsafe) {
      expectStatus(() => store.read(id), 400)
      expectStatus(() => store.remove(id), 400)
      expectStatus(() => store.cleanup([id]), 400)
    }
    expectStatus(() => store.removeMany(['00000000-0000-4000-8000-000000000000.png', '../escape.png']), 400)
  })

  it('returns 404 for a safe missing id and rejects corrupted stored bytes', () => {
    const { dir, store } = makeStore()
    expectStatus(() => store.read('00000000-0000-4000-8000-000000000000.png'), 404)

    const metadata = store.save({ name: 'capture.png', contentType: 'image/png', data: images[0].data })
    writeFileSync(join(dir, metadata.id, 'content'), images[1].data)
    expectStatus(() => store.read(metadata.id), 500)
  })

  it('removes one or many attachments idempotently', () => {
    const { store } = makeStore()
    const first = store.save({ name: 'one.png', contentType: 'image/png', data: images[0].data })
    const second = store.save({ name: 'two.jpg', contentType: 'image/jpeg', data: images[1].data })
    const third = store.save({ name: 'three.gif', contentType: 'image/gif', data: images[2].data })

    expect(store.remove(first.id)).toBe(true)
    expect(store.remove(first.id)).toBe(false)
    expect(store.removeMany([second.id, second.id, third.id])).toBe(2)
    expect(store.listIds()).toEqual([])
  })

  it('cleans unreferenced attachments and incomplete or unknown entries', () => {
    const { dir, store } = makeStore()
    const keep = store.save({ name: 'keep.png', contentType: 'image/png', data: images[0].data })
    store.save({ name: 'drop.jpg', contentType: 'image/jpeg', data: images[1].data })
    mkdirSync(join(dir, '.tmp-abandoned'))
    writeFileSync(join(dir, 'unknown'), 'stale')

    expect(store.cleanup(new Set([keep.id]))).toBe(3)
    expect(readdirSync(dir)).toEqual([keep.id])
    expect(store.listIds()).toEqual([keep.id])
  })

  it('uses private modes for the store, attachment directory, and files', () => {
    const { dir, store } = makeStore()
    chmodSync(dir.slice(0, dir.lastIndexOf('/')), 0o777)
    const metadata = store.save({ name: 'private.webp', contentType: 'image/webp', data: images[3].data })
    const attachmentDir = join(dir, metadata.id)

    expect(statSync(dir).mode & 0o777).toBe(0o700)
    expect(statSync(attachmentDir).mode & 0o777).toBe(0o700)
    expect(statSync(join(attachmentDir, 'content')).mode & 0o777).toBe(0o600)
    expect(statSync(join(attachmentDir, 'metadata.json')).mode & 0o777).toBe(0o600)
    expect(readFileSync(join(attachmentDir, 'content'))).toEqual(images[3].data)
  })
})
