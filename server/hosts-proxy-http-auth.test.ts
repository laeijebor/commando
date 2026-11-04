import { mkdtemp, rm } from 'node:fs/promises'
import type { ClientRequest, IncomingMessage, OutgoingHttpHeaders, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Readable } from 'node:stream'
import { afterEach, expect, it, vi } from 'vitest'
import { HostsProxy } from './hosts-proxy.js'
import { HostRegistry } from './hosts.js'
import { HOST_RESPONSE_SECURITY, remoteRequest } from './hosts-transport.js'

vi.mock('./hosts-transport.js', async (original) => ({ ...await original<typeof import('./hosts-transport.js')>(), remoteRequest: vi.fn() }))
afterEach(() => vi.resetAllMocks())

async function setup(ownerAuthorized = true) {
  const directory = await mkdtemp(join(tmpdir(), 'commando-hosts-http-auth-'))
  const registry = new HostRegistry(join(directory, 'hosts.json'))
  const host = registry.add({ name: 'Hub', baseUrl: 'http://127.0.0.1:4310', token: 'remote-secret' })
  const proxy = new HostsProxy(registry, async () => ownerAuthorized)
  const request = Object.assign(Readable.from([]), { method: 'GET', headers: { cookie: 'owner=expired' } }) as unknown as IncomingMessage
  const remote = new PassThrough()
  vi.mocked(remoteRequest).mockReturnValue(remote as unknown as ClientRequest)
  let status = 0
  let headers: OutgoingHttpHeaders = {}
  const response = Object.assign(new PassThrough(), {
    headersSent: false,
    writeHead(code: number, value: OutgoingHttpHeaders) { status = code; headers = value; this.headersSent = true },
  })
  await proxy.handle(request, response as unknown as ServerResponse, new URL(`http://localhost/h/${host.id}/api/snapshot`))
  return {
    remote, response, status: () => status, headers: () => headers,
    close: async () => { proxy.close(); request.destroy(); response.destroy(); remote.destroy(); await rm(directory, { recursive: true, force: true }) },
  }
}

it.each([401, 403])('normalizes upstream HTTP %s to the WS upgrade status/code without forwarding its body or headers', async (statusCode) => {
  const context = await setup()
  const upstream = Object.assign(new PassThrough(), {
    statusCode,
    headers: { 'content-type': 'text/html', 'content-length': '999', 'set-cookie': 'remote=secret', 'www-authenticate': 'Bearer upstream' },
  })
  try {
    context.remote.emit('response', upstream)
    expect(context.status()).toBe(502)
    expect(JSON.parse(context.response.read().toString())).toEqual({ code: 'host_unauthorized', error: 'Remote host rejected the saved token' })
    expect(context.headers()).toMatchObject({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...HOST_RESPONSE_SECURITY })
    expect(context.headers()).not.toHaveProperty('set-cookie')
    expect(context.headers()).not.toHaveProperty('www-authenticate')
    expect(upstream.destroyed).toBe(true)
  } finally { upstream.destroy(); await context.close() }
})

it('preserves local owner-auth failures as 401 unauthorized before contacting the hub', async () => {
  const context = await setup(false)
  try {
    expect(context.status()).toBe(401)
    expect(JSON.parse(context.response.read().toString())).toMatchObject({ code: 'unauthorized' })
    expect(remoteRequest).not.toHaveBeenCalled()
  } finally { await context.close() }
})
