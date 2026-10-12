import { createServer, type Server } from 'node:http'
import { mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MAX_CHAT_STASH_BYTES, MAX_CHAT_STASH_ENTRIES, MAX_CHAT_STASH_TEXT, type ChatStashInput } from '../shared/chat-stash.js'
import { ChatImageStore } from './chat-images.js'
import { ChatStashStore, handleChatStashApi } from './chat-stash.js'

const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex')
const source = { paneId: '%3', sessionId: 'abc-123', title: 'Fix the login', cwd: '/work' }
const draft = (text: string, images: ChatStashInput['images'] = []): ChatStashInput => ({ text, images, source })

let dir: string
let images: ChatImageStore
let path: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'chat-stash-'))
  images = new ChatImageStore(join(dir, 'images'))
  path = join(dir, 'chat-stash.json')
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('chat stash store', () => {
  it('lists the newest draft first and takes entries out by id', async () => {
    const store = new ChatStashStore(path, images)
    const first = await store.push(draft('first'), 1_000)
    const second = await store.push(draft('second'), 1_000)
    expect(store.list().map((entry) => entry.text)).toEqual(['second', 'first'])
    expect(second.source).toEqual(source)

    expect((await store.take(first.id))?.entry.text).toBe('first')
    expect(await store.take(first.id)).toBeNull()
    expect(store.list().map((entry) => entry.id)).toEqual([second.id])
  })

  it('keeps the stash across a restart', async () => {
    const saved = await images.save(PNG)
    const image = { id: 'id' in saved ? saved.id : '', name: 'shot.png' }
    const store = new ChatStashStore(path, images)
    await store.push(draft('with a picture', [image]), 5)
    await store.push(draft('plain'), 6)

    const reloaded = new ChatStashStore(path, images)
    await reloaded.load()
    expect(reloaded.list()).toEqual(store.list())
    expect((await stat(path)).mode & 0o777).toBe(0o600)
  })

  it('drops the oldest entries past the count and size caps', async () => {
    const store = new ChatStashStore(path)
    for (let index = 0; index < MAX_CHAT_STASH_ENTRIES + 3; index += 1) await store.push(draft(`draft ${index}`), index)
    expect(store.list()).toHaveLength(MAX_CHAT_STASH_ENTRIES)
    expect(store.list()[0]?.text).toBe(`draft ${MAX_CHAT_STASH_ENTRIES + 2}`)
    expect(store.list().at(-1)?.text).toBe('draft 3')

    const big = 'x'.repeat(MAX_CHAT_STASH_TEXT)
    for (let index = 0; index < 5; index += 1) await store.push(draft(big), 100 + index)
    const kept = store.list()
    expect(kept.reduce((total, entry) => total + entry.text.length, 0)).toBeLessThanOrEqual(MAX_CHAT_STASH_BYTES)
    expect(kept.every((entry) => entry.text === big)).toBe(true)
  })

  it('skips damaged entries instead of losing the whole stash', async () => {
    const good = { id: 'a'.repeat(32), createdAt: 1, text: 'kept', images: [], source }
    await writeFile(path, JSON.stringify({ version: 1, entries: [good, { id: 'nope', text: 'bad' }, { ...good, id: 'b'.repeat(32), text: '', images: [] }] }))
    const store = new ChatStashStore(path)
    await store.load()
    expect(store.list()).toEqual([good])
    await writeFile(path, '{')
    await expect(new ChatStashStore(path).load()).rejects.toThrow('invalid JSON')
  })

  it('keeps stashed images from the prune and leaves out ones that are gone', async () => {
    const saved = await images.save(PNG)
    const id = 'id' in saved ? saved.id : ''
    const old = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000)
    await utimes(join(images.dir, id), old, old)
    const store = new ChatStashStore(path, images)
    const entry = await store.push(draft('', [{ id }, { id: `${'f'.repeat(64)}.png` }]))
    expect((await stat(join(images.dir, id))).mtimeMs).toBeGreaterThan(old.getTime())

    // Loading touches them too, before the daemon prunes.
    await utimes(join(images.dir, id), old, old)
    await new ChatStashStore(path, images).load()
    expect(await images.prune()).toBe(0)

    const taken = await store.take(entry.id)
    expect(taken?.entry.images).toEqual([{ id }])
    expect(taken?.missingImages).toBe(1)
  })

  it('leaves the list as it was when the file cannot be written', async () => {
    const store = new ChatStashStore(join(dir, 'missing-parent-is-a-file', 'stash.json'))
    await writeFile(join(dir, 'missing-parent-is-a-file'), '')
    await expect(store.push(draft('lost?'))).rejects.toThrow()
    expect(store.list()).toEqual([])
  })
})

describe('chat stash routes', () => {
  let server: Server
  let base: string
  let store: ChatStashStore
  const changed = vi.fn()

  beforeEach(async () => {
    store = new ChatStashStore(path, images)
    changed.mockReset()
    server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://localhost')
      void (async () => {
        if (await handleChatStashApi(request, response, url, store, changed)) return
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

  const post = (body: unknown, contentType = 'application/json') => fetch(`${base}/api/chat/stash`, { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': contentType } })

  it('stashes, lists and takes drafts, announcing each change', async () => {
    const created = await post(draft('hello'))
    expect(created.status).toBe(201)
    const { entry } = await created.json() as { entry: { id: string; text: string } }
    expect(entry.text).toBe('hello')
    expect(changed).toHaveBeenCalledTimes(1)

    const listed = await (await fetch(`${base}/api/chat/stash`)).json() as { entries: unknown[] }
    expect(listed.entries).toHaveLength(1)

    const taken = await fetch(`${base}/api/chat/stash/${entry.id}`, { method: 'DELETE' })
    expect(taken.status).toBe(200)
    expect(await taken.json()).toMatchObject({ entry: { id: entry.id, text: 'hello' }, missingImages: 0 })
    expect(changed).toHaveBeenCalledTimes(2)
    expect((await fetch(`${base}/api/chat/stash/${entry.id}`, { method: 'DELETE' })).status).toBe(404)
    expect(changed).toHaveBeenCalledTimes(2)
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ version: 1, entries: [] })
  })

  it('refuses empty drafts, bad sources, bad ids and other methods', async () => {
    expect((await post(draft('   '))).status).toBe(400)
    expect((await post({ text: 'hi', images: [], source: { paneId: 'nope' } })).status).toBe(400)
    expect((await post({ text: 'hi', images: [{ id: '../etc/passwd' }], source })).status).toBe(400)
    expect((await post(draft('hi'), 'text/plain')).status).toBe(415)
    expect((await fetch(`${base}/api/chat/stash/..%2Fx`, { method: 'DELETE' })).status).toBe(404)
    expect((await fetch(`${base}/api/chat/stash`, { method: 'PUT' })).status).toBe(405)
    expect(changed).not.toHaveBeenCalled()
  })
})
