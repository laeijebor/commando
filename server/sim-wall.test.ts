import { readFile, writeFile, access, mkdtemp, readdir, rm, stat, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { PassThrough, Readable } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SimLeaseRegistry, SIM_LEASE_IDLE_MS } from './sim-leases.js'
import { SimWallApi, type SimWallRunner } from './sim-wall.js'

const A = 'AAAAAAAA-1111-1111-1111-111111111111'
const B = 'BBBBBBBB-2222-2222-2222-222222222222'
const C = 'CCCCCCCC-3333-3333-3333-333333333333'
const D = 'DDDDDDDD-4444-4444-4444-444444444444'
const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))) })
async function cacheDirectory() {
  const directory = await mkdtemp(join(tmpdir(), 'commando-sim-cache-test-'))
  directories.push(directory)
  return directory
}
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}
function setup(override?: SimWallRunner, cacheDirectory?: string) {
  let now = 0
  const registry = new SimLeaseRegistry({ now: () => now })
  const devices = [A, B, C].map((udid) => ({ udid, name: 'Renamed sim', state: 'Booted', deviceTypeIdentifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro' }))
  const runner = vi.fn<SimWallRunner>(override ?? (async (command, args) => {
    if (command === 'xcrun' && args[1] === 'list') return JSON.stringify({ devices: {
      'com.apple.CoreSimulator.SimRuntime.iOS-26-5': [...devices, { udid: 'DDDDDDDD-4444-4444-4444-444444444444', state: 'Shutdown' }],
      'com.apple.CoreSimulator.SimRuntime.tvOS-26-5': [{ ...devices[0] }],
    } })
    if (command === 'osascript') return 'not-running'
    if (command === 'simslim' && args[0] === 'list') return `${A}  Renamed sim  iOS 26.5  booted · 170/170 slim\n${B}  iPhone 17  iOS 26.5  booted · 0/0 slim\n${C}  iPhone 17  iOS 26.5  booted · 20/170 slim`
    if (args.includes('screenshot')) await writeFile(args.at(-1)!, 'jpeg bytes')
    return ''
  }))
  const api = new SimWallApi({ registry, paneExists: (pane) => pane !== '%9', runner, now: () => now, cacheDirectory })
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
  it('joins closed and released leases onto booted sims, removes reclaimed history and prunes shutdown history', async () => {
    const { api, registry, runner, devices, advance } = setup()
    const input = { originalName: 'iPhone 17', task: 'review', via: 'adopted', adopted: true }
    const target = { sessionId: '$1', sessionName: 'Former session', repo: { root: '/repo', name: 'repo', branch: 'main', isWorktree: false } }
    registry.upsert('%9', target, { ...input, udid: A })
    registry.upsert('%1', target, { ...input, udid: B })
    registry.delete('%1')
    registry.list((pane) => pane !== '%9')
    registry.upsert('%9', target, { ...input, udid: D })
    const sims = await api.list()
    expect(sims.find((sim) => sim.udid === A)).toMatchObject({ lease: null, endedLease: {
      sessionName: 'Former session', task: 'review', label: 'Former session · review', repo: target.repo, endedAt: 0, reason: 'pane-closed',
    } })
    expect(sims.find((sim) => sim.udid === B)).toMatchObject({ lease: null, endedLease: { reason: 'released' } })
    expect(sims.find((sim) => sim.udid === C)).toMatchObject({ lease: null, endedLease: null })
    expect(registry.listEnded().map((entry) => entry.udid).sort()).toEqual([A, B])
    registry.upsert('%2', target, { ...input, udid: A })
    devices.find((device) => device.udid === B)!.state = 'Shutdown'
    advance(2500)
    await vi.waitFor(async () => expect((await api.list()).find((sim) => sim.udid === A)).toMatchObject({ lease: { paneId: '%2' }, endedLease: null }))
    expect(registry.listEnded()).toEqual([])
    expect(runner.mock.calls.every(([, args]) => args.includes('list'))).toBe(true)
  })

  it('returns stale listings immediately, single-flights the background refresh, and keeps stale data on failure', async () => {
    const baseline = setup()
    const gate = deferred()
    let refresh = false
    let fail = false
    const { api, runner, advance } = setup(async (command, args) => {
      if (refresh) { await gate.promise; if (fail) throw new Error('offline') }
      return baseline.runner(command, args)
    })
    expect((await call(api)).json()).toMatchObject({ stale: false, listedAt: 0 })
    refresh = true
    advance(2500)
    baseline.devices[0].state = 'Shutdown'
    for (let i = 0; i < 3; i++) {
      expect((await call(api)).json()).toMatchObject({ stale: true, listedAt: 0, sims: expect.any(Array) })
    }
    expect(runner).toHaveBeenCalledTimes(4)
    gate.resolve()
    await vi.waitFor(async () => expect((await call(api)).json()).toMatchObject({ listedAt: 2500, sims: expect.arrayContaining([expect.objectContaining({ udid: B })]) }))
    expect(await api.list()).toHaveLength(2)
    fail = true
    advance(2500)
    expect((await call(api)).json().listedAt).toBe(2500)
    await vi.waitFor(() => expect(runner).toHaveBeenCalledTimes(6))
    await new Promise((resolve) => setImmediate(resolve))
    expect((await call(api)).json().listedAt).toBe(2500)
  })

  it('serves the previous capture and timestamp immediately during refresh, including refresh failures', async () => {
    const baseline = setup()
    const gate = deferred()
    let refreshing = false
    let fail = false
    const { api, runner, advance } = setup(async (command, args) => {
      if (args.includes('screenshot') && refreshing) {
        await gate.promise
        if (fail) throw new Error('capture failed')
        await writeFile(args.at(-1)!, 'new jpeg')
        return ''
      }
      return baseline.runner(command, args)
    })
    await call(api, `/${A}/snapshot.jpg`)
    refreshing = true
    advance(2500)
    for (let i = 0; i < 3; i++) {
      const result = await call(api, `/${A}/snapshot.jpg`)
      expect(result.data.toString()).toBe('jpeg bytes')
      expect(result.headers).toMatchObject({ 'X-Commando-Snapshot-At': '0', 'Access-Control-Expose-Headers': 'X-Commando-Snapshot-At' })
    }
    await vi.waitFor(() => expect(runner.mock.calls.filter(([, args]) => args.includes('screenshot'))).toHaveLength(2))
    gate.resolve()
    await vi.waitFor(async () => expect((await call(api, `/${A}/snapshot.jpg`)).data.toString()).toBe('new jpeg'))
    expect((await call(api, `/${A}/snapshot.jpg`)).headers).toMatchObject({ 'X-Commando-Snapshot-At': '2500' })
    fail = true
    advance(2500)
    expect((await call(api, `/${A}/snapshot.jpg`)).data.toString()).toBe('new jpeg')
    await vi.waitFor(() => expect(runner.mock.calls.filter(([, args]) => args.includes('screenshot'))).toHaveLength(3))
    await new Promise((resolve) => setImmediate(resolve))
    expect((await call(api, `/${A}/snapshot.jpg`)).headers).toMatchObject({ 'X-Commando-Snapshot-At': '2500' })
  })

  it('persists listings and captures atomically, hydrates lazily after restart, and prunes shut-down devices', async () => {
    const directory = await cacheDirectory()
    const first = setup(undefined, directory)
    first.advance(10_000)
    await call(first.api, `/${A}/snapshot.jpg`)
    expect((await stat(directory)).mode & 0o777).toBe(0o700)
    expect(await readdir(directory)).toEqual(expect.arrayContaining(['listing.json', `${A}.jpg`]))
    expect((await readdir(directory)).some((file) => file.endsWith('.tmp'))).toBe(false)
    expect(JSON.parse(await readFile(join(directory, 'listing.json'), 'utf8')).listedAt).toBe(10_000)
    const gate = deferred()
    const restarted = setup(async (...args) => { await gate.promise; return first.runner(...args) }, directory)
    restarted.advance(20_000)
    expect(restarted.runner).not.toHaveBeenCalled()
    expect((await call(restarted.api)).json()).toMatchObject({ stale: true, listedAt: 10_000 })
    const image = await call(restarted.api, `/${A}/snapshot.jpg`)
    expect(image.data.toString()).toBe('jpeg bytes')
    expect(image.headers).toMatchObject({ 'X-Commando-Snapshot-At': '10000' })
    first.devices[0].state = 'Shutdown'
    gate.resolve()
    await vi.waitFor(async () => expect(await restarted.api.list()).toHaveLength(2))
    await vi.waitFor(async () => expect(await readdir(directory)).not.toContain(`${A}.jpg`))
    await vi.waitFor(async () => expect((await call(restarted.api, `/${A}/snapshot.jpg`)).status).toBe(404))
  })

  it('retains only the newest 50 snapshot files when refreshing the listing', async () => {
    const directory = await cacheDirectory()
    const { api, devices } = setup(undefined, directory)
    devices.length = 0
    for (let index = 0; index < 52; index++) {
      const udid = `${index.toString(16).padStart(8, '0')}-1111-1111-1111-111111111111`.toUpperCase()
      devices.push({ udid, name: 'Phone', state: 'Booted', deviceTypeIdentifier: 'iPhone' })
      const path = join(directory, `${udid}.jpg`)
      await writeFile(path, 'jpeg')
      await utimes(path, index + 1, index + 1)
    }
    await api.list()
    const files = await readdir(directory)
    expect(files.filter((file) => file.endsWith('.jpg'))).toHaveLength(50)
    expect(files).not.toContain(`${devices[0].udid}.jpg`)
    expect(files).not.toContain(`${devices[1].udid}.jpg`)
  })

  it('removes the token-in-URL snapshot page', async () => {
    const { api, runner } = setup()
    expect((await call(api, `/${A}/view?token=secret`)).status).toBe(404)
    expect((await call(api, `/sims/${A}/view`)).handled).toBe(false)
    expect(runner).not.toHaveBeenCalled()
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
        lease: { sessionName: 'Work', task: 'Review', label: 'Work · Review', repo, paneId: '%1', idle: true }, endedLease: null },
      { udid: B, name: 'Renamed sim', runtime: 'iOS 26.5', deviceModel: 'iPhone 17 Pro', slim: 'unslimmed', lease: null, endedLease: { sessionName: 'Gone', task: '', label: 'Gone', endedAt: SIM_LEASE_IDLE_MS, reason: 'pane-closed' } },
      { udid: C, name: 'Renamed sim', runtime: 'iOS 26.5', deviceModel: 'iPhone 17 Pro', slim: 'unslimmed', lease: null, endedLease: null },
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
    expect(await api.list()).toHaveLength(3)
    await vi.waitFor(async () => expect(await api.list()).toHaveLength(2))
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
    await vi.waitFor(() => expect(captures()).toHaveLength(2))
    await vi.waitFor(async () => expect((await call(api, `/${A}/snapshot.jpg`)).headers).toMatchObject({ 'X-Commando-Snapshot-At': '2000' }))
  })

  it('caps captures at three and releases slots even after failures', async () => {
    const baseline = setup()
    baseline.devices.push({ ...baseline.devices[0], udid: D })
    const gates = [deferred(), deferred(), deferred(), deferred()]
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
    const requests = [A, B, C, D].map((udid) => call(api, `/${udid}/snapshot.jpg`))
    await vi.waitFor(() => expect(started).toBe(3))
    gates[0].resolve()
    await vi.waitFor(() => expect(started).toBe(4))
    gates[1].resolve()
    gates[2].resolve()
    gates[3].resolve()
    expect((await Promise.all(requests)).map((result) => result.status).sort()).toEqual([200, 200, 200, 500])
    expect(peak).toBe(3)
  })

  it('activates an already running Simulator and raises the current device name via script argv', async () => {
    const baseline = setup()
    // Populate the wall cache, then rename the device to prove opening resolves the name afresh.
    const { api, runner } = setup(async (command, args) => command === 'osascript' ? 'raised\n' : baseline.runner(command, args))
    await api.list()
    baseline.devices[0].name = 'Session "review"; do shell script "bad"'
    const result = await call(api, `/${A}/open`, 'POST')
    expect(result.json()).toEqual({ ok: true, raised: true })
    expect(runner.mock.calls.filter(([command, args]) => command === 'xcrun' && args[1] === 'list')).toHaveLength(2)
    const scripts = runner.mock.calls.filter(([command]) => command === 'osascript')
    expect(scripts).toHaveLength(1)
    const args = scripts[0][1]
    expect(args[0]).toBe('-e')
    expect(args[1]).toContain('on run argv')
    expect(args[1]).toContain('tell application "Simulator" to activate')
    expect(args[1]).toContain('(name of simulatorWindow) starts with deviceName')
    expect(args[1]).toContain('perform action "AXRaise" of simulatorWindow')
    expect(args[1]).not.toContain(baseline.devices[0].name)
    expect(args.slice(2)).toEqual(['--', baseline.devices[0].name])
    expect(runner.mock.calls.some(([command]) => command === 'open')).toBe(false)
  })

  it('falls back to launch arguments only when Simulator is not running', async () => {
    const { api, runner } = setup()
    const result = await call(api, `/${A}/open`, 'POST')
    expect(result.json()).toEqual({ ok: true })
    expect(runner).toHaveBeenLastCalledWith('open', ['-a', 'Simulator', '--args', '-CurrentDeviceUDID', A])
    expect(runner.mock.calls.filter(([command]) => command === 'osascript')).toHaveLength(1)
  })

  it.each(['Accessibility permission denied', 'No Simulator window matched this device'])('returns a visible reason after activation when raising fails: %s', async (reason) => {
    const baseline = setup()
    const { api, runner } = setup(async (command, args) => command === 'osascript' ? `not-raised\n${reason}` : baseline.runner(command, args))
    const result = await call(api, `/${A}/open`, 'POST')
    expect(result.status).toBe(200)
    expect(result.json()).toEqual({ ok: true, raised: false, reason })
    expect(runner.mock.calls.some(([command]) => command === 'open')).toBe(false)
    const script = runner.mock.calls.find(([command]) => command === 'osascript')![1][1]
    expect(script.indexOf('tell application "Simulator" to activate')).toBeLessThan(script.indexOf('tell application "System Events"'))
  })

  it('still activates Simulator and returns a reason when osascript itself fails', async () => {
    const baseline = setup()
    const { api, runner } = setup(async (command, args) => {
      if (command === 'osascript') throw new Error('Automation is not permitted')
      return baseline.runner(command, args)
    })
    const result = await call(api, `/${A}/open`, 'POST')
    expect(result.status).toBe(200)
    expect(result.json()).toMatchObject({ ok: true, raised: false, reason: expect.stringContaining('Automation is not permitted') })
    expect(runner).toHaveBeenLastCalledWith('open', ['-a', 'Simulator'])
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
    await call(api)
    await vi.waitFor(async () => expect(await api.list()).toHaveLength(2))
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
