import type { IncomingMessage, ServerResponse } from 'node:http'
import { writeFileSync } from 'node:fs'
import { PassThrough, Readable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { BusyProcessWatch, DeviceLockApi } from './device-lock-api.js'
import { DeviceLockRegistry } from './device-locks.js'
import { DeviceDiscovery, DeviceWallApi } from './device-wall.js'

function setup() {
  const registry = new DeviceLockRegistry()
  registry.addResource({ id: 'pixel', name: 'Pixel 5', kind: 'android', serial: 'PIX' })
  registry.addResource({ id: 'iphone', name: 'iPhone 15 Pro', kind: 'ios', serial: 'd7608d6b-bc05' })
  const message = vi.fn(async (_paneId: string, _text: string): Promise<string | undefined> => undefined)
  const locks = new DeviceLockApi({ token: 't'.repeat(32), registry, processes: new BusyProcessWatch(async () => ''), message, cli: 'cli',
    paneExists: () => true, sessionName: async () => 'session', pidAlive: () => true })
  const discovery = new DeviceDiscovery(async () => '')
  const wall = new DeviceWallApi({ registry, locks, discovery, message, idleSince: (pane) => pane === '%1' ? 5 : undefined })
  return { registry, wall, message }
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

describe('DeviceDiscovery', () => {
  it('reads adb and devicectl output', async () => {
    const runner = vi.fn(async (command: string, args: string[]) => {
      if (command === 'adb') return 'List of devices attached\nPIX\tdevice\nemulator-5554\tdevice\nOFF\toffline\n'
      writeFileSync(args.at(-1)!, JSON.stringify({ result: { devices: [
        { identifier: 'D7608D6B-BC05', connectionProperties: { transportType: 'wired', tunnelState: 'connected' } },
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
  })
})
