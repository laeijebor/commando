import type { IncomingMessage, ServerResponse } from 'node:http'
import { writeFileSync } from 'node:fs'
import { PassThrough, Readable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { BusyProcessWatch, DeviceLockApi } from './device-lock-api.js'
import { DeviceLockRegistry } from './device-locks.js'
import { DeviceDiscovery, DeviceWallApi, deviceLockAlerts } from './device-wall.js'

function setup() {
  const registry = new DeviceLockRegistry()
  registry.addResource({ id: 'pixel', name: 'Pixel 5', kind: 'android', serial: 'PIX' })
  registry.addResource({ id: 'iphone', name: 'iPhone 15 Pro', kind: 'ios', serial: 'd7608d6b-bc05' })
  let messages = 0
  const message = vi.fn(async (_paneId: string, _text: string): Promise<string | undefined> => `m${++messages}`)
  const cancelMessage = vi.fn(async (_id: string) => {})
  const locks = new DeviceLockApi({ token: 't'.repeat(32), registry, processes: new BusyProcessWatch(async () => ''), message, cancelMessage, cli: 'cli',
    paneExists: () => true, sessionName: async () => 'session', pidAlive: () => true })
  const discovery = new DeviceDiscovery(async () => '')
  const wall = new DeviceWallApi({ registry, locks, discovery, message, idleSince: (pane) => pane === '%1' ? 5 : undefined })
  return { registry, wall, message, cancelMessage }
}

async function call(wall: DeviceWallApi, method: string, path: string, body?: unknown) {
  const request = Readable.from(body === undefined ? [] : [JSON.stringify(body)]) as IncomingMessage
  request.method = method
  request.headers = { 'content-type': 'application/json' }
  const response = new PassThrough() as unknown as ServerResponse
  const chunks: Buffer[] = []
  response.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
  response.writeHead = vi.fn().mockReturnValue(response)
  const handled = await wall.handle(request, response, new URL('http://localhost' + path))
  return { handled, status: vi.mocked(response.writeHead).mock.calls[0]?.[0], body: chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null }
}

const owner = (paneId: string, as: string) => ({ paneId, sessionName: 'battery', as })

describe('DeviceWallApi', () => {
  it('lists locks with idle times and only handles its own paths', async () => {
    const { registry, wall } = setup()
    registry.lock({ ...owner('%1', 'MASCOT'), request: 'pixel', task: 'Rive' })
    const { body } = await call(wall, 'GET', '/api/devices')
    expect(body).toMatchObject({ holders: [{ as: 'MASCOT' }], idleSince: { '%1': 5 }, connections: { pixel: 'unknown' } })
    expect((await call(wall, 'GET', '/api/devicesx')).handled).toBe(false)
  })

  it('force-releases a holder, tells them, and offers to the next agent', async () => {
    const { registry, wall, message } = setup()
    registry.lock({ ...owner('%1', 'MASCOT'), request: 'pixel', task: 'Rive' })
    registry.lock({ ...owner('%2', 'LOTTIE'), request: 'pixel', task: 'Redraw' })
    const { body } = await call(wall, 'POST', '/api/devices/pixel/release')
    expect(body.holders).toEqual([])
    expect(body.queue).toMatchObject([{ as: 'LOTTIE', offer: { resourceId: 'pixel' } }])
    expect(message).toHaveBeenCalledWith('%1', expect.stringContaining('The user released your lock on Pixel 5'))
    expect(message).toHaveBeenCalledWith('%2', expect.stringContaining('Pixel 5 is yours'))
  })

  it('reorders, pauses and removes requests', async () => {
    const { registry, wall, message } = setup()
    registry.lock({ ...owner('%1', 'A'), request: 'pixel', task: 'a' })
    const b = registry.lock({ ...owner('%2', 'B'), request: 'pixel', task: 'b' })
    const c = registry.lock({ ...owner('%3', 'C'), request: 'pixel', task: 'c' })
    if (b.status !== 'queued' || c.status !== 'queued') throw new Error('expected queued')
    expect((await call(wall, 'POST', `/api/devices/queue/${c.entry.id}/move`, { before: b.entry.id })).body.queue.map((entry: { as: string }) => entry.as)).toEqual(['C', 'B'])
    expect((await call(wall, 'POST', '/api/devices/pixel/pause')).body.paused).toEqual(['pixel'])
    expect((await call(wall, 'DELETE', `/api/devices/queue/${b.entry.id}`)).body.queue.map((entry: { as: string }) => entry.as)).toEqual(['C'])
    expect(message).toHaveBeenCalledWith('%2', expect.stringContaining('The user removed your request'))
    expect((await call(wall, 'POST', '/api/devices/pixel/resume')).body.paused).toEqual([])
    expect((await call(wall, 'POST', '/api/devices/nope/release')).status).toBe(404)
  })
})

describe('DeviceWallApi offers', () => {
  it('pausing withdraws an outstanding offer and its message; skipping does too', async () => {
    const { registry, wall, cancelMessage } = setup()
    registry.lock({ ...owner('%1', 'A'), request: 'pixel', task: 'a' })
    registry.lock({ ...owner('%2', 'B'), request: 'pixel', task: 'b' })
    registry.lock({ ...owner('%3', 'C'), request: 'pixel', task: 'c' })
    registry.release(owner('%1', 'A'), 'pixel')
    await Promise.resolve()
    const paused = (await call(wall, 'POST', '/api/devices/pixel/pause')).body
    expect(paused.queue.map((entry: { as: string; offer?: unknown }) => [entry.as, Boolean(entry.offer)])).toEqual([['B', false], ['C', false]])
    expect(cancelMessage).toHaveBeenCalledWith('m1')
    const resumed = (await call(wall, 'POST', '/api/devices/pixel/resume')).body
    expect(resumed.queue[0]).toMatchObject({ as: 'B', offer: { resourceId: 'pixel' }, claimBy: expect.any(Number) })
    await Promise.resolve()
    await call(wall, 'DELETE', `/api/devices/queue/${resumed.queue[0].id}`)
    expect(cancelMessage).toHaveBeenCalledWith('m2')
  })
})

describe('DeviceDiscovery', () => {
  it('reads adb and devicectl output', async () => {
    const runner = vi.fn(async (command: string, args: string[]) => {
      if (command === 'adb') return 'List of devices attached\nPIX\tdevice\nemulator-5554\tdevice\nOFF\toffline\n'
      writeFileSync(args.at(-1)!, JSON.stringify({ result: { devices: [
        { identifier: 'D7608D6B-BC05', hardwareProperties: { udid: '00008130-001A' }, connectionProperties: { transportType: 'wired', tunnelState: 'connected' } },
        { identifier: 'WATCH', connectionProperties: { tunnelState: 'unavailable' } },
      ] } }))
      return ''
    })
    const discovery = new DeviceDiscovery(runner)
    await discovery.refresh()
    expect(discovery.connection({ id: 'p', name: 'p', kind: 'android', serial: 'PIX' })).toBe('connected')
    expect(discovery.connection({ id: 'o', name: 'o', kind: 'android', serial: 'OFF' })).toBe('missing')
    expect(discovery.connection({ id: 'e', name: 'e', kind: 'emulator' })).toBe('connected')
    expect(discovery.connection({ id: 'i', name: 'i', kind: 'ios', serial: 'd7608d6b-bc05' })).toBe('connected')
    expect(discovery.connection({ id: 'w', name: 'w', kind: 'ios', serial: 'WATCH' })).toBe('missing')
    expect(discovery.connection({ id: 'h', name: 'h', kind: 'host' })).toBe('connected')
    expect(discovery.connection({ id: 'u', name: 'u', kind: 'ios', serial: '00008130-001a' })).toBe('connected')
    expect(discovery.connection({ id: 'n', name: 'n', kind: 'android' })).toBe('no-serial')
  })
})

describe('deviceLockAlerts', () => {
  const MIN = 60_000
  const base = { resources: [{ id: 'pixel', name: 'Pixel 5', kind: 'android' as const }], paused: [] }
  const holder = { paneId: '%1', sessionName: 'battery', as: 'MASCOT', resourceId: 'pixel', task: 'Rive', acquiredAt: 0, estimateMs: 25 * MIN, entryId: 'h1' }
  const waiter = { id: 'w1', paneId: '%2', sessionName: 'battery', as: 'LOTTIE', request: 'pixel', resourceIds: ['pixel'], task: 'Redraw', mode: 'notify' as const, enqueuedAt: 0 }

  it('stays quiet when nobody is waiting, however long the lock is held', () => {
    expect(deviceLockAlerts({ ...base, holders: [holder], queue: [] }, 300 * MIN, () => 0)).toEqual([])
  })

  it('alerts on an overrunning or idle holder others wait for, and on a long wait', () => {
    const alerts = deviceLockAlerts({ ...base, holders: [holder], queue: [{ ...waiter, enqueuedAt: 50 * MIN }] }, 80 * MIN, (pane) => pane === '%1' ? 65 * MIN : undefined)
    expect(alerts).toEqual([
      { paneId: '%1', ref: 'h1', dedupeKey: 'device-overrun:h1', title: 'Pixel 5 held for 1h 20m', body: 'MASCOT estimated 25m for "Rive". 1 waiting.' },
      { paneId: '%1', ref: 'h1', dedupeKey: `device-idle:h1:${65 * MIN}`, title: 'Pixel 5 held by an idle agent', body: 'MASCOT has been idle for 15m while holding it. 1 waiting.' },
      { paneId: '%2', ref: 'w1', dedupeKey: 'device-wait:w1', title: 'LOTTIE has waited 30m', body: 'Queued for Pixel 5: "Redraw".' },
    ])
  })

  it('ignores requests offered another device, and waits on devices the user paused', () => {
    const elsewhere = { ...waiter, request: 'any-android', resourceIds: ['pixel', 'moto'], offer: { resourceId: 'moto', at: 0 } }
    expect(deviceLockAlerts({ ...base, holders: [holder], queue: [elsewhere] }, 20 * MIN, () => 0).filter((alert) => alert.ref === 'h1')).toEqual([])
    expect(deviceLockAlerts({ ...base, paused: ['pixel'], holders: [], queue: [waiter] }, 60 * MIN, () => undefined)).toEqual([])
  })

  it('does not call a script holder idle', () => {
    expect(deviceLockAlerts({ ...base, holders: [{ ...holder, pid: 9, estimateMs: undefined }], queue: [{ ...waiter, enqueuedAt: 70 * MIN }] }, 80 * MIN, () => 0)).toEqual([])
  })
})
