import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DeviceFarmController } from './device-farm.js'
import { SwitchableLockStore } from './device-lock-store.js'
import { DeviceLockRegistry } from './device-locks.js'

const directories: string[] = []
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })

/** A device-farm checkout on disk (just enough to be recognised), and a farm that answers over a fake fetch. */
function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'commando-farm-'))
  directories.push(directory)
  const checkout = join(directory, 'device-farm')
  mkdirSync(join(checkout, 'bin'), { recursive: true })
  writeFileSync(join(checkout, 'package.json'), JSON.stringify({ name: 'device-farm' }))
  writeFileSync(join(checkout, 'bin', 'farm.mjs'), '')
  const config = join(directory, 'farm-config.json')
  const settingsPath = join(directory, 'device-farm.json')
  writeFileSync(settingsPath, JSON.stringify({ use: 'builtin', local: { url: 'http://127.0.0.1:4599', config } }))
  const commands: string[][] = []
  const run = async (args: string[]) => {
    commands.push(args.slice(1))
    if (args[2] === 'init') writeFileSync(config, '{}')
    if (args[2] === 'add-engineer') return JSON.stringify({ id: 'commando', token: 'farm_commando', url: 'http://127.0.0.1:4599' })
    if (args[2] === 'service-status') return JSON.stringify({ installed: true, state: 'running', healthy: true })
    return '{}'
  }
  const hooks: { beforeHealthy?: () => void } = {}
  const fetcher = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    if (url.pathname === '/healthz') hooks.beforeHealthy?.()
    const ok = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } })
    if (url.pathname === '/healthz') return ok({ ok: true })
    if (url.pathname === '/api/state') {
      return (init?.headers as Record<string, string>)?.authorization === 'Bearer bad' ? new Response('{"error":"Unknown or missing farm token"}', { status: 401 }) : ok({ me: { id: 'leo', name: 'Leo', admin: false } })
    }
    if (url.pathname === '/api/changes') return ok({ version: 1, snapshot: { resources: [{ id: 'pixel', name: 'Pixel', kind: 'android', serial: 'P1' }], holders: [], queue: [], paused: [], cleaning: [] },
      positions: {}, health: {}, waitingFor: {}, timing: {}, engineers: [] })
    return ok({})
  }) as typeof fetch
  const builtin = new DeviceLockRegistry({ statePath: join(directory, 'locks.json') })
  builtin.addResource({ id: 'pixel', name: 'Pixel 5', kind: 'android', serial: 'P1' })
  const store = new SwitchableLockStore(builtin)
  const controller = new DeviceFarmController({ path: settingsPath, store, builtin, commandoLocksPath: join(directory, 'locks.json'), daemonPort: 4310, run, fetcher })
  return { controller, store, builtin, commands, checkout, settingsPath, hooks }
}
const owner = { paneId: '%3', sessionName: 'mascot' }

describe('DeviceFarmController', () => {
  it('sets up this Mac\'s farm: config, Commando\'s devices, its own token, then the launchd service', async () => {
    const { controller, commands, checkout, settingsPath } = setup()
    const status = await controller.setupLocal(checkout)
    expect(commands.map((command) => command.slice(0, 2).join(' '))).toEqual(['host init', 'host import-commando', 'host add-engineer', 'host install-service', 'host service-status'])
    expect(commands[0]).toEqual(expect.arrayContaining(['--listen-host', '127.0.0.1']))
    // Each daemon is its own engineer on the farm, so a test daemon on another port can't take this one's token.
    expect(commands[2]).toEqual(expect.arrayContaining(['add-engineer', 'commando-4310']))
    expect(status.local).toMatchObject({ configured: true, hasToken: true, checkout })
    expect(JSON.parse(readFileSync(settingsPath, 'utf8')).local.token).toBe('farm_commando')
    // Again: the config and token exist, so only the import and the service are redone.
    commands.length = 0
    await controller.setupLocal(checkout)
    expect(commands.map((command) => command.slice(0, 2).join(' '))).toEqual(['host import-commando', 'host install-service', 'host service-status'])
  })

  it('checks a remote farm\'s token before saving it', async () => {
    const { controller } = setup()
    await expect(controller.setRemote({ url: 'http://farm-mini:4500', token: 'bad' })).rejects.toThrow(/Unknown or missing farm token/)
    expect((await controller.setRemote({ url: 'http://farm-mini:4500/', token: 'farm_leo' })).remote).toMatchObject({ url: 'http://farm-mini:4500' })
    expect((await controller.setRemote(undefined)).remote).toBeNull()
  })

  it('switches to the farm only once nothing is held or queued on the built-in queue', async () => {
    const { controller, store, builtin, checkout } = setup()
    await expect(controller.requestSwitch('farm')).rejects.toThrow(/Set up the local farm first/)
    await controller.setupLocal(checkout)
    builtin.lock({ ...owner, request: 'pixel', task: 'profiling' })
    const waiting = await controller.requestSwitch('farm')
    expect(waiting).toMatchObject({ use: 'builtin', switching: 'farm', waitingOn: { held: 1, queued: 0 } })
    expect(store.store).toBe(builtin)
    builtin.release(owner, 'pixel')
    await controller.tick()
    expect(store.store).not.toBe(builtin)
    expect(store.snapshot().resources.map((resource) => resource.name)).toEqual(['Pixel'])
    expect((await controller.status())).toMatchObject({ use: 'farm' })
    expect((await controller.status()).switching).toBeUndefined()
    await controller.requestSwitch('builtin')
    expect(store.store).toBe(builtin)
    controller.stop()
  })

  it('doesn\'t switch if a lock is taken while it waits for the farm', async () => {
    const { controller, store, builtin, checkout, hooks } = setup()
    await controller.setupLocal(checkout)
    hooks.beforeHealthy = () => { hooks.beforeHealthy = undefined; builtin.lock({ ...owner, request: 'pixel', task: 'snuck in' }) }
    const status = await controller.requestSwitch('farm')
    expect(store.store).toBe(builtin)
    expect(status).toMatchObject({ use: 'builtin', switching: 'farm', waitingOn: { held: 1 } })
    controller.stop()
  })

  it('goes straight onto the farm store after a restart, and relays an offer that arrived while Commando was stopped', async () => {
    const { controller, store, builtin, checkout, settingsPath } = setup()
    await controller.setupLocal(checkout)
    await controller.requestSwitch('farm')
    controller.stop()
    // Restart: a new controller over the same settings.
    const restarted = new DeviceFarmController({ path: settingsPath, store, builtin, commandoLocksPath: join(settingsPath, '..', 'locks.json'), daemonPort: 4310,
      run: async () => '{}', fetcher: (async (input: string | URL) => {
        const url = new URL(String(input))
        const ok = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } })
        if (url.pathname === '/api/state') return ok({ me: { id: 'commando-4310', name: 'Commando', admin: true } })
        if (url.pathname === '/api/changes') return ok({ version: 7, snapshot: { resources: [{ id: 'pixel', name: 'Pixel', kind: 'android', serial: 'P1' }], holders: [],
          queue: [{ engineer: 'commando-4310', session: 'cmd4310:%3', id: 'q1', request: 'pixel', resourceIds: ['pixel'], task: 't', mode: 'notify', enqueuedAt: 1, offer: { resourceId: 'pixel', at: 5 } }],
          paused: [], cleaning: [] }, positions: {}, health: {}, waitingFor: {}, timing: {}, engineers: [] })
        return ok({})
      }) as typeof fetch })
    const offers: string[] = []
    store.onOffered((entries) => offers.push(...entries.map((entry) => entry.id)))
    restarted.start()
    expect(store.store).not.toBe(builtin)
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(offers).toEqual(['q1'])
    restarted.stop()
  })

  it('won\'t switch back to the built-in queue while the farm hasn\'t been read', async () => {
    const { controller, store, builtin, checkout, settingsPath } = setup()
    await controller.setupLocal(checkout)
    await controller.requestSwitch('farm')
    controller.stop()
    const unreachable = new DeviceFarmController({ path: settingsPath, store, builtin, commandoLocksPath: join(settingsPath, '..', 'locks.json'), daemonPort: 4310,
      run: async () => '{}', fetcher: (async () => { throw new Error('ECONNREFUSED') }) as typeof fetch })
    unreachable.start()
    const status = await unreachable.requestSwitch('builtin')
    expect(status).toMatchObject({ use: 'farm', switching: 'builtin' })
    expect(store.store).not.toBe(builtin)
    unreachable.stop()
  })

  it('won\'t replace the remote farm while a farm hasn\'t been read', async () => {
    const { controller, store, builtin, checkout, settingsPath } = setup()
    await controller.setupLocal(checkout)
    await controller.requestSwitch('farm')
    controller.stop()
    const unreachable = new DeviceFarmController({ path: settingsPath, store, builtin, commandoLocksPath: join(settingsPath, '..', 'locks.json'), daemonPort: 4310,
      run: async () => '{}', fetcher: (async () => { throw new Error('ECONNREFUSED') }) as typeof fetch })
    unreachable.start()
    await expect(unreachable.setRemote(undefined)).rejects.toThrow(/farms have been read/)
    unreachable.stop()
  })
})
