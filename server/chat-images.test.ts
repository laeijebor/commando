import { createServer, type Server } from 'node:http'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatImageStore, chatImagesDir, handleChatImage, handleChatImageUpload, looksLikeSvg, sniffImageType, stillZoom, svgReferencesFiles } from './chat-images.js'

const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex')
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10])
const GIF = Buffer.from('GIF89a\x01\x00\x01\x00', 'latin1')
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBPVP8 ')])
const SVG = Buffer.from('<?xml version="1.0"?>\n<!-- drawn by a test -->\n<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20" viewBox="0 0 40 20"><rect width="40" height="20" fill="#36c"/></svg>')

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

  it('copies an image into one session folder, outside the store', async () => {
    const saved = await store.save(PNG)
    const id = 'id' in saved ? saved.id : ''
    const sessionDir = store.sessionDir('abcd1234-0000')
    expect(sessionDir).toBe(join(dir, 'chat-image-sessions', 'abcd1234-0000'))
    expect(await readdir(sessionDir)).toEqual([])
    const path = await store.stage(id, 'abcd1234-0000')
    expect(path).toBe(join(sessionDir, id))
    expect(await readFile(path)).toEqual(PNG)
    expect(await readdir(store.sessionDir('ffff0000-1111'))).toEqual([])
    // A copy, not a link: what Claude does to it can't reach the store.
    await writeFile(path, 'changed')
    expect(await readFile(join(store.dir, id))).toEqual(PNG)
    expect(await readFile(await store.stage(id, 'abcd1234-0000'))).toEqual(PNG)
    expect(await readdir(sessionDir)).toEqual([id])
  })

  it('recognises only staged copies by their path', () => {
    const id = `${'a'.repeat(64)}.png`
    expect(store.stagedImage(join(store.sessionsDir, 'abcd1234-0000', id))).toEqual({ id, sessionId: 'abcd1234-0000' })
    expect(store.stagedImage(join(store.dir, id))).toBeNull()
    expect(store.stagedImage(join(store.sessionsDir, '..', 'abcd1234-0000', id))).toBeNull()
    expect(store.stagedImage(join(store.sessionsDir, 'abcd1234-0000', 'notes.txt'))).toBeNull()
  })

  it('refuses session ids that could name another folder', async () => {
    const saved = await store.save(PNG)
    const id = 'id' in saved ? saved.id : ''
    expect(() => store.sessionDir('../images')).toThrow(/Invalid session id/)
    await expect(store.stage(id, '../../x')).rejects.toThrow(/Invalid session id/)
    await expect(store.stage('../secret', 'abcd1234-0000')).rejects.toThrow(/Invalid image id/)
  })

  it('prunes old copies in session folders, and folders left old and empty', async () => {
    const saved = await store.save(PNG)
    const id = 'id' in saved ? saved.id : ''
    const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000)
    const stale = await store.stage(id, 'stale000-0000')
    await utimes(stale, old, old)
    await utimes(join(stale, '..'), old, old)
    const kept = await store.stage(id, 'fresh000-0000')
    store.sessionDir('empty000-0000')
    await mkdir(join(store.sessionsDir, 'not a session'))
    expect(await store.prune()).toBe(1)
    expect((await readdir(store.sessionsDir)).sort()).toEqual(['empty000-0000', 'fresh000-0000', 'not a session'])
    expect((await stat(kept)).isFile()).toBe(true)
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

  it('recognises SVG documents, and nothing that merely mentions one', () => {
    expect(looksLikeSvg(SVG)).toBe(true)
    expect(looksLikeSvg(Buffer.from('\uFEFF<svg viewBox="0 0 1 1"/>'))).toBe(true)
    expect(looksLikeSvg(Buffer.from('<html><svg></svg></html>'))).toBe(false)
    expect(looksLikeSvg(Buffer.from('# notes about <svg>'))).toBe(false)
    expect(looksLikeSvg(Buffer.concat([Buffer.from('<svg>'), Buffer.from([0])]))).toBe(false)
  })

  it('never draws an SVG that refers to other files', () => {
    expect(svgReferencesFiles(SVG)).toBe(false)
    expect(svgReferencesFiles(Buffer.from('<svg><use href="#a"/><image href="data:image/png;base64,AAAA"/></svg>'))).toBe(false)
    expect(svgReferencesFiles(Buffer.from('<svg><image xlink:href="/Users/me/Desktop/secret.png"/></svg>'))).toBe(true)
    expect(svgReferencesFiles(Buffer.from("<svg><image href = ' secret.png'/></svg>"))).toBe(true)
    expect(svgReferencesFiles(Buffer.from('<svg><image href="&#47;etc/x.png"/></svg>'))).toBe(true)
  })

  it('draws at twice the size, within 1600 by 4096 pixels', () => {
    expect(stillZoom(40, 20)).toBe(2)
    expect(stillZoom(1708, 428)).toBeCloseTo(1600 / 1708)
    expect(stillZoom(1600, 200_000)).toBeCloseTo(4096 / 200_000)
  })

  it('stores reply images, SVG included, which uploads still refuse', async () => {
    expect(await store.saveReplyImage(PNG)).toEqual(await store.save(PNG))
    const svg = await store.saveReplyImage(SVG)
    expect('id' in svg && svg.id).toMatch(/^[0-9a-f]{64}\.svg$/)
    expect(await store.save(SVG)).toEqual({ error: 'unsupported' })
    expect(await store.saveReplyImage(Buffer.from('plain text'))).toEqual({ error: 'unsupported' })
    // Attachment paths stay raster-only: an SVG never reaches Claude.
    expect(store.path('id' in svg ? svg.id : '')).toBeNull()
    expect(store.servedPath('id' in svg ? svg.id : '')).toBe(join(store.dir, 'id' in svg ? svg.id : ''))
  })

  it('draws an SVG as a PNG once, on first use', async () => {
    const saved = await store.saveReplyImage(SVG)
    const id = 'id' in saved ? saved.id : ''
    const [first, second] = await Promise.all([store.still(id), store.still(id)])
    expect(first).toBe(join(store.dir, `${id}.png`))
    expect(second).toBe(first)
    const png = await readFile(first!)
    expect(sniffImageType(png)).toBe('image/png')
    // Twice the SVG's 40px width.
    expect(png.readUInt32BE(16)).toBe(80)
    expect(await store.still(`${'0'.repeat(64)}.svg`)).toBeNull()
    // Only SVGs are drawn.
    expect(await store.still(`${'1'.repeat(64)}.png`)).toBeNull()
  })

  it('refuses to draw an SVG that refers to a file on disk, and keeps a tall one within bounds', async () => {
    const logs: string[] = []
    const logged = new ChatImageStore(join(dir, 'logged'), (message) => logs.push(message))
    const still = async (svg: string) => {
      const saved = await logged.saveReplyImage(Buffer.from(svg))
      return logged.still('id' in saved ? saved.id : '')
    }
    expect(await still('<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="10" height="10"><image xlink:href="/tmp/secret.png" width="10" height="10"/></svg>')).toBeNull()
    expect(logs).toEqual([expect.stringContaining('refers to other files')])
    const tall = await still('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000000"><rect width="1000" height="1000000"/></svg>')
    expect((await readFile(tall!)).readUInt32BE(20)).toBe(4096)
    // So thin that it scales to nothing: refused, not drawn huge.
    expect(await still('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1000000"><rect width="1" height="1000000"/></svg>')).toBeNull()
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

  it('serves a reply SVG with scripts off, and its PNG drawn on request', async () => {
    const saved = await store.saveReplyImage(SVG)
    const id = 'id' in saved ? saved.id : ''
    const svg = await fetch(`${base}/chat-images/${id}`)
    expect(svg.status).toBe(200)
    expect(svg.headers.get('content-type')).toBe('image/svg+xml')
    expect(svg.headers.get('content-security-policy')).toMatch(/default-src 'none'.*sandbox/)
    const still = await fetch(`${base}/chat-images/${id}.png`)
    expect(still.status).toBe(200)
    expect(still.headers.get('content-type')).toBe('image/png')
    expect(sniffImageType(Buffer.from(await still.arrayBuffer()))).toBe('image/png')
    expect((await fetch(`${base}/chat-images/${'0'.repeat(64)}.svg.png`)).status).toBe(404)
  })

  it('refuses an upload over 10 MB', async () => {
    const big = Buffer.concat([PNG, Buffer.alloc(10 * 1024 * 1024)])
    const response = await fetch(`${base}/api/chat/images`, { method: 'POST', body: big })
    expect(response.status).toBe(413)
  })
})
