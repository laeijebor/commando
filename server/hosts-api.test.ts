import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HostsApi } from './hosts-api.js'
import { HostRegistry } from './hosts.js'
import { HostsHealthMonitor, type HostProbe } from './hosts-health.js'
import { authorizeBearerOrSession } from './pairing-auth.js'
import { PairingRegistry, requestMatchesBearer } from './pairing.js'

let directory: string
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'commando-hosts-api-')) })
afterEach(async () => { await rm(directory, { recursive: true, force: true }) })
const input = { name: 'Hub', baseUrl: 'http://127.0.0.1:4310', token: 'remote-secret' }
async function setup() {
  const registry = new HostRegistry(join(directory, 'hosts.json'))
  const probe = vi.fn<HostProbe>().mockResolvedValue({ state: 'online', checkedAt: 123, latencyMs: 2 })
  const monitor = new HostsHealthMonitor(registry, probe)
  const paired = new PairingRegistry(join(directory, 'paired.json'))
  const { code } = paired.createCode()
  const device = await paired.claim({ code, deviceName: 'Phone', platform: 'ios' }, 'Local')
  const authorized = (request: IncomingMessage, url: URL) => authorizeBearerOrSession(request, url,
    () => requestMatchesBearer(request, url, (value) => value === 'owner-token'),
    async () => request.headers.cookie === 'owner=valid')
  const api = new HostsApi(registry, monitor, authorized)
  async function request(method: string, path = '', body?: unknown, options: { token?: string; cookie?: string; raw?: string; type?: string } = { token: 'owner-token' }) {
    const raw = options.raw ?? (body === undefined ? undefined : JSON.stringify(body))
    const incoming = Object.assign(Readable.from(raw === undefined ? [] : [Buffer.from(raw)]), {
      method, headers: { 'content-type': options.type ?? 'application/json', ...(options.token === undefined ? {} : { authorization: `Bearer ${options.token}` }), ...(options.cookie ? { cookie: options.cookie } : {}) }, socket: new Readable({ read() {} }),
    }) as unknown as IncomingMessage
    let status = 0
    let result = ''
    const response = { writeHead(code: number) { status = code }, end(value?: string) { result = value ?? '' } } as ServerResponse
    await api.handle(incoming, response, new URL(`/api/hosts${path}`, 'http://localhost'))
    incoming.destroy()
    return { status, body: result ? JSON.parse(result) : null }
  }
  return { registry, probe, monitor, request, device }
}

describe('hosts API authorization and probes', () => {
  it('rejects hook and paired-device tokens even alongside an owner cookie; accepts owner cookie and daemon token', async () => {
    const { request, device } = await setup()
    for (const options of [{}, { token: 'hook-token' }, { token: 'hook-token', cookie: 'owner=valid' }, { token: device.token }, { token: device.token, cookie: 'owner=valid' }]) {
      for (const [method, path] of [['GET', ''], ['POST', ''], ['PATCH', '/hub'], ['DELETE', '/hub']]) {
        expect((await request(method, path, input, options)).status).toBe(401)
      }
    }
    for (const options of [{ cookie: 'owner=valid' }, { token: 'owner-token' }]) {
      expect((await request('GET', '', undefined, options)).status).toBe(200)
    }
  })
  it('adds, lists, renames, replaces tokens and deletes without exposing credentials', async () => {
    const { request, probe, registry } = await setup()
    const added = await request('POST', '', input)
    expect(added.status).toBe(201)
    const id = added.body.host.id
    expect(probe).toHaveBeenCalledOnce()
    expect(added.body.host.health).toMatchObject({ state: 'online', checkedAt: 123 })
    expect((await request('GET')).body.hosts).toHaveLength(1)
    const renamed = await request('PATCH', `/${id}`, { name: 'New Hub' })
    expect(renamed.body.host.name).toBe('New Hub')
    expect(probe).toHaveBeenCalledOnce()
    const replaced = await request('PATCH', `/${id}`, { token: 'new-secret' })
    expect(replaced.status).toBe(200)
    expect(probe).toHaveBeenCalledTimes(2)
    expect(registry.get(id).token).toBe('new-secret')
    expect(JSON.stringify([added, renamed, replaced, await request('GET')])).not.toMatch(/remote-secret|new-secret|"token"/)
    expect((await request('DELETE', `/${id}`)).status).toBe(204)
    expect((await request('GET')).body.hosts).toEqual([])
  })
  it.each(['offline', 'unauthorized'] as const)('does not persist failed %s add or token replacement', async (state) => {
    const { request, registry, probe } = await setup()
    const host = registry.add(input)
    probe.mockResolvedValue({ state, checkedAt: 123 })
    const code = state === 'offline' ? 'host_unreachable' : 'host_unauthorized'
    expect(await request('POST', '', input)).toMatchObject({ status: 502, body: { code } })
    expect(await request('PATCH', `/${host.id}`, { token: 'bad-token' })).toMatchObject({ status: 502, body: { code } })
    expect(registry.list()).toHaveLength(1)
    expect(registry.get(host.id).token).toBe(input.token)
  })
  it('validates strict fields, bounded bodies, content type, routes and malformed JSON', async () => {
    const { request, registry, probe } = await setup()
    for (const body of [null, [], {}, { ...input, id: 'injected' }, { ...input, baseUrl: 'http://example.com' }, { ...input, token: 'a\nb' }]) {
      expect((await request('POST', '', body)).status).toBe(400)
    }
    expect(await request('POST', '', input, { token: 'owner-token', type: 'text/plain' })).toMatchObject({ status: 415, body: { code: 'unsupported_media_type' } })
    expect(await request('POST', '', undefined, { token: 'owner-token', raw: '{broken' })).toMatchObject({ status: 400, body: { code: 'invalid_json' } })
    expect(await request('POST', '', undefined, { token: 'owner-token', raw: 'x'.repeat(16385) })).toMatchObject({ status: 413, body: { code: 'body_too_large' } })
    expect(probe).not.toHaveBeenCalled()
    const host = registry.add(input)
    for (const body of [{}, { baseUrl: 'http://localhost' }, { name: null }, { token: '' }]) expect((await request('PATCH', `/${host.id}`, body)).status).toBe(400)
    expect((await request('PUT')).status).toBe(405)
    expect((await request('DELETE', '/missing')).status).toBe(404)
    expect((await request('GET', '/x/y')).status).toBe(404)
  })
  it('reports corrupt storage without probing or changing it', async () => {
    const { registry, request, probe } = await setup()
    await writeFile(registry.path, 'broken')
    expect(await request('POST', '', input)).toMatchObject({ status: 503, body: { code: 'hosts_corrupt' } })
    expect(await request('GET')).toMatchObject({ status: 503, body: { code: 'hosts_corrupt' } })
    expect(probe).not.toHaveBeenCalled()
  })
})
