import { mkdtemp, rm } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { expect, it } from 'vitest'
import { HostRegistry } from './hosts.js'
import { HostsProxy } from './hosts-proxy.js'
import { authorizeBearerOrSession } from './pairing-auth.js'
import { PairingRegistry, requestMatchesBearer } from './pairing.js'

it('rejects actual paired-device and hook tokens on HTTP and WS, including owner-cookie fallback and every bearer transport', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'commando-hosts-owner-'))
  const paired = new PairingRegistry(join(directory, 'paired.json'))
  const { code } = paired.createCode()
  const device = await paired.claim({ code, deviceName: 'Phone', platform: 'ios' }, 'Local')
  const proxy = new HostsProxy(new HostRegistry(join(directory, 'hosts.json')), (request, url) => authorizeBearerOrSession(request, url,
    () => requestMatchesBearer(request, url, (token) => token === 'owner-token'), async () => request.headers.cookie === 'owner=valid'))
  try {
    expect(paired.authenticate(device.token)).toBe(device.deviceId)
    for (const token of [device.token, 'hook-token']) {
      for (const transport of ['header', 'query', 'subprotocol']) {
        const headers: IncomingMessage['headers'] = { cookie: 'owner=valid' }
        const query = transport === 'query' ? `?token=${encodeURIComponent(token)}` : ''
        if (transport === 'header') headers.authorization = `Bearer ${token}`
        if (transport === 'subprotocol') headers['sec-websocket-protocol'] = `commando, commando-auth.${encodeURIComponent(token)}`
        const incoming = Object.assign(new PassThrough(), { method: 'GET', headers }) as unknown as IncomingMessage
        let status = 0
        let body = ''
        const response = { writeHead(code: number) { status = code }, end(value: string) { body = value } } as ServerResponse
        expect(await proxy.handle(incoming, response, new URL(`http://localhost/h/hub/api/hosts${query}`))).toBe(true)
        expect(status).toBe(401)
        expect(JSON.parse(body).code).toBe('unauthorized')
        const socket = new PassThrough()
        await proxy.upgrade(incoming, socket, Buffer.alloc(0), new URL(`http://localhost/h/hub/ws${query}`))
        expect(socket.read().toString()).toContain('HTTP/1.1 401 Unauthorized')
        incoming.destroy(); socket.destroy()
      }
    }
  } finally { proxy.close(); await rm(directory, { recursive: true, force: true }) }
})
