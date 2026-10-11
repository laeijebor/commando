import { createServer, type Server } from 'node:http'
import { mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatImageStore, chatImagesDir, handleChatImage, handleChatImageUpload, sniffImageType } from './chat-images.js'

const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex')
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10])
const GIF = Buffer.from('GIF89a\x01\x00\x01\x00', 'latin1')
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBPVP8 ')])

let dir: string
let store: ChatImageStore

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'chat-images-'))
  store = new ChatImageStore(join(dir, 'images'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('chat image store', () => {
  it('recognises images by their bytes, not their name', () => {
    expect(sniffImageType(PNG)).toBe('image/png')
    expect(sniffImageType(JPEG)).toBe('image/jpeg')
    expect(sniffImageType(GIF)).toBe('image/gif')
    expect(sniffImageType(WEBP)).toBe('image/webp')
    expect(sniffImageType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull()
  })

  it('stores an image once under its content hash', async () => {
    const first = await store.save(PNG)
    const second = await store.save(PNG)
    expect(first).toEqual(second)
    expect('id' in first && first.id).toMatch(/^[0-9a-f]{64}\.png$/)
    expect(await readdir(store.dir)).toEqual(['id' in first ? first.id : ''])
    expect(await store.exists('id' in first ? first.id : '')).toBe(true)
    expect(await store.exists('../secret')).toBe(false)
  })

  it('refuses other files, empty bodies and images over the limit', async () => {
    expect(await store.save(Buffer.from('hello'))).toEqual({ error: 'unsupported' })
    expect(await store.save(Buffer.alloc(0))).toEqual({ error: 'empty' })
    expect(await store.save(Buffer.concat([PNG, Buffer.alloc(64)]), 32)).toEqual({ error: 'too_large' })
  })

  it('stores base64 images from tool results and keeps their name', () => {
    expect(store.saveBase64(JPEG.toString('base64'), 'shot.jpg')).toMatchObject({ id: expect.stringMatching(/\.jpg$/), name: 'shot.jpg' })
    expect(store.saveBase64(Buffer.from('not an image').toString('base64'))).toBeUndefined()
  })

  it('prunes old images and leftover temporaries, and nothing else', async () => {
    const saved = await store.save(GIF)
    const id = 'id' in saved ? saved.id : ''
    const fresh = await store.save(WEBP)
    await writeFile(join(store.dir, 'notes.txt'), 'keep')
    const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000)
    await utimes(join(store.dir, id), old, old)
    await utimes(join(store.dir, 'notes.txt'), old, old)
    expect(await store.prune()).toBe(1)
    expect((await readdir(store.dir)).sort()).toEqual(['id' in fresh ? fresh.id : '', 'notes.txt'].sort())
  })

  it('logs once when images cannot be written, and keeps going', async () => {
    const blocked = join(dir, 'not-a-folder')
    await writeFile(blocked, 'x')
    const log = vi.fn()
    const store = new ChatImageStore(join(blocked, 'images'), log)
    expect(store.saveBase64(PNG.toString('base64'))).toBeUndefined()
    expect(store.saveBase64(JPEG.toString('base64'))).toBeUndefined()
    expect(log).toHaveBeenCalledTimes(1)
    expect(log.mock.calls[0]![0]).toMatch(/Couldn't store chat images in .*not-a-folder\/images/)
  })

  it('prunes nothing before the folder exists, but reports other failures', async () => {
    expect(await new ChatImageStore(join(dir, 'never-made')).prune()).toBe(0)
    const file = join(dir, 'file')
    await writeFile(file, 'x')
    await expect(new ChatImageStore(file).prune()).rejects.toThrow(/ENOTDIR/)
  })

  it('can be pointed at another folder', () => {
    expect(chatImagesDir({ COMMANDO_CHAT_IMAGES_DIR: '/tmp/x' })).toBe('/tmp/x')
    expect(chatImagesDir({})).toMatch(/\.commando\/chat-images$/)
  })
})

describe('chat image routes', () => {
  let server: Server
  let base: string

  beforeEach(async () => {
    server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://localhost')
      void (async () => {
        if (await handleChatImageUpload(request, response, url, store)) return
        if (await handleChatImage(request, response, url, store)) return
        response.writeHead(404)
        response.end()
      })()
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve))
  })

  it('uploads an image and serves it back with its type', async () => {
    const upload = await fetch(`${base}/api/chat/images`, { method: 'POST', body: PNG, headers: { 'Content-Type': 'image/png' } })
    expect(upload.status).toBe(201)
    const { image } = await upload.json() as { image: { id: string } }
    const served = await fetch(`${base}/chat-images/${image.id}`)
    expect(served.status).toBe(200)
    expect(served.headers.get('content-type')).toBe('image/png')
    expect(served.headers.get('x-content-type-options')).toBe('nosniff')
    expect(Buffer.from(await served.arrayBuffer())).toEqual(PNG)
  })

  it('refuses non-images, wrong methods and unknown ids', async () => {
    const text = await fetch(`${base}/api/chat/images`, { method: 'POST', body: '<svg/>', headers: { 'Content-Type': 'image/png' } })
    expect(text.status).toBe(415)
    expect((await text.json() as { error: string }).error).toMatch(/PNG, JPEG, GIF and WebP/)
    expect((await fetch(`${base}/api/chat/images`)).status).toBe(405)
    expect((await fetch(`${base}/chat-images/${'0'.repeat(64)}.png`)).status).toBe(404)
    expect((await fetch(`${base}/chat-images/..%2Fsecret`)).status).toBe(404)
  })

  it('refuses an upload over 10 MB', async () => {
    const big = Buffer.concat([PNG, Buffer.alloc(10 * 1024 * 1024)])
    const response = await fetch(`${base}/api/chat/images`, { method: 'POST', body: big })
    expect(response.status).toBe(413)
  })
})
