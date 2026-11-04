import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentHookInstaller } from './agent-hook-installer.js'
import { generatedDeviceCli } from './device-lock-cli.js'

type Request = (method: string, path: string, body?: unknown) => Promise<{ status: number; result: any }>
type Cli = {
  parseDeviceArgs: (args: string[]) => any
  parseDuration: (value: string) => number
  formatList: (view: any, now?: number) => string
  runDeviceCli: (args: string[], request: Request, options?: Record<string, unknown>) => Promise<number>
}
const dirs: string[] = []
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))) })
async function load(): Promise<Cli> {
  return import(`data:text/javascript;base64,${Buffer.from(generatedDeviceCli('/test/token').replace(/^#![^\n]*\n/, '')).toString('base64')}`)
}
const pixel = { id: 'pixel', name: 'Pixel 5', kind: 'android', serial: '25121FDD4S00H7', release: 'restore a2' }
const holder = { paneId: '%1', sessionName: 'mascot', as: 'MASCOT', resourceId: 'pixel', task: 'Rive round', acquiredAt: 0, estimateMs: 25 * 60_000 }

describe('generated device CLI', () => {
  it('parses commands and flags', async () => {
    const cli = await load()
    expect(cli.parseDeviceArgs(['lock', 'pixel', '--task', 'Rive round', '--as', 'MASCOT', '--estimate', '25m'])).toMatchObject({
      command: 'lock', wait: false, body: { request: 'pixel', task: 'Rive round', as: 'MASCOT', mode: 'notify', estimateMs: 25 * 60_000 } })
    expect(cli.parseDeviceArgs(['lock', 'heavy', '--task', 'pod install', '--wait', '10m', '--pid', '4242'])).toMatchObject({
      wait: true, maxWaitMs: 600_000, body: { mode: 'wait', pid: 4242 } })
    expect(cli.parseDeviceArgs(['release'])).toEqual({ command: 'release', json: false, body: {} })
    expect(cli.parseDeviceArgs(['resource', 'add', 'heavy', '--name', 'Mac builds', '--kind', 'host', '--busy', 'xcodebuild', '--busy', 'gradlew'])).toMatchObject({
      command: 'resource-add', body: { id: 'heavy', busyProcesses: ['xcodebuild', 'gradlew'] } })
    expect(cli.parseDuration('90s')).toBe(90_000)
    expect(cli.parseDuration('2h')).toBe(7_200_000)
    for (const args of [[], ['lock', 'pixel'], ['lock'], ['lock', 'pixel', '--task'], ['release', 'a', 'b'], ['lock', 'pixel', '--task', 'x', '--bogus'], ['lock', 'pixel', '--task', 'x', '--pid', 'abc']]) {
      expect(() => cli.parseDeviceArgs(args)).toThrow()
    }
  })

  it('prints a held lock with its serial and release steps', async () => {
    const cli = await load(), out = vi.fn()
    const request = vi.fn(async () => ({ status: 200, result: { status: 'held', holder, resource: pixel } }))
    expect(await cli.runDeviceCli(['lock', 'pixel', '--task', 'Rive round', '--as', 'MASCOT'], request, { out, cli: 'cd' })).toBe(0)
    expect(out.mock.calls[0][0]).toBe('held Pixel 5 (pixel) · serial 25121FDD4S00H7\nBefore releasing: restore a2.\nRelease with: cd release pixel --as "MASCOT"')
  })

  it('exits 3 and explains the queue when the device is busy', async () => {
    const cli = await load(), out = vi.fn()
    const entry = { id: 'e1', paneId: '%2', sessionName: 'memleak', request: 'pixel', resourceIds: ['pixel'], task: 'Allocations', mode: 'notify', enqueuedAt: 0 }
    const request = vi.fn(async () => ({ status: 200, result: { status: 'queued', entry, position: 1, holders: [holder], offered: [] } }))
    expect(await cli.runDeviceCli(['lock', 'pixel', '--task', 'Allocations'], request, { out, now: () => 18 * 60_000 })).toBe(3)
    expect(out.mock.calls[0][0]).toContain('queued #1 for pixel\nHeld by MASCOT (mascot): Rive round (18m of est. 25m)\nCommando will message this pane')
  })

  it('blocks with --wait until granted, then prints the lock', async () => {
    const cli = await load(), out = vi.fn(), err = vi.fn()
    const entry = { id: 'e1', paneId: '%2', sessionName: 'sweep', request: 'pixel', resourceIds: ['pixel'], task: 'sweep', mode: 'wait', enqueuedAt: 0 }
    const responses = [
      { status: 'queued', entry, position: 2, holders: [holder] },
      { status: 'queued', entry, position: 1, holders: [holder] },
      { status: 'held', holder: { ...holder, as: undefined, task: 'sweep' }, resource: pixel },
    ]
    const request = vi.fn(async (_method: string, _path: string) => ({ status: 200, result: responses.shift() }))
    expect(await cli.runDeviceCli(['lock', 'pixel', '--task', 'sweep', '--wait', '--pid', '99'], request, { out, err, onSignal: () => {} })).toBe(0)
    expect(request.mock.calls.map((call) => call[1])).toEqual(['/lock', '/entry?id=e1&wait=55', '/entry?id=e1&wait=55'])
    expect(err.mock.calls.map((call) => call[0])).toEqual([expect.stringContaining('waiting: queued #2'), expect.stringContaining('waiting: queued #1')])
    expect(out.mock.calls[0][0]).toContain('held Pixel 5')
  })

  it('gives up after the --wait limit and leaves the queue', async () => {
    const cli = await load(), err = vi.fn()
    let now = 0
    const entry = { id: 'e1', request: 'pixel', resourceIds: ['pixel'], task: 't', mode: 'wait', enqueuedAt: 0, sessionName: 's' }
    const request = vi.fn(async (method: string, path: string) => {
      if (path.startsWith('/entry')) now += 60_000
      return { status: 200, result: method === 'POST' && path === '/cancel' ? { cancelled: [entry] } : { status: 'queued', entry, position: 1, holders: [] } }
    })
    expect(await cli.runDeviceCli(['lock', 'pixel', '--task', 't', '--wait', '1m'], request, { err, now: () => now, onSignal: () => {} })).toBe(3)
    expect(request).toHaveBeenLastCalledWith('POST', '/cancel', { request: 'pixel' })
    expect(err).toHaveBeenLastCalledWith('Gave up waiting after 1m.')
  })

  it('lists holders and queues per device', async () => {
    const cli = await load()
    const text = cli.formatList({ resources: [pixel, { id: 'moto', name: 'moto e13', kind: 'android' }], holders: [holder], paused: [],
      queue: [{ id: 'e', paneId: '%3', sessionName: 'lottie', request: 'any-android', resourceIds: ['pixel', 'moto'], task: 'smoke', mode: 'notify', enqueuedAt: 0, position: 1 }] }, 6 * 60_000)
    expect(text).toBe('pixel · Pixel 5 · held\n  holding  MASCOT (mascot): Rive round (6m of est. 25m)\n  #1       lottie: smoke [any-android] · waiting 6m\nmoto · moto e13 · free\n  #1       lottie: smoke [any-android] · waiting 6m')
  })

  it('reports API errors with exit 1 via the thrown message', async () => {
    const cli = await load()
    await expect(cli.runDeviceCli(['release', 'pixel'], async () => ({ status: 404, result: { error: "You don't hold pixel" } }))).rejects.toThrow("You don't hold pixel")
  })

  it('is installed next to the other hook CLIs', async () => {
    const home = await mkdtemp(join(tmpdir(), 'device-cli-'))
    dirs.push(home)
    const installer = new AgentHookInstaller({ home })
    await installer.install()
    const path = join(home, '.commando/hooks/commando-device.mjs')
    expect(await readFile(path, 'utf8')).toBe(generatedDeviceCli(join(home, '.commando/agent-hook-token')))
    expect((await stat(path)).mode & 0o777).toBe(0o700)
  })
})
