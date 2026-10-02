import { readFile, writeFile, access } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { runInNewContext } from 'node:vm'
import { PassThrough, Readable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { SimLeaseRegistry, SIM_LEASE_IDLE_MS } from './sim-leases.js'
import { SimWallApi, type SimWallRunner } from './sim-wall.js'

const A = 'AAAAAAAA-1111-1111-1111-111111111111'
const B = 'BBBBBBBB-2222-2222-2222-222222222222'
const C = 'CCCCCCCC-3333-3333-3333-333333333333'
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}
function setup(override?: SimWallRunner) {
  let now = 0
  const registry = new SimLeaseRegistry({ now: () => now })
  const devices = [A, B, C].map((udid) => ({ udid, name: 'Renamed sim', state: 'Booted', deviceTypeIdentifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro' }))
  const runner = vi.fn<SimWallRunner>(override ?? (async (command, args) => {
    if (command === 'xcrun' && args[1] === 'list') return JSON.stringify({ devices: {
      'com.apple.CoreSimulator.SimRuntime.iOS-26-5': [...devices, { udid: 'DDDDDDDD-4444-4444-4444-444444444444', state: 'Shutdown' }],
      'com.apple.CoreSimulator.SimRuntime.tvOS-26-5': [{ ...devices[0] }],
    } })
    if (command === 'simslim' && args[0] === 'list') return `${A}  Renamed sim  iOS 26.5  booted · 170/170 slim\n${B}  iPhone 17  iOS 26.5  booted · 0/0 slim\n${C}  iPhone 17  iOS 26.5  booted · 20/170 slim`
    if (args.includes('screenshot')) await writeFile(args.at(-1)!, 'jpeg bytes')
    return ''
  }))
  const api = new SimWallApi({ registry, paneExists: (pane) => pane !== '%9', runner, now: () => now })
  return { api, registry, runner, devices, advance: (ms: number) => { now += ms } }
}
async function call(api: SimWallApi, path = '', method = 'GET') {
  const request = Readable.from([]) as IncomingMessage
  request.method = method
  const response = new PassThrough() as unknown as ServerResponse
  const chunks: Buffer[] = []
  response.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
  response.writeHead = vi.fn().mockReturnValue(response)
  const handled = await api.handle(request, response, new URL(path.startsWith('/sims/') ? `http://localhost${path}` : `http://localhost/api/sims${path}`))
  return { handled, status: vi.mocked(response.writeHead).mock.calls[0]?.[0],
    headers: vi.mocked(response.writeHead).mock.calls[0]?.[1], data: Buffer.concat(chunks),
    json: () => JSON.parse(Buffer.concat(chunks).toString()) }
}

describe('SimWallApi', () => {
  it('serves a self-contained escaped tile at both paths without invoking device tools', async () => {
    const { api, registry, runner } = setup()
    registry.upsert('%1', { sessionId: '$1', sessionName: '<script>&"Session' }, { udid: A, originalName: 'iPhone', task: 'Review', via: 'simslim' })
    for (const path of [`/sims/${A}/view`, `/${A}/view?token=secret`]) {
      const result = await call(api, path)
      expect(result.status).toBe(200)
      expect(result.headers).toMatchObject({ 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' })
      const page = result.data.toString()
      expect(page).toContain('&lt;script&gt;&amp;&quot;Session · Review')
      expect(page).not.toContain('<script>&"Session')
      expect(page).not.toContain('secret')
      expect(page).not.toMatch(/<script[^>]+src=|<link|<img[^>]+src=/)
    }
    expect((await call(api, '/sims/bad/view')).status).toBe(400)
    expect((await call(api, `/sims/${A}/view`, 'POST')).status).toBe(405)
    expect(runner).not.toHaveBeenCalled()
  })

  it('refreshes visible tiles every two seconds, preloads frames, retains failures and carries browser auth', async () => {
    const { api } = setup()
    const page = (await call(api, `/sims/${A}/view`)).data.toString()
    const script = /<script>([\s\S]*?)<\/script>/.exec(page)![1]
    for (const token of ['', 'token/value &']) {
      const frame = { src: 'previous' }
      const images: Array<{ src: string; onload: () => void; onerror: () => void }> = []
      const listeners = new Map<string, () => void>()
      const document = { visibilityState: 'visible', getElementById: () => frame, addEventListener: (name: string, fn: () => void) => listeners.set(name, fn) }
      let tick!: () => void
      const clearInterval = vi.fn()
      runInNewContext(script, {
        document, URL, location: { href: `http://localhost/sims/${A}/view${token ? '?token=' + encodeURIComponent(token) : ''}` },
        window: { addEventListener: (name: string, fn: () => void) => listeners.set(name, fn) },
        Image: function () { const image = { src: '', onload: () => undefined, onerror: () => undefined }; images.push(image); return image },
        setInterval: (fn: () => void, ms: number) => { expect(ms).toBe(2000); tick = fn; return 42 }, clearInterval,
      })
      expect(images).toHaveLength(1)
      const url = new URL(images[0].src)
      expect(url.pathname).toBe(`/api/sims/${A}/snapshot.jpg`)
      expect(url.searchParams.get('token')).toBe(token || null)
      expect(frame.src).toBe('previous')
      tick()
      expect(images).toHaveLength(1)
      images[0].onload()
      expect(frame.src).toBe(images[0].src)
      tick()
      expect(images).toHaveLength(2)
      images[1].onerror()
      expect(frame.src).toBe(images[0].src)
      document.visibilityState = 'hidden'
      tick()
      expect(images).toHaveLength(2)
      document.visibilityState = 'visible'
      listeners.get('visibilitychange')!()
      expect(images).toHaveLength(3)
      document.visibilityState = 'hidden'
      images[2].onload()
      expect(frame.src).toBe(images[0].src)
      listeners.get('pagehide')!()
      expect(clearInterval).toHaveBeenCalledWith(42)
    }
  })

  it('joins booted iOS devices with leases, runtime, model, exact slim counts and idle flags', async () => {
    const { api, registry, advance } = setup()
    const repo = { root: '/repo', name: 'repo', branch: 'feature', isWorktree: true }
    registry.upsert('%1', { sessionId: '$1', sessionName: 'Work', repo }, { udid: A, task: 'Review', originalName: 'iPhone 17 Pro', via: 'simslim' })
    registry.upsert('%9', { sessionId: '$1', sessionName: 'Gone' }, { udid: B, originalName: 'iPhone', via: 'simslim' })
    advance(SIM_LEASE_IDLE_MS)
    const result = await call(api)
    expect(result.status).toBe(200)
    expect(result.json().sims).toEqual([
      { udid: A, name: 'Renamed sim', runtime: 'iOS 26.5', deviceModel: 'iPhone 17 Pro', slim: 'slim',
        lease: { sessionName: 'Work', task: 'Review', label: 'Work · Review', repo, paneId: '%1', idle: true } },
      { udid: B, name: 'Renamed sim', runtime: 'iOS 26.5', deviceModel: 'iPhone 17 Pro', slim: 'unslimmed', lease: null },
      { udid: C, name: 'Renamed sim', runtime: 'iOS 26.5', deviceModel: 'iPhone 17 Pro', slim: 'unslimmed', lease: null },
    ])
  })

  it('single-flights and caches listings for two seconds, then sees changed boot states', async () => {
    const { api, runner, advance, devices } = setup()
    await Promise.all([api.list(), api.list(), call(api)])
    expect(runner).toHaveBeenCalledTimes(2)
    advance(1999)
    await api.list()
    expect(runner).toHaveBeenCalledTimes(2)
    devices[0].state = 'Shutdown'
    advance(1)
    expect(await api.list()).toHaveLength(2)
    expect(runner).toHaveBeenCalledTimes(4)
  })

  it('reports unknown slim state when simslim is missing and retries failed listings', async () => {
    const baseline = setup()
    const { api } = setup(async (command, args) => {
      if (command === 'simslim') throw Object.assign(new Error('missing'), { code: 'ENOENT' })
      return baseline.runner(command, args)
    })
    expect((await api.list()).every((device) => device.slim === 'unknown')).toBe(true)
    const failed = setup(async () => { throw new Error('tool failed') })
    expect((await call(failed.api)).status).toBe(500)
    await call(failed.api)
    expect(failed.runner).toHaveBeenCalledTimes(4)
  })

  it('validates UUIDs, methods and unknown/non-booted devices without captures or actions', async () => {
    const { api, runner, devices } = setup()
    expect((await call(api, '/bad/snapshot.jpg')).status).toBe(400)
    expect((await call(api, `/${A}/slim`)).status).toBe(405)
    expect((await call(api, '', 'POST')).status).toBe(405)
    devices[0].state = 'Shutdown'
    for (const action of ['snapshot.jpg', 'slim', 'open']) {
      expect((await call(api, `/${A}/${action}`, action === 'snapshot.jpg' ? 'GET' : 'POST')).status).toBe(404)
    }
    expect(runner.mock.calls.every(([, args]) => args.includes('list'))).toBe(true)
  })

  it('single-flights JPEG captures, caches for two seconds, uses no-store and cleans temporary files', async () => {
    const { api, runner, advance } = setup()
    const responses = await Promise.all([call(api, `/${A}/snapshot.jpg`), call(api, `/${A.toLowerCase()}/snapshot.jpg`)])
    expect(responses.map((result) => result.data.toString())).toEqual(['jpeg bytes', 'jpeg bytes'])
    expect(responses[0].headers).toMatchObject({ 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store' })
    const captures = () => runner.mock.calls.filter(([, args]) => args.includes('screenshot'))
    expect(captures()).toHaveLength(1)
    const path = captures()[0][1].at(-1)!
    await expect(access(path)).rejects.toThrow()
    advance(1999)
    await call(api, `/${A}/snapshot.jpg`)
    expect(captures()).toHaveLength(1)
    advance(1)
    await call(api, `/${A}/snapshot.jpg`)
    expect(captures()).toHaveLength(2)
  })

  it('caps captures at two and releases slots even after failures', async () => {
    const baseline = setup()
    const gates = [deferred(), deferred(), deferred()]
    let active = 0
    let peak = 0
    let started = 0
    const { api } = setup(async (command, args) => {
      if (!args.includes('screenshot')) return baseline.runner(command, args)
      const index = started++
      active++
      peak = Math.max(peak, active)
      await gates[index].promise
      active--
      if (index === 0) throw new Error('capture failed')
      return baseline.runner(command, args)
    })
    const requests = [A, B, C].map((udid) => call(api, `/${udid}/snapshot.jpg`))
    await vi.waitFor(() => expect(started).toBe(2))
    gates[0].resolve()
    await vi.waitFor(() => expect(started).toBe(3))
    gates[1].resolve()
    gates[2].resolve()
    expect((await Promise.all(requests)).map((result) => result.status).sort()).toEqual([200, 200, 500])
    expect(peak).toBe(2)
  })

  it('returns 409 during slimming, invalidates caches afterward, and opens with argument arrays', async () => {
    const baseline = setup()
    const gate = deferred()
    const { api, runner } = setup(async (command, args) => {
      if (command === 'simslim' && args[0] === 'on') { await gate.promise; return '' }
      return baseline.runner(command, args)
    })
    await call(api, `/${A}/snapshot.jpg`)
    const first = call(api, `/${A}/slim`, 'POST')
    await vi.waitFor(() => expect(runner).toHaveBeenCalledWith('simslim', ['on', A]))
    expect((await call(api, `/${A}/slim`, 'POST')).status).toBe(409)
    gate.resolve()
    expect((await first).status).toBe(200)
    expect((await call(api, `/${A}/snapshot.jpg`)).status).toBe(200)
    expect(runner.mock.calls.filter(([, args]) => args.includes('screenshot'))).toHaveLength(2)
    expect((await call(api, `/${A}/open`, 'POST')).status).toBe(200)
    expect(runner).toHaveBeenCalledWith('open', ['-a', 'Simulator', '--args', '-CurrentDeviceUDID', A])
  })

  it('releases slim and capture flights after errors so explicit retries can succeed', async () => {
    const baseline = setup()
    let fail = true
    const { api } = setup(async (command, args) => {
      if (fail && (args.includes('screenshot') || args[0] === 'on')) throw new Error('failed')
      return baseline.runner(command, args)
    })
    expect((await call(api, `/${A}/snapshot.jpg`)).status).toBe(500)
    expect((await call(api, `/${A}/slim`, 'POST')).status).toBe(500)
    fail = false
    expect((await call(api, `/${A}/snapshot.jpg`)).status).toBe(200)
    expect((await call(api, `/${A}/slim`, 'POST')).status).toBe(200)
  })

  it('treats reported devices without positive equal slim counts as unslimmed', async () => {
    const baseline = setup()
    const { api } = setup(async (command, args) => {
      if (command === 'simslim') return `${A}  phone  iOS 26.5  booted\n${B}  phone  iOS 26.5  booted · 0/170 slim`
      return baseline.runner(command, args)
    })
    expect((await api.list()).map((device) => device.slim)).toEqual(['unslimmed', 'unslimmed', 'unknown'])
  })

  it('returns 404 for a device that shuts down even if an image was cached', async () => {
    const { api, devices, advance, runner } = setup()
    await call(api, `/${A}/snapshot.jpg`)
    devices[0].state = 'Shutdown'
    advance(2000)
    expect((await call(api, `/${A}/snapshot.jpg`)).status).toBe(404)
    expect(runner.mock.calls.filter(([, args]) => args.includes('screenshot'))).toHaveLength(1)
  })

  it('wires the wall behind the common browser auth gate, after the agent lease API', async () => {
    const source = await readFile(new URL('./index.ts', import.meta.url), 'utf8')
    const browserGate = source.indexOf("if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/sims/'))")
    const wall = source.indexOf('if (await simWallApi.handle')
    expect(browserGate).toBeGreaterThan(0)
    expect(wall).toBeGreaterThan(browserGate)
    expect(source.slice(browserGate, wall)).toContain('await requestIsAuthorized(request, url)')
    expect(source.indexOf('await simLeaseApi.handle')).toBeLessThan(browserGate)
  })
})
