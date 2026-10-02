import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Readable } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defaultSimLeaseStatePath, formatSimLabel, SIM_LEASE_IDLE_MS, SimLeaseApi, SimLeaseRegistry } from './sim-leases.js'

const UDID = '11111111-1111-1111-1111-111111111111'
const OTHER = '22222222-2222-2222-2222-222222222222'
const target = { sessionId: '$1', sessionName: 'Commando session', repo: { root: '/main', name: 'main', branch: 'feature', isWorktree: true, worktreeRoot: '/worktree' } }
const input = { udid: UDID, task: 'check empty state', originalName: 'iPhone 17', via: 'simslim' }
const directories: string[] = []
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))) })

describe('SimLeaseRegistry', () => {
  it('formats labels without controls or excess whitespace and limits Unicode characters', () => {
    expect(formatSimLabel(' A\tB\u0000 ', ' ready:\n empty  state\u0085 ')).toBe('A B · ready: empty state')
    expect(formatSimLabel(' session ', '   ')).toBe('session')
    expect(formatSimLabel('a \u0000 b', 'c \u0001 d')).toBe('a b · c d')
    expect(Array.from(formatSimLabel('😀'.repeat(80), 'task'))).toHaveLength(60)
  })

  it('uses port-specific paths and supports an override', () => {
    vi.stubEnv('COMMANDO_SIM_LEASES_PATH', undefined)
    expect(defaultSimLeaseStatePath(4410)).toMatch(/\.commando\/sim-leases-4410.json$/)
    vi.stubEnv('COMMANDO_SIM_LEASES_PATH', '/tmp/custom-leases.json')
    expect(defaultSimLeaseStatePath(4410)).toBe('/tmp/custom-leases.json')
  })

  it('reuses a pane lease, preserves original metadata, flags idle and touches without task loss', () => {
    let now = 100
    const registry = new SimLeaseRegistry({ now: () => now })
    registry.upsert('%1', target, input)
    now += SIM_LEASE_IDLE_MS
    expect(registry.list(() => true)[0]).toMatchObject({ idle: true, createdAt: 100, lastActiveAt: 100 })
    registry.touch('%1', { ...target, sessionName: 'Renamed', repo: undefined }, {})
    expect(registry.list(() => true)[0]).toMatchObject({ idle: false, task: input.task, label: 'Renamed · check empty state', repo: target.repo })
    registry.touch('%1', target, { task: 'ready:\n review' })
    registry.upsert('%1', target, { ...input, originalName: 'Already renamed', via: 'simfleet' })
    expect(registry.list(() => true)[0]).toMatchObject({ originalName: 'iPhone 17', via: 'simslim', createdAt: 100, lastActiveAt: now })
    expect(() => registry.upsert('%1', target, { ...input, udid: OTHER })).toThrow('Release')
    expect(() => registry.upsert('%2', target, input)).toThrow('another pane')
    registry.delete('%1')
    expect(registry.list(() => true)).toEqual([])
  })

  it('persists privately, reloads valid metadata and prunes vanished panes without device actions', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'commando-sim-leases-'))
    directories.push(directory)
    const statePath = join(directory, 'state.json')
    const registry = new SimLeaseRegistry({ statePath, now: () => 100 })
    registry.upsert('%1', target, input)
    const state = JSON.parse(await readFile(statePath, 'utf8'))
    state.leases.push(state.leases[0], { ...state.leases[0], paneId: '%2', udid: 'bad' }, { ...state.leases[0], paneId: '%3', udid: OTHER, via: 'stock' })
    await writeFile(statePath, JSON.stringify(state))
    const replay = new SimLeaseRegistry({ statePath, now: () => 101 })
    expect(replay.list(() => true)).toEqual([{ ...registry.list(() => true)[0] }])
    expect((await stat(statePath)).mode & 0o777).toBe(0o600)
    expect(replay.list(() => false)).toEqual([])
    expect(JSON.parse(await readFile(statePath, 'utf8')).leases).toEqual([])
    await writeFile(statePath, 'broken')
    expect(new SimLeaseRegistry({ statePath }).list(() => true)).toEqual([])
  })

  it('reserves before device operations, prevents races and expires abandoned reservations', () => {
    let now = 10
    const registry = new SimLeaseRegistry({ now: () => now })
    const operation = registry.reserve('%1', UDID)
    expect(registry.context('%2', target, () => true).heldUdids).toEqual([UDID])
    expect(() => registry.reserve('%2', UDID)).toThrow('another pane')
    expect(() => registry.reserve('%1', UDID)).toThrow('in progress')
    expect(() => registry.upsert('%2', target, input)).toThrow('another pane')
    expect(() => registry.upsert('%1', target, input)).toThrow('in progress')
    expect(() => registry.unlock('%1', 'wrong')).toThrow('in progress')
    registry.upsert('%1', target, { ...input, operation })
    registry.unlock('%1', operation)
    const next = registry.reserve('%1', UDID)
    now += SIM_LEASE_IDLE_MS
    registry.list(() => true)
    expect(() => registry.touch('%1', target, { operation: next })).toThrow('expired')
    expect(registry.context('%2', target, () => false).heldUdids).toEqual([])
  })
})

describe('SimLeaseApi', () => {
  const token = 't'.repeat(32)
  function setup() {
    const registry = new SimLeaseRegistry({ now: () => 123 })
    const paneExists = (paneId: string) => paneId === '%1' || paneId === '%2'
    const api = new SimLeaseApi({ token, registry, paneExists, paneContext: async (pane) => paneExists(pane) ? target : null })
    return { api, registry }
  }
  async function call(api: SimLeaseApi, method: string, suffix = '', body?: unknown, headers: Record<string, string> = {}) {
    const request = Readable.from(body === undefined ? [] : [JSON.stringify(body)]) as IncomingMessage
    request.method = method
    request.headers = { authorization: `Bearer ${token}`, 'x-commando-pane': '%1', 'content-type': 'application/json', ...headers }
    const response = new PassThrough() as unknown as ServerResponse
    const chunks: Buffer[] = []
    response.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
    response.setHeader = vi.fn().mockReturnValue(response)
    response.writeHead = vi.fn().mockReturnValue(response)
    const handled = await api.handle(request, response, new URL('http://localhost/api/sim-leases' + suffix))
    return { handled, status: vi.mocked(response.writeHead).mock.calls[0]?.[0], body: chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null, response }
  }

  it('authenticates, resolves daemon context, upserts, touches, lists and deletes', async () => {
    const { api } = setup()
    expect((await call(api, 'GET', '/context')).body).toEqual({ ...target, lease: null, heldUdids: [] })
    const created = await call(api, 'PUT', '', { ...input, sessionName: 'spoofed', paneId: '%2', label: 'spoofed' })
    expect(created.status).toBe(200)
    expect(created.body.lease).toMatchObject({ paneId: '%1', sessionName: target.sessionName, label: target.sessionName + ' · ' + input.task })
    const context = await call(api, 'GET', '/context', undefined, { 'x-commando-pane': '%2' })
    expect(context.body.heldUdids).toEqual([UDID])
    expect((await call(api, 'PUT', '', input, { 'x-commando-pane': '%2' })).status).toBe(409)
    expect((await call(api, 'PATCH', '', { task: 'ready: review' })).body.lease.label).toBe('Commando session · ready: review')
    expect((await call(api, 'GET')).body.leases).toHaveLength(1)
    expect((await call(api, 'DELETE', '', {})).status).toBe(200)
    expect((await call(api, 'GET')).body.leases).toEqual([])
  })

  it('rejects invalid auth, methods, panes, inputs and oversized bodies', async () => {
    const { api } = setup()
    expect((await call(api, 'GET', '', undefined, { authorization: 'Bearer wrong' })).status).toBe(401)
    expect((await call(api, 'POST')).status).toBe(405)
    expect((await call(api, 'GET', '/context', undefined, { 'x-commando-pane': 'bad' })).status).toBe(400)
    expect((await call(api, 'GET', '/context', undefined, { 'x-commando-pane': '%9' })).status).toBe(404)
    expect((await call(api, 'PUT', '', input, { 'content-type': 'text/plain' })).status).toBe(415)
    expect((await call(api, 'PUT', '', { ...input, udid: 'bad' })).status).toBe(400)
    expect((await call(api, 'PUT', '', [])).status).toBe(400)
    expect((await call(api, 'PUT', '', input, { 'content-length': '20000' })).status).toBe(413)
    expect((await call(api, 'PUT', '', { ...input, task: 'x'.repeat(20000) })).status).toBe(413)
    expect((await call(api, 'PATCH', '', {})).status).toBe(404)
    expect((await call(api, 'GET', '/unrelated')).handled).toBe(false)
  })

  it('holds devices across concurrent CLI operations and unlocks without deleting a lease', async () => {
    const { api } = setup()
    const { operation } = (await call(api, 'POST', '/reservation', { udid: UDID })).body
    expect((await call(api, 'POST', '/reservation', { udid: UDID }, { 'x-commando-pane': '%2' })).status).toBe(409)
    expect((await call(api, 'PUT', '', input)).status).toBe(409)
    expect((await call(api, 'PUT', '', { ...input, operation })).status).toBe(200)
    expect((await call(api, 'DELETE', '/reservation', { operation })).status).toBe(200)
    expect((await call(api, 'GET')).body.leases).toHaveLength(1)
  })
})
