import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { PairingApi } from './pairing-api.js'
import { PairingRegistry, requestMatchesBearer } from './pairing.js'

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))) })
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'commando-pairing-api-'))
  directories.push(dir)
  const registry = new PairingRegistry(join(dir, 'devices.json'))
  const api = new PairingApi(registry, async (req, url) => req.headers.cookie === 'owner=session' || requestMatchesBearer(req, url, (token) => token === 'owner'), async () => ({ urls: ['http://127.0.0.1:4310'], name: 'Mac', tailscaleEnabled: false }), (req, url) => requestMatchesBearer(req, url, (token) => token === 'owner') || req.headers.origin === 'http://localhost:4310')
  // Exercise HTTP dispatch and streamed JSON without binding a sandbox-forbidden port.
  const call = async (path: string, method = 'GET', token?: string, body?: unknown, cookie?: string, origin?: string) => {
    const request = Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []) as IncomingMessage
    Object.assign(request, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(cookie ? { cookie } : {}), ...(origin ? { origin } : {}) }, socket: { remoteAddress: '127.0.0.1' } })
    let status = 200
    const headers = new Headers()
    let result = ''
    const response = {
      setHeader(key: string, value: string) { headers.set(key, value) },
      writeHead(value: number, values: Record<string, string>) { status = value; for (const [key, entry] of Object.entries(values)) headers.set(key, entry) },
      end(value: string) { result = value },
    } as unknown as ServerResponse
    expect(await api.handle(request, response, new URL(`http://localhost/api/pairing/${path}`))).toBe(true)
    return new Response(result, { status, headers })
  }
  return { call, registry }
}
it('owner creates QR, unauthenticated phone claims, device cannot manage pairing, owner revokes', async () => {
  const { call } = await setup()
  expect((await call('codes', 'POST')).status).toBe(401)
  expect((await call('devices')).status).toBe(401)
  expect((await call('devices', 'GET', undefined, undefined, 'owner=session')).status).toBe(200)
  const codeResult = await call('codes', 'POST', 'owner')
  const { code } = await codeResult.json()
  const claimed = await call('claim', 'POST', undefined, { code, deviceName: 'iPhone', platform: 'ios' })
  expect(claimed.status).toBe(200)
  const device = await claimed.json()
  expect((await call('codes', 'POST', device.token)).status).toBe(401)
  expect((await call('devices', 'GET', device.token)).status).toBe(401)
  expect((await call(`devices/${device.deviceId}`, 'DELETE', device.token)).status).toBe(401)
  const list = await (await call('devices', 'GET', 'owner')).json()
  expect(list.devices).toHaveLength(1)
  expect(JSON.stringify(list)).not.toContain(device.token)
  expect(JSON.stringify(list)).not.toContain('tokenHash')
  expect((await call(`devices/${device.deviceId}`, 'DELETE', 'owner')).status).toBe(200)
})
it('claim errors are generic, rate limited before parsing, and bodies bounded', async () => {
  const { call } = await setup()
  const invalid = { code: 'unknown', deviceName: 'iPhone', platform: 'ios' }
  for (let i = 0; i < 10; i++) {
    const result = await call('claim', 'POST', undefined, invalid)
    expect(result.status).toBe(401)
    expect(await result.json()).toEqual({ error: 'Invalid pairing code' })
  }
  const limited = await call('claim', 'POST', undefined, invalid)
  expect(limited.status).toBe(429)
  expect(limited.headers.get('Retry-After')).toBe('60')
  const other = await setup()
  expect((await other.call('claim', 'POST', undefined, { ...invalid, code: 'x'.repeat(5000) })).status).toBe(413)
  expect((await other.call('claim', 'GET')).status).toBe(405)
})

it('requires a trusted Origin for cookie mutations, but bearer mutations remain unaffected', async () => {
  const { call, registry } = await setup()
  for (const origin of [undefined, 'http://localhost:9999', 'http://evil.test', 'null']) {
    expect((await call('codes', 'POST', undefined, undefined, 'owner=session', origin)).status).toBe(403)
  }
  const cookieCode = await call('codes', 'POST', undefined, undefined, 'owner=session', 'http://localhost:4310')
  expect(cookieCode.status).toBe(200)
  const { code } = await cookieCode.json()
  const device = await registry.claim({ code, deviceName: 'iPhone', platform: 'ios' }, 'Mac')
  expect((await call(`devices/${device.deviceId}`, 'DELETE', undefined, undefined, 'owner=session', 'http://localhost:9999')).status).toBe(403)
  expect(registry.authenticate(device.token)).toBe(device.deviceId)
  expect((await call(`devices/${device.deviceId}`, 'DELETE', undefined, undefined, 'owner=session', 'http://localhost:4310')).status).toBe(200)
  expect((await call('codes', 'POST', 'owner')).status).toBe(200)
})
