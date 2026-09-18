import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { PushApi } from './push-api.js'
import { PushDeviceRegistry, type PushDevice } from './push-devices.js'

const servers: Server[] = []
const directories: string[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function startApi(): Promise<{
  baseUrl: string
  registry: PushDeviceRegistry
  sendTest: ReturnType<typeof vi.fn>
}> {
  const directory = await mkdtemp(join(tmpdir(), 'commando-push-api-'))
  directories.push(directory)
  const registry = new PushDeviceRegistry(join(directory, 'push-devices.json'))
  const sendTest = vi.fn().mockResolvedValue({ accepted: 1, rejected: 0, unregisteredTokens: [] })
  const api = new PushApi({ registry, sendTest: sendTest as unknown as (device: PushDevice) => Promise<never> })
  const server = createServer((request, response) => {
    void api.handle(request, response, new URL(request.url ?? '/', 'http://127.0.0.1'))
  })
  servers.push(server)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, registry, sendTest }
}

const body = {
  expoPushToken: 'ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]',
  name: 'iPhone',
  platform: 'ios',
  rules: {
    needsInput: true,
    done: true,
    failed: false,
    quietHours: { start: '23:00', end: '07:00', timeZone: 'Europe/Berlin' },
    mutedSessions: ['scratch'],
  },
}

function put(baseUrl: string, id: string, payload: unknown): Promise<Response> {
  return fetch(`${baseUrl}/api/push/devices/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
}

describe('push API', () => {
  it('registers, lists, updates and deletes a device', async () => {
    const { baseUrl, registry } = await startApi()

    const created = await put(baseUrl, 'phone-1', body)
    expect(created.status).toBe(200)
    expect(await created.json()).toMatchObject({
      ok: true,
      device: { id: 'phone-1', name: 'iPhone', platform: 'ios', rules: { failed: false, mutedSessions: ['scratch'] } },
    })

    const listed = await fetch(`${baseUrl}/api/push/devices`)
    expect(listed.status).toBe(200)
    expect(await listed.json()).toMatchObject({ devices: [{ id: 'phone-1' }] })

    const updated = await put(baseUrl, 'phone-1', { ...body, name: 'iPhone 17' })
    expect(updated.status).toBe(200)
    expect(registry.get('phone-1')?.name).toBe('iPhone 17')
    expect(registry.list()).toHaveLength(1)

    const deleted = await fetch(`${baseUrl}/api/push/devices/phone-1`, { method: 'DELETE' })
    expect(deleted.status).toBe(200)
    expect(await deleted.json()).toMatchObject({ ok: true, deviceId: 'phone-1', removed: true })
    expect(registry.list()).toEqual([])

    const missing = await fetch(`${baseUrl}/api/push/devices/phone-1`, { method: 'DELETE' })
    expect(missing.status).toBe(404)
  })

  it('rejects bad input, bad ids, oversized bodies and wrong methods', async () => {
    const { baseUrl, registry } = await startApi()

    expect((await put(baseUrl, 'phone-1', { ...body, expoPushToken: 'nope' })).status).toBe(400)
    expect((await put(baseUrl, 'phone-1', { ...body, rules: { needsInput: true, done: true } })).status).toBe(400)
    expect((await put(baseUrl, 'phone-1', { ...body, id: 'other' })).status).toBe(400)
    expect((await put(baseUrl, 'not%20a%20device%20id', body)).status).toBe(400)
    expect(registry.list()).toEqual([])

    const oversized = await fetch(`${baseUrl}/api/push/devices/phone-1`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, name: 'x'.repeat(20_000) }),
    })
    expect(oversized.status).toBe(413)

    const wrongType = await fetch(`${baseUrl}/api/push/devices/phone-1`, {
      method: 'PUT',
      headers: { 'Content-Type': 'text/plain' },
      body: 'hello',
    })
    expect(wrongType.status).toBe(415)

    const wrongMethod = await fetch(`${baseUrl}/api/push/devices`, { method: 'DELETE' })
    expect(wrongMethod.status).toBe(405)
    expect(wrongMethod.headers.get('Allow')).toBe('GET')

    expect((await fetch(`${baseUrl}/api/push/unknown`)).status).toBe(404)
  })

  it('refuses a seventeenth device', async () => {
    const { baseUrl } = await startApi()
    for (let index = 0; index < 16; index += 1) {
      expect((await put(baseUrl, `phone-${index}`, body)).status).toBe(200)
    }
    const overflow = await put(baseUrl, 'phone-16', body)
    expect(overflow.status).toBe(409)
  })

  it('sends a test notification to a registered device only', async () => {
    const { baseUrl, sendTest } = await startApi()
    await put(baseUrl, 'phone-1', body)

    const response = await fetch(`${baseUrl}/api/push/devices/phone-1/test`, { method: 'POST' })
    expect(response.status).toBe(202)
    expect(await response.json()).toMatchObject({ ok: true, deviceId: 'phone-1', accepted: 1 })
    expect(sendTest).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: 'phone-1' }))

    const missing = await fetch(`${baseUrl}/api/push/devices/phone-2/test`, { method: 'POST' })
    expect(missing.status).toBe(404)

    const wrongMethod = await fetch(`${baseUrl}/api/push/devices/phone-1/test`)
    expect(wrongMethod.status).toBe(405)
    expect(wrongMethod.headers.get('Allow')).toBe('POST')
  })

  it('ignores requests outside the push namespace', async () => {
    const { baseUrl } = await startApi()
    const api = new PushApi({
      registry: new PushDeviceRegistry('/dev/null'),
      sendTest: () => Promise.resolve({ accepted: 0, rejected: 0, unregisteredTokens: [] }),
    })
    const handled = await api.handle(
      { method: 'GET', headers: {} } as never,
      { writeHead: () => undefined, end: () => undefined } as never,
      new URL('/api/snapshot', baseUrl),
    )
    expect(handled).toBe(false)
  })
})
