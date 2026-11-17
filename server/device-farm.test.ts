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
  const fetcher = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input))
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
  const controller = new DeviceFarmController({ path: settingsPath, store, builtin, commandoLocksPath: join(directory, 'locks.json'), run, fetcher })
  return { controller, store, builtin, commands, checkout, settingsPath }
}
const owner = { paneId: '%3', sessionName: 'mascot' }

describe('DeviceFarmController', () => {
  it('sets up this Mac\'s farm: config, Commando\'s devices, its own token, then the launchd service', async () => {
    const { controller, commands, checkout, settingsPath } = setup()
    const status = await controller.setupLocal(checkout)
    expect(commands.map((command) => command.slice(0, 2).join(' '))).toEqual(['host init', 'host import-commando', 'host add-engineer', 'host install-service', 'host service-status'])
    expect(commands[0]).toEqual(expect.arrayContaining(['--listen-host', '127.0.0.1']))
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
})
