import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BoardLinkPreviews, isPrivatePreviewHost, parseLinkPreview } from './board-link-previews.js'
import { BoardStore } from './boards.js'
import { BoardPreviewQueue, BoardThumbCache, BoardThumbWorker } from './board-thumbs.js'
const target = '00000000-0000-4000-8000-000000000001', other = '00000000-0000-4000-8000-000000000002'
let root: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'board-link-preview-test-')) })
afterEach(async () => { vi.useRealTimers(); await rm(root, { recursive: true, force: true }) })
const response = (body: string | Uint8Array, type = 'text/html', status = 200) => new Response(typeof body === 'string' ? body : new Uint8Array(body), { status, headers: { 'Content-Type': type } })
function setup(options: Partial<ConstructorParameters<typeof BoardLinkPreviews>[0]> = {}) {
  const store = new BoardStore(), thumbs = new BoardThumbCache({ root: join(root, 'thumbs'), origin: 'http://127.0.0.1:4491', platform: 'linux' })
  const image = vi.spyOn(thumbs, 'image').mockResolvedValue('a'.repeat(64)), page = vi.spyOn(thumbs, 'page').mockResolvedValue(undefined)
  const fetch = vi.fn<NonNullable<ConstructorParameters<typeof BoardLinkPreviews>[0]['fetch']>>(async () => response('<title>Article</title>'))
  const resolve = vi.fn(async () => [{ address: '93.184.216.34', family: 4 }])
  const config = { store, thumbs, statePath: join(root, 'previews.json'), fetch, resolve, ...options }
  return { ...config, fetch, resolve, image, page, previews: new BoardLinkPreviews(config) }
}
function add(store: BoardStore, url = 'https://example.com/article', t = target) {
  return store.upsert(t, { key: `url:${url}`, kind: 'link', title: 'User title', ref: { url }, source: 'user' })
}

describe('Link preview metadata', () => {
  it('parses attribute ordering/case/quotes, entities and relative images; chooses the largest favicon', () => {
    expect(parseLinkPreview(`<title>Fallback &amp; title</title><!-- <meta property='og:title' content='Wrong'> --><script>"<meta property='og:title' content='Wrong'>"</script>
      <META content="OG &quot;title&quot;" PROPERTY="og:title"><meta property='og:description' content='A &lt;b&gt;description &amp; more'><meta property=og:site_name content=Example>
      <meta content='../hero.jpg' property='og:image'><link rel='icon' href='/small.png' sizes='16x16'><link href='icons/apple.png' sizes='180x180' rel='apple-touch-icon'>`, 'https://example.com/blog/post')).toEqual({ title: 'OG "title"', description: 'A description & more', siteName: 'Example', image: 'https://example.com/hero.jpg', favicon: 'https://example.com/blog/icons/apple.png' })
    expect(parseLinkPreview('<title>A&#32;title</title><meta property="og:image" content="javascript:evil">', 'https://example.com/a')).toEqual({ title: 'A title', image: undefined, favicon: 'https://example.com/favicon.ico' })
  })
  it.each(['localhost', 'foo.localhost', 'a.local', '127.0.0.7', '10.1.1.1', '172.16.0.1', '172.31.255.255', '192.168.0.1', '[::1]', '::ffff:127.0.0.1', 'fc00::1', 'fe80::1', '169.254.169.254', '0.0.0.0'])('blocks private host %s', (host) => expect(isPrivatePreviewHost(host)).toBe(true))
  it.each(['example.com', '172.15.0.1', '172.32.0.1', '8.8.8.8', '2606:4700::1111'])('permits public host %s', (host) => expect(isPrivatePreviewHost(host)).toBe(false))
})

describe('Board link previews', () => {
  it('fetches every link privately, downloads image/favicon into local hashes, preserves user metadata and persists shared URL cache', async () => {
    const s = setup()
    s.fetch.mockImplementation(async (url) => url.endsWith('hero.jpg') || url.endsWith('favicon.ico') ? response(new Uint8Array([1, 2, 3]), 'image/png') : response('<title>Remote</title><meta property="og:image" content="/hero.jpg"><meta property="og:site_name" content="Site">'))
    const item = add(s.store); await s.previews.refresh(target, item)
    expect(s.store.item(target, item.key)).toMatchObject({ title: 'User title', source: 'user', preview: { title: 'Remote', siteName: 'Site', image: 'a'.repeat(64), favicon: 'a'.repeat(64) } })
    expect(s.fetch).toHaveBeenCalledTimes(3)
    expect(s.fetch.mock.calls[0][1]).toMatchObject({ redirect: 'manual', credentials: 'omit', headers: { Accept: 'text/html', 'User-Agent': 'Commando link preview' } })
    expect(s.fetch.mock.calls[0][2]).toEqual({ address: '93.184.216.34', family: 4 })
    expect(Object.keys(s.fetch.mock.calls[0][1].headers!)).toEqual(['Accept', 'User-Agent'])
    const next = add(s.store, 'https://EXAMPLE.com/article?utm_source=x', other)
    await new BoardLinkPreviews(s).refresh(other, next)
    expect(s.fetch).toHaveBeenCalledTimes(3); expect(s.store.item(other, next.key).preview?.title).toBe('Remote')
    const persisted = await readFile(s.statePath, 'utf8'); expect(persisted).not.toContain('/hero.jpg'); expect(persisted).toContain('Remote')
  })
  it('caches failures for an hour and successes for seven days, then retries', async () => {
    let now = 0; const s = setup({ now: () => now }), item = add(s.store)
    s.fetch.mockRejectedValue(new Error('offline'))
    await s.previews.refresh(target, item); now = 3599_999; await s.previews.refresh(target, item); expect(s.fetch).toHaveBeenCalledTimes(1)
    now = 3600_001; s.fetch.mockResolvedValue(response('<title>Recovered</title>')); await s.previews.refresh(target, item)
    expect(s.fetch).toHaveBeenCalledTimes(3) // page and fallback favicon
    now += 7 * 86400_000 - 1; await s.previews.refresh(target, item); expect(s.fetch).toHaveBeenCalledTimes(3)
    now += 2; s.fetch.mockImplementation(async (url) => response(url.endsWith('favicon.ico') ? '' : '<title>Updated</title>'))
    await s.previews.refresh(target, item); expect(s.fetch).toHaveBeenCalledTimes(5)
  })
  it('never fetches direct private URLs, checks every DNS answer, and pins only checked public addresses', async () => {
    const s = setup()
    await s.previews.refresh(target, add(s.store, 'http://127.0.0.1/private'))
    expect(s.fetch).not.toHaveBeenCalled(); expect(s.resolve).not.toHaveBeenCalled(); expect(s.page).toHaveBeenCalledWith('http://127.0.0.1/private')
    s.resolve.mockResolvedValue([{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.1', family: 4 }])
    await s.previews.refresh(target, add(s.store, 'https://rebind.example/a'))
    expect(s.fetch).not.toHaveBeenCalled(); expect(s.page).toHaveBeenCalledTimes(1)
  })
  it('rejects redirects to private networks, unsafe schemes, and more than three redirects', async () => {
    const s = setup(), item = add(s.store)
    s.fetch.mockResolvedValue(new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/secret' } }))
    await s.previews.refresh(target, item); expect(s.fetch).toHaveBeenCalledTimes(1)
    s.fetch.mockImplementation(async (url) => new Response(null, { status: 302, headers: { location: `${url}x` } }))
    await s.previews.refresh(target, add(s.store, 'https://other.example'))
    expect(s.fetch).toHaveBeenCalledTimes(5)
    s.fetch.mockResolvedValue(new Response(null, { status: 302, headers: { location: 'file:///etc/passwd' } }))
    await s.previews.refresh(target, add(s.store, 'https://unsafe.example')); expect(s.fetch).toHaveBeenCalledTimes(6)
  })
  it('follows three safe redirects and resolves metadata against the final URL', async () => {
    const s = setup(); let n = 0
    s.fetch.mockImplementation(async (url) => {
      if (url.endsWith('favicon.ico')) return response('', 'text/plain', 404)
      if (n++ < 3) return new Response(null, { status: 302, headers: { location: '/landing/' + n } })
      return response('<title>Final</title><meta property="og:image" content="../photo.png">')
    })
    await s.previews.refresh(target, add(s.store))
    expect(s.fetch.mock.calls.map(([url]) => url)).toContain('https://example.com/photo.png')
    expect(s.store.get(target).items[0].preview?.title).toBe('Final')
  })
  it('reads at most 512KB of HTML, cancels streaming bodies, and rejects oversized/non-image assets', async () => {
    const s = setup(), cancel = vi.fn()
    const html = '<title>Bounded</title><meta property="og:image" content="/huge.png">'
    s.fetch.mockImplementation(async (url) => {
      if (url.endsWith('huge.png')) return response(new Uint8Array(5 * 1024 * 1024 + 1), 'image/png')
      if (url.endsWith('favicon.ico')) return response('executable', 'application/octet-stream')
      return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(html + ' '.repeat(512 * 1024))); }, cancel }), { headers: { 'Content-Type': 'text/html' } })
    })
    await s.previews.refresh(target, add(s.store)); expect(cancel).toHaveBeenCalled(); expect(s.image).not.toHaveBeenCalled()
    expect(s.store.get(target).items[0].preview).toEqual({ title: 'Bounded' })
  })
  it('times out DNS/fetch at five seconds and caches the failure', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    // AbortSignal.timeout uses native timers, so explicitly emit the timeout signal in this unit test.
    const controller = new AbortController(), timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal)
    const s = setup(); s.resolve.mockImplementation(() => new Promise(() => {}))
    const pending = s.previews.refresh(target, add(s.store)); await vi.waitFor(() => expect(s.resolve).toHaveBeenCalled())
    controller.abort(); await pending; expect(timeout).toHaveBeenCalledWith(5000); expect(s.fetch).not.toHaveBeenCalled()
    timeout.mockRestore()
  })
  it('uses the same queue as thumbnails and tolerates deletion while fetching', async () => {
    const s = setup(), queue = new BoardPreviewQueue(), worker = new BoardThumbWorker(s.store, s.thumbs, queue, s.previews), item = add(s.store)
    s.fetch.mockImplementation(async () => { s.store.remove(target, item.key); return response('<title>Gone</title>') })
    worker.enqueue(target); await queue.idle(); expect(s.store.get(target).items).toHaveLength(0); worker.stop()
  })
})
