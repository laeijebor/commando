import { EventEmitter } from 'node:events'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { PassThrough, Readable } from 'node:stream'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { PairingRegistry } from './pairing.js'
import { PairingRequestAuth } from './pairing-auth.js'
import { PushApi } from './push-api.js'
import { PushDeviceRegistry } from './push-devices.js'
import { SessionIdeApi } from './session-ides-api.js'
import type { SessionIdeService } from './session-ides.js'

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))) })
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'commando-pairing-security-'))
  directories.push(dir)
  const registry = new PairingRegistry(join(dir, 'paired-devices-4411.json'))
  const { code } = registry.createCode()
  const device = await registry.claim({ code, deviceName: 'iPhone', platform: 'ios' }, 'Mac')
  const auth = new PairingRequestAuth(registry)
  const request = (body?: unknown) => {
    const req = (body ? Readable.from([Buffer.from(JSON.stringify(body))]) : new PassThrough()) as IncomingMessage
    const socket = new PassThrough()
    socket.on('close', () => req.destroy())
    Object.assign(req, { method: 'POST', headers: { authorization: `Bearer ${device.token}`, 'content-type': 'application/json' }, socket })
    return req
  }
  return { dir, registry, device, auth, request }
}
function response() {
  const res = new EventEmitter() as ServerResponse
  let status = 200
  let json: unknown
  const headers = new Map<string, unknown>()
  res.setHeader = ((key: string, value: unknown) => { headers.set(key, value); return res }) as ServerResponse['setHeader']
  res.writeHead = ((value: number) => { status = value; return res }) as ServerResponse['writeHead']
  res.end = ((value: string) => { json = JSON.parse(value); res.emit('finish'); return res }) as ServerResponse['end']
  return { res, headers, get status() { return status }, get json() { return json } }
}
it('revoke destroys slow-body device HTTP requests before their operation can run', async () => {
  const { registry, device, auth, request } = await setup()
  const req = request()
  const { res } = response()
  auth.trackResponse(req, res)
  expect(auth.authorize(req, new URL('http://localhost/api/panes/run'))).toBe(true)
  let executed = false
  const action = (async () => {
    try { for await (const _chunk of req) { /* await the rest of the body */ }; executed = true } catch { /* socket destroyed */ }
  })()
  ;(req as unknown as PassThrough).write('{')
  await registry.revoke(device.deviceId)
  await action
  expect(req.socket.destroyed).toBe(true)
  expect(executed).toBe(false)
})
it('finished HTTP requests release their tracking without closing a later keepalive request', async () => {
  const { registry, device, auth, request } = await setup()
  const req = request()
  const { res } = response()
  auth.trackResponse(req, res)
  auth.authorize(req, new URL('http://localhost/api/health'))
  res.emit('finish')
  await registry.revoke(device.deviceId)
  expect(req.socket.destroyed).toBe(false)
  req.destroy(); req.socket.destroy()
})
it('device principals cannot mint persistent IDE cookies', async () => {
  const { auth, request } = await setup()
  const req = request()
  const url = new URL('http://localhost/api/ides/sessions/%241')
  auth.authorize(req, url)
  const attach = vi.fn()
  const refresh = vi.fn()
  const api = new SessionIdeApi({ service: { attach } as unknown as SessionIdeService, refresh, currentSessionIds: () => ['$1'], currentPanes: () => [], isDeviceRequest: (request) => auth.deviceId(request) !== undefined })
  const result = response()
  expect(await api.handle(req, result.res, url)).toBe(true)
  expect(result.status).toBe(403)
  expect(result.headers.has('Set-Cookie')).toBe(false)
  expect(attach).not.toHaveBeenCalled()
  expect(refresh).not.toHaveBeenCalled()
  req.destroy(); req.socket.destroy()
})
it('binds push registration metadata to its authenticating principal and removes it on revoke', async () => {
  const { dir, registry, device, auth, request } = await setup()
  const push = new PushDeviceRegistry(join(dir, 'push.json'))
  registry.onRevoke((id) => push.removeByPrincipal(id))
  const api = new PushApi({ registry: push, sendTest: vi.fn(), devicePrincipal: (req) => auth.deviceId(req), principalActive: (id) => registry.isActive(id) })
  const req = request({ name: 'iPhone', platform: 'ios', expoPushToken: 'ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]', principalId: 'spoofed-owner', rules: { needsInput: true, done: true, failed: true, mutedSessions: [] } })
  req.method = 'PUT'
  const url = new URL('http://localhost/api/push/devices/phone')
  const result = response()
  auth.trackResponse(req, result.res)
  auth.authorize(req, url)
  await api.handle(req, result.res, url)
  expect(result.status).toBe(200)
  expect(push.get('phone')?.principalId).toBe(device.deviceId)
  const reloaded = new PushDeviceRegistry(push.statePath)
  await reloaded.load()
  expect(reloaded.get('phone')?.principalId).toBe(device.deviceId)
  await registry.revoke(device.deviceId)
  expect(push.list()).toEqual([])
  expect(JSON.parse(await readFile(push.statePath, 'utf8')).devices).toEqual([])
  req.socket.destroy()
})
