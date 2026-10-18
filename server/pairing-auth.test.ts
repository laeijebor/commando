import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, expect, it, vi } from 'vitest'
import { authorizeBearerOrSession, PairingRequestAuth } from './pairing-auth.js'
import { PairingRegistry, requestMatchesBearer } from './pairing.js'

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))) })

type Transport = 'header' | 'query' | 'subprotocol'
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'commando-bearer-precedence-'))
  directories.push(directory)
  const registry = new PairingRegistry(join(directory, 'devices.json'))
  const { code } = registry.createCode()
  const device = await registry.claim({ code, deviceName: 'iPhone', platform: 'ios' }, 'Mac')
  const devices = new PairingRequestAuth(registry)
  const hasSession = vi.fn(async () => true)
  const bearerAuthorized = (request: IncomingMessage, url: URL, ownerOnly: boolean) => (
    requestMatchesBearer(request, url, (token) => token === 'owner-token') || (!ownerOnly && devices.authorize(request, url))
  )

  // Dispatch real server request/upgrade events without binding sandbox-forbidden sockets.
  async function dispatch(kind: 'http' | 'upgrade', options: { transport?: Transport; token?: string; authorization?: string; protocol?: string; ownerOnly?: boolean } = {}) {
    const socket = new PassThrough()
    const url = new URL(kind === 'http' ? 'http://localhost/api/health' : 'http://localhost/ws')
    const headers: IncomingMessage['headers'] = { cookie: 'owner=valid-session' }
    if (kind === 'upgrade') headers.upgrade = 'websocket'
    if (options.transport === 'header') headers.authorization = `Bearer ${options.token ?? ''}`
    if (options.transport === 'query') url.searchParams.set('token', options.token ?? '')
    if (options.transport === 'subprotocol') headers['sec-websocket-protocol'] = `commando, commando-auth.${encodeURIComponent(options.token ?? '')}`
    if (options.authorization !== undefined) headers.authorization = options.authorization
    if (options.protocol !== undefined) headers['sec-websocket-protocol'] = options.protocol
    const request = Object.assign(new PassThrough(), { headers, url: `${url.pathname}${url.search}`, socket }) as unknown as IncomingMessage
    const authorize = () => authorizeBearerOrSession(request, url, () => bearerAuthorized(request, url, options.ownerOnly ?? false), hasSession)
    let complete!: (status: number) => void
    const result = new Promise<number>((resolve) => { complete = resolve })
    const response = new EventEmitter() as ServerResponse
    devices.trackResponse(request, response)
    const server = createServer((_request, _response) => {
      void authorize().then((allowed) => { response.emit('finish'); complete(allowed ? 200 : 401) })
    })
    server.on('upgrade', () => {
      void authorize().then((allowed) => {
        const status = allowed ? 101 : 401
        socket.end(`HTTP/1.1 ${status} ${allowed ? 'Switching Protocols' : 'Unauthorized'}\r\n\r\n`)
        complete(status)
      })
    })
    if (kind === 'http') server.emit('request', request, response)
    else server.emit('upgrade', request, socket, Buffer.alloc(0))
    const status = await result
    request.destroy(); socket.destroy()
    return status
  }
  return { registry, device, dispatch, hasSession }
}

for (const kind of ['http', 'upgrade'] as const) {
  const success = kind === 'http' ? 200 : 101
  for (const transport of ['header', 'query', 'subprotocol'] as const) {
    it(`${kind}: invalid ${transport} bearer + valid cookie returns 401 without session fallback`, async () => {
      const { dispatch, hasSession } = await setup()
      expect(await dispatch(kind, { transport, token: 'invalid-token' })).toBe(401)
      expect(hasSession).not.toHaveBeenCalled()
    })
    it(`${kind}: revoked ${transport} bearer + valid cookie returns 401`, async () => {
      const { registry, device, dispatch, hasSession } = await setup()
      await registry.revoke(device.deviceId)
      expect(await dispatch(kind, { transport, token: device.token })).toBe(401)
      expect(hasSession).not.toHaveBeenCalled()
    })
    it(`${kind}: valid device ${transport} bearer succeeds without a session`, async () => {
      const { device, dispatch, hasSession } = await setup()
      hasSession.mockResolvedValue(false)
      expect(await dispatch(kind, { transport, token: device.token })).toBe(success)
      expect(hasSession).not.toHaveBeenCalled()
    })
  }
  it(`${kind}: no bearer + valid cookie keeps session authentication`, async () => {
    const { dispatch, hasSession } = await setup()
    expect(await dispatch(kind, { protocol: 'commando' })).toBe(success)
    expect(hasSession).toHaveBeenCalledOnce()
  })
  it(`${kind}: valid automation bearer remains accepted`, async () => {
    const { dispatch, hasSession } = await setup()
    hasSession.mockResolvedValue(false)
    expect(await dispatch(kind, { transport: 'header', token: 'owner-token', ownerOnly: true })).toBe(success)
    expect(hasSession).not.toHaveBeenCalled()
  })
  it(`${kind}: device bearer cannot use an owner cookie to enter owner-only routes`, async () => {
    const { device, dispatch, hasSession } = await setup()
    expect(await dispatch(kind, { transport: 'header', token: device.token, ownerOnly: true })).toBe(401)
    expect(hasSession).not.toHaveBeenCalled()
  })
  it(`${kind}: empty, malformed and oversized credentials cannot fall back to cookies`, async () => {
    const { dispatch, hasSession } = await setup()
    for (const options of [
      { authorization: '' }, { authorization: 'Bearer' }, { authorization: 'Bearer a b' },
      { transport: 'header' as const, token: 'x'.repeat(1025) },
      { transport: 'query' as const, token: '' },
      { protocol: 'commando-auth.' }, { protocol: 'commando-auth.%invalid' }, { protocol: 'commando-auth' },
    ]) expect(await dispatch(kind, options)).toBe(401)
    expect(hasSession).not.toHaveBeenCalled()
  })
}
