import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BoardPreviewQueue, BoardThumbCache, BoardThumbWorker, defaultBoardThumbsPath, thumbHash } from './board-thumbs.js'
import { BoardStore } from './boards.js'
import { BoardsApi } from './boards-api.js'
import type { BoardItem } from '../shared/board.js'

const target = '00000000-0000-4000-8000-000000000001'
const origin = 'http://127.0.0.1:4491'
let root: string
const png = (w = 960, h = 600) => { const b = Buffer.alloc(24); Buffer.from('89504e470d0a1a0a', 'hex').copy(b); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20); return b }
const run = vi.fn(async (command: string, args: string[]) => {
  if (command === 'sips') await writeFile(args.at(-1)!, png(Number(args[args.indexOf('-Z') + 1]), 200))
  else if (command === 'qlmanage') await writeFile(join(args[args.indexOf('-o') + 1], 'output.png'), png(Number(args[args.indexOf('-s') + 1]), 200))
})
const input = (path: string, kind: BoardItem['kind'] = 'screenshot') => ({ key: `file:${path}`, kind, title: 'Source', ref: { path }, source: 'auto' as const })
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'board-thumbs-test-')); run.mockClear() })
afterEach(async () => { vi.useRealTimers(); await rm(root, { recursive: true, force: true }) })
function cache(extra: Partial<ConstructorParameters<typeof BoardThumbCache>[0]> = {}) {
  return new BoardThumbCache({ root: join(root, 'cache'), origin, platform: 'darwin', run, ...extra })
}

describe('BoardPreviewQueue', () => {
  it('starts lazily, yields, deduplicates pending work and runs one job at a time even after errors', async () => {
    const events: string[] = [], errors = vi.fn(), queue = new BoardPreviewQueue(errors)
    let active = 0, maximum = 0
    const job = (id: string) => async () => { maximum = Math.max(maximum, ++active); events.push(id); await new Promise((resolve) => setTimeout(resolve, 2)); active--; if (id === 'a') throw new Error('failure') }
    queue.enqueue('a', job('discarded')); queue.enqueue('a', job('a')); queue.enqueue('b', job('b'))
    expect(events).toEqual([])
    await queue.idle()
    expect(events).toEqual(['a', 'b']); expect(maximum).toBe(1); expect(errors).toHaveBeenCalledOnce()
    queue.stop(); queue.enqueue('c', job('c')); await queue.idle(); expect(events).toEqual(['a', 'b'])
  })
})

describe('Board thumbnails', () => {
  it('hashes canonical source content, reuses two cached sizes and updates the store without extending retention', async () => {
    const file = join(root, 'photo.png'); await writeFile(file, png())
    let now = 1000
    const changed = vi.fn(), store = new BoardStore({ now: () => now, onChange: changed }), c = cache(), queue = new BoardPreviewQueue(), worker = new BoardThumbWorker(store, c, queue)
    store.upsert(target, input(file)); now = 2000
    worker.enqueue(target); await queue.idle()
    const item = store.get(target).items[0]
    expect(item.thumb).toMatchObject({ hash: expect.stringMatching(/^[a-f0-9]{64}$/), w: 960, h: 200 })
    expect(item.updatedAt).toBe(1000); expect(item.source).toBe('auto'); expect(store.get(target).rev).toBe(2); expect(changed).toHaveBeenLastCalledWith(target, 2)
    expect(await readdir(join(root, 'cache'))).toEqual(expect.arrayContaining([`${item.thumb!.hash}-320.png`, `${item.thumb!.hash}-960.png`]))
    worker.enqueue(target); await queue.idle(); expect(run).toHaveBeenCalledTimes(2); expect(store.get(target).rev).toBe(2)
    expect((await c.source(item))?.hash).toBe(item.thumb?.hash)
    worker.stop()
  })
  it('debounces changed sources for five seconds and ignores results for removed items', async () => {
    const file = join(root, 'source.png'); await writeFile(file, png())
    const store = new BoardStore(), c = cache(), queue = new BoardPreviewQueue(), worker = new BoardThumbWorker(store, c, queue)
    store.upsert(target, input(file)); worker.enqueue(target); await queue.idle(); const first = store.get(target).items[0].thumb!.hash
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    await writeFile(file, Buffer.concat([png(), Buffer.from('changed')]))
    worker.enqueue(target); await queue.idle(); expect(run).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(4999); await queue.idle(); expect(run).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1); await queue.idle(); expect(run).toHaveBeenCalledTimes(4)
    expect(store.get(target).items[0].thumb!.hash).not.toBe(first)
    worker.stop(); vi.useRealTimers()
    const capture = vi.fn(async () => { store.remove(target, 'page:local'); return png() })
    const otherCache = cache({ capture }), otherQueue = new BoardPreviewQueue(), other = new BoardThumbWorker(store, otherCache, otherQueue)
    store.upsert(target, { key: 'page:local', kind: 'page', title: 'Page', ref: { url: `${origin}/redline/page.html` }, source: 'user' })
    other.enqueue(target); await otherQueue.idle(); expect(store.get(target).items.some((i) => i.key === 'page:local')).toBe(false); other.stop()
  })
  it('selects the lowest focus canvas frame and first slide and fingerprints nested asset edits', async () => {
    const dir = join(root, 'artifact'); await mkdir(dir); await writeFile(join(dir, 'a.html'), 'a'); await writeFile(join(dir, 'b.html'), 'b')
    const frame = (id: string, focus?: number) => ({ id, title: id, src: `${id}.html`, w: 1000, h: 500, x: 0, y: 0, focus })
    await writeFile(join(dir, 'canvas.json'), JSON.stringify({ frames: [frame('a', 2), frame('b', 1)] }))
    const store = new BoardStore(), capture = vi.fn(async () => png()), c = cache({ capture })
    const item = store.upsert(target, { ...input(dir, 'canvas'), key: `canvas:${dir}`, ref: { path: dir, artifactId: 'a'.repeat(16), manifest: 'canvas.json' } })
    const source = (await c.source(item))!
    expect(source).toMatchObject({ url: `${origin}/redline/artifacts/${'a'.repeat(16)}/b.html`, w: 1000, h: 500 })
    await c.render(item, source); expect(capture).toHaveBeenCalledWith(source.url, 1000, 500)
    expect((await c.source({ ...item, kind: 'slides' }))?.url).toContain('/a.html')
    await writeFile(join(dir, 'a.html'), 'edited nested asset')
    expect((await c.source(item))?.hash).not.toBe(source.hash)
    expect((await c.source({ ...item, kind: 'canvas', ref: { path: dir, artifactId: 'a'.repeat(16), manifest: 'canvas.json' } }))?.hash).not.toBe(source.hash)
  })
  it('uses QuickLook for video/files, removes partial results on failure and skips native tools off macOS', async () => {
    const file = join(root, 'movie.mov'); await writeFile(file, 'video')
    const store = new BoardStore(), c = cache(), item = store.upsert(target, input(file, 'video')), source = (await c.source(item))!
    expect(await c.render(item, source)).toBeDefined(); expect(run.mock.calls.map(([cmd]) => cmd)).toEqual(['qlmanage', 'qlmanage'])
    const fail = cache({ root: join(root, 'failure'), run: vi.fn(async () => { throw new Error('ENOENT') }) })
    expect(await fail.render(item, source)).toBeUndefined()
    const noNative = vi.fn(), linux = cache({ platform: 'linux', run: noNative })
    expect(await linux.render(item, { ...source, hash: 'b'.repeat(64) })).toBeUndefined(); expect(noNative).not.toHaveBeenCalled()
    expect(await c.source({ ...item, kind: 'pr' })).toBeUndefined(); expect(await c.source({ ...item, kind: 'clip' })).toBeUndefined()
  })
  it('only captures daemon artifact pages and reuses content-addressed downloaded assets', async () => {
    const capture = vi.fn(async () => png()), c = cache({ capture })
    expect(await c.page('http://192.168.1.2/private')).toBeUndefined(); expect(capture).not.toHaveBeenCalled()
    const hash = await c.image(png()); expect(hash).toMatch(/^[a-f0-9]{64}$/)
    await c.image(png()); expect(run).toHaveBeenCalledTimes(2)
    expect(await c.read('../escape', 960)).toBeUndefined(); expect(await c.read(hash!, 100)).toBeUndefined()
    expect(await c.read(hash!, 320)).toEqual(png(320, 200))
    expect(defaultBoardThumbsPath(4491)).toMatch(/board-thumbs-4491$/)
  })
  it('evicts old cache entries using recent reads and ignores unrelated files', async () => {
    const c = cache({ maxBytes: 80 })
    const a = await c.image(png()), b = await c.image(Buffer.concat([png(), Buffer.from('different')]))
    const old = new Date(1000), recent = new Date(2000)
    for (const w of [320, 960]) { await utimes(join(root, 'cache', `${a}-${w}.png`), old, old); await utimes(join(root, 'cache', `${b}-${w}.png`), recent, recent) }
    await writeFile(join(root, 'cache', 'keep.txt'), 'untouched')
    await c.read(a!, 320); await c.evict()
    expect(await c.read(a!, 320)).toBeDefined(); expect(await c.read(a!, 960)).toBeUndefined(); expect(await readFile(join(root, 'cache', 'keep.txt'), 'utf8')).toBe('untouched')
    const entries = await readdir(join(root, 'cache'))
    let size = 0; for (const entry of entries.filter((n) => n.endsWith('.png'))) size += (await stat(join(root, 'cache', entry))).size
    expect(size).toBeLessThanOrEqual(80)
  })
  it('serves authenticated immutable thumbnails, validates paths and returns 404 for absent hashes', async () => {
    const c = cache(), hash = await c.image(png()), api = new BoardsApi({ store: new BoardStore(), thumbs: c, agentToken: 'a'.repeat(64), ownerAuthorized: async (r) => r.headers.authorization === 'Bearer owner', paneForId: () => undefined, paneForTarget: () => undefined, agentSession: () => undefined })
    const request = async (path: string, auth?: string, method = 'GET') => {
      let status = 0, headers: Record<string, string> = {}, body: unknown
      await api.handle({ method, headers: { authorization: auth } } as IncomingMessage, { setHeader: () => {}, writeHead: (s: number, h: Record<string, string>) => { status = s; headers = h }, end: (b: unknown) => { body = b } } as unknown as ServerResponse, new URL(`${origin}/api/boards/thumbs/${path}`))
      return { status, headers, body }
    }
    expect((await request(`${hash}/320`)).status).toBe(401)
    const success = await request(`${hash}/320`, 'Bearer owner')
    expect(success.status).toBe(200); expect(success.headers['Cache-Control']).toContain('immutable'); expect(success.body).toEqual(png(320, 200))
    expect((await request(`${hash}/960`, `Bearer ${'a'.repeat(64)}`)).status).toBe(200)
    expect((await request(`${hash}/500`, 'Bearer owner')).status).toBe(400)
    expect((await request('bad/960', 'Bearer owner')).status).toBe(400)
    expect((await request(`${thumbHash(['absent'])}/960`, 'Bearer owner')).status).toBe(404)
    expect((await request(`${hash}/320`, 'Bearer owner', 'POST')).status).toBe(405)
  })
})
