import { access } from 'node:fs/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BoardCaptureBrowser, type CaptureCdp } from './chromium-engine-board-capture.js'
import { resolveCaptureDestination } from './board-capture-policy.js'
import { ChromiumEngine } from './chromium-engine.js'

const publicAnswer = [{ address: '93.184.216.34', family: 4 }]
const resolve = vi.fn(async (_host: string) => publicAnswer)
type Handler = Parameters<CaptureCdp['on']>[1]
const captures: BoardCaptureBrowser[] = []
function setup() {
  const handlers = new Map<string, Set<Handler>>()
  const emit = (event: string, params: Record<string, unknown>, session = 'root-session') => { for (const h of handlers.get(event) ?? []) h(params, session) }
  let currentUrl = 'https://public.example/', automaticLoad = true, generation = 0
  const cdp: CaptureCdp = {
    send: vi.fn(async (method: string, params?: Record<string, unknown>, _session?: string): Promise<Record<string, unknown>> => {
      if (method === 'Target.createBrowserContext') return { browserContextId: `context-${++generation}` }
      if (method === 'Target.createTarget') {
        emit('Target.attachedToTarget', { sessionId: 'root-session', targetInfo: { targetId: 'root', type: 'page' } })
        return { targetId: 'root' }
      }
      if (method === 'Page.navigate') { currentUrl = String(params?.url); if (automaticLoad) emit('Page.loadEventFired', {}) }
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { url: currentUrl } } }
      return method === 'Page.captureScreenshot' ? { data: Buffer.from('png').toString('base64') } : {}
    }),
    on: (event, handler) => { const h = handlers.get(event) ?? new Set(); h.add(handler); handlers.set(event, h) },
    off: (event, handler) => { handlers.get(event)?.delete(handler) }, close: vi.fn(),
  }
  const kills: ReturnType<typeof vi.fn>[] = []
  const launcher = vi.fn(async (_profile: string, _signal?: AbortSignal, _args?: readonly string[]) => {
    let exit!: () => void
    const exited = new Promise<void>((done) => { exit = done })
    const kill = vi.fn(() => exit()); kills.push(kill)
    return { port: 9223, exited, kill }
  })
  const fetch = vi.fn(async () => ({ status: 200, headers: [] as { name: string; value: string }[], body: Buffer.from('page') }))
  const options = { launcher, connect: vi.fn(async () => cdp), endpoint: vi.fn(async () => 'ws://capture'), daemonOrigins: ['https://daemon.example'], daemonPorts: [4310, 4491], resolve, fetch }
  const browser = new BoardCaptureBrowser(options); captures.push(browser)
  return { browser, options, cdp, emit, kills, launcher, fetch, send: vi.mocked(cdp.send), stall: () => { automaticLoad = false }, load: () => emit('Page.loadEventFired', {}), navigate: (value: string) => { currentUrl = value } }
}
afterEach(async () => { await Promise.all(captures.splice(0).map((b) => b.dispose())); await new Promise((r) => setImmediate(r)); vi.useRealTimers(); vi.restoreAllMocks(); resolve.mockReset().mockResolvedValue(publicAnswer) })
const destination = () => resolveCaptureDestination('https://public.example/', resolve)

describe('separate Board capture browser', () => {
  it('launches lazily with a temporary profile and fail-closed network flags; retires at 25 captures and 60s idle', async () => {
    const s = setup(), d = await destination()
    expect(s.launcher).not.toHaveBeenCalled()
    for (let i = 0; i < 25; i++) expect(await s.browser.capture(d.url, 1280, 800, d)).toEqual(Buffer.from('png'))
    expect(s.launcher).toHaveBeenCalledTimes(1); expect(s.kills[0]).toHaveBeenCalledOnce()
    const [profile, , args] = s.launcher.mock.calls[0]
    expect(profile).toContain('commando-board-browser-'); expect(profile).not.toContain('.commando')
    expect(args).toContain('--proxy-bypass-list=<-loopback>'); expect(args).toContain('--proxy-server=http://commando-capture-deny.invalid:9')
    await expect(access(profile)).rejects.toThrow()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    await s.browser.capture(d.url, 1280, 800, d)
    expect(s.launcher).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(59_999); expect(s.kills[1]).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1); expect(s.kills[1]).toHaveBeenCalledOnce()
  })
  it('serializes jobs, uses disposable contexts and kills/relaunches on a navigation timeout', async () => {
    const s = setup(), d = await destination(); s.stall()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const first = s.browser.capture(d.url, 1280, 800, d)
    const rejected = expect(first).rejects.toThrow('timed out after 10s')
    await vi.waitFor(() => expect(s.send).toHaveBeenCalledWith('Page.navigate', { url: d.url }, 'root-session'))
    const second = s.browser.capture(d.url, 1280, 800, d)
    expect(s.launcher).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(10_000); await rejected
    await vi.waitFor(() => expect(s.launcher).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(s.send.mock.calls.filter(([m]) => m === 'Page.navigate')).toHaveLength(2))
    s.load(); await second
    expect(s.kills[0]).toHaveBeenCalledOnce()
    expect(s.send).toHaveBeenCalledWith('Target.disposeBrowserContext', { browserContextId: 'context-2' })
    expect(s.send).toHaveBeenCalledWith('Browser.setDownloadBehavior', { behavior: 'deny', browserContextId: 'context-2' })
  })
  it('enforces public policy on redirects/subresources, pins DNS answers, and denies SW script requests', async () => {
    const s = setup(), d = await destination(); s.stall()
    const job = s.browser.capture(d.url, 1280, 800, d)
    await vi.waitFor(() => expect(s.send).toHaveBeenCalledWith('Page.navigate', { url: d.url }, 'root-session'))
    resolve.mockImplementation(async (host) => host === 'private-alias.example' ? [{ address: '10.0.0.1', family: 4 }] : publicAnswer)
    const request = (url: string, id: string, headers = {}) => s.emit('Fetch.requestPaused', { requestId: id, request: { url, headers } })
    const denied = ['http://127.0.0.1/', 'http://169.254.169.254/', 'http://[::1]/', 'https://private-alias.example/', 'https://any.example:4491/', 'https://daemon.example/', 'file:///tmp/a', 'data:text/html,x', 'https://u:p@public.example/', 'https://public.example/api/pairing/claim']
    denied.forEach((url, index) => request(url, String(index)))
    request('https://public.example/sw.js', 'sw', { 'Service-Worker': 'script' })
    request('https://cdn.example/a', 'a'); request('https://cdn.example/b', 'b')
    await vi.waitFor(() => expect(s.send.mock.calls.filter(([m]) => m === 'Fetch.failRequest')).toHaveLength(denied.length + 1))
    await vi.waitFor(() => expect(s.fetch).toHaveBeenCalledTimes(2))
    expect(resolve.mock.calls.filter(([host]) => host === 'cdn.example')).toHaveLength(1)
    expect(s.fetch.mock.calls.every((call) => (call as unknown[])[1] && ((call as unknown[])[1] as { address: string }).address === publicAnswer[0].address)).toBe(true)
    expect(s.send).toHaveBeenCalledWith('Fetch.fulfillRequest', expect.objectContaining({ responseHeaders: expect.arrayContaining([expect.objectContaining({ value: expect.stringContaining("worker-src 'none'") })]) }), 'root-session')
    expect(s.send.mock.calls.some(([m]) => m === 'Fetch.continueRequest')).toBe(false)
    s.emit('Page.javascriptDialogOpening', {}); s.load(); await job
    expect(s.send).toHaveBeenCalledWith('Page.handleJavaScriptDialog', { accept: false }, 'root-session')
  })
  it('applies interception recursively before resuming child workers/OOPIFs and closes service-worker targets', async () => {
    const s = setup(), d = await destination(); s.stall()
    const job = s.browser.capture(d.url, 1280, 800, d)
    await vi.waitFor(() => expect(s.send).toHaveBeenCalledWith('Page.navigate', { url: d.url }, 'root-session'))
    for (const type of ['worker', 'iframe', 'service_worker']) s.emit('Target.attachedToTarget', { sessionId: type, targetInfo: { targetId: type, type } })
    await vi.waitFor(() => expect(s.send).toHaveBeenCalledWith('Runtime.runIfWaitingForDebugger', {}, 'iframe'))
    for (const session of ['worker', 'iframe']) {
      const calls = s.send.mock.calls.filter(([, , id]) => id === session).map(([m]) => m)
      expect(calls.indexOf('Target.setAutoAttach')).toBeLessThan(calls.indexOf('Fetch.enable'))
      expect(calls.indexOf('Fetch.enable')).toBeLessThan(calls.indexOf('Runtime.runIfWaitingForDebugger'))
      s.emit('Fetch.requestPaused', { requestId: session, request: { url: 'http://10.0.0.1/private' } }, session)
    }
    await vi.waitFor(() => expect(s.send).toHaveBeenCalledWith('Fetch.failRequest', { requestId: 'worker', errorReason: 'BlockedByClient' }, 'worker'))
    expect(s.send).toHaveBeenCalledWith('Target.closeTarget', { targetId: 'service_worker' })
    expect(s.send).not.toHaveBeenCalledWith('Runtime.runIfWaitingForDebugger', {}, 'service_worker')
    s.load(); await job
  })
  it('allows only the private item origin and public resources for private captures, including redirect checks', async () => {
    const s = setup(), d = await resolveCaptureDestination('http://127.0.0.1:5273/app'); s.stall()
    const job = s.browser.capture(d.url, 1280, 800, d)
    await vi.waitFor(() => expect(s.send).toHaveBeenCalledWith('Page.navigate', { url: d.url }, 'root-session'))
    for (const [id, url] of [['own', 'http://127.0.0.1:5273/style.css'], ['public', 'https://cdn.example/style.css'], ['other', 'http://127.0.0.1:5274/'], ['daemon', 'http://127.0.0.1:4310/']]) s.emit('Fetch.requestPaused', { requestId: id, request: { url } })
    await vi.waitFor(() => expect(s.send.mock.calls.filter(([m]) => m === 'Fetch.fulfillRequest')).toHaveLength(2))
    await vi.waitFor(() => expect(s.send.mock.calls.filter(([m]) => m === 'Fetch.failRequest')).toHaveLength(2))
    s.fetch.mockResolvedValueOnce({ status: 302, headers: [{ name: 'Location', value: 'http://10.0.0.1/' }], body: Buffer.alloc(0) })
    s.emit('Fetch.requestPaused', { requestId: 'redirect', request: { url: 'https://cdn.example/redirect' } })
    await vi.waitFor(() => expect(s.send).toHaveBeenCalledWith('Fetch.failRequest', { requestId: 'redirect', errorReason: 'BlockedByClient' }, 'root-session'))
    s.load(); await job
  })
  it('fails closed if a child target cannot enable interception and never resumes it', async () => {
    const s = setup(), d = await destination(); s.stall()
    const job = s.browser.capture(d.url, 1280, 800, d)
    const rejected = expect(job).rejects.toThrow('Unsupported Fetch')
    await vi.waitFor(() => expect(s.send).toHaveBeenCalledWith('Page.navigate', { url: d.url }, 'root-session'))
    const original = s.send.getMockImplementation()!
    s.send.mockImplementation(async (...args) => {
      if (args[0] === 'Fetch.enable' && args[2] === 'unsupported') throw new Error('Unsupported Fetch')
      return original(...args)
    })
    s.emit('Target.attachedToTarget', { sessionId: 'unsupported', targetInfo: { type: 'worker', targetId: 'bad-worker' } })
    await rejected
    expect(s.send).not.toHaveBeenCalledWith('Runtime.runIfWaitingForDebugger', {}, 'unsupported')
    expect(s.kills[0]).toHaveBeenCalledOnce()
  })
  it('rejects data/file navigations that do not produce Fetch events', async () => {
    const s = setup(), d = await destination(); s.stall()
    const job = s.browser.capture(d.url, 1280, 800, d)
    const rejected = expect(job).rejects.toThrow('Blocked')
    await vi.waitFor(() => expect(s.send).toHaveBeenCalledWith('Page.navigate', { url: d.url }, 'root-session'))
    s.navigate('data:text/html,secret'); s.load(); await rejected
    expect(s.send.mock.calls.some(([m]) => m === 'Page.captureScreenshot')).toBe(false)
  })
  it('leaves the live engine browser untouched when the capture process fails', async () => {
    const s = setup(), d = await destination(), liveKill = vi.fn(), liveClose = vi.fn(), down = vi.fn()
    const engine = new ChromiumEngine({ classify: () => ({ kind: 'open' }), onExternalNavigation: vi.fn(), onTargetDown: down, launcher: s.launcher, boardCapture: s.options })
    const internals = engine as unknown as { browser: unknown; ensureBrowser: () => Promise<unknown> }
    internals.browser = { launch: { kill: liveKill }, cdp: { close: liveClose } }
    const ensureLive = vi.spyOn(internals, 'ensureBrowser')
    s.send.mockRejectedValueOnce(new Error('Capture browser died'))
    await expect(engine.screenshotPage(d.url, 1280, 800, d)).rejects.toThrow('Capture browser died')
    expect(ensureLive).not.toHaveBeenCalled(); expect(liveKill).not.toHaveBeenCalled(); expect(liveClose).not.toHaveBeenCalled(); expect(down).not.toHaveBeenCalled()
    engine.dispose()
  })
})
