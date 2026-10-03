import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Readable } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defaultSimLeaseStatePath, defaultSimPoolStatePath, SimPoolRegistry, formatSimLabel, SIM_LEASE_IDLE_MS, SimLeaseApi, SimLeaseRegistry } from './sim-leases.js'

const UDID = '11111111-1111-1111-1111-111111111111'
const OTHER = '22222222-2222-2222-2222-222222222222'
const target = { sessionId: '$1', sessionName: 'Commando session', repo: { root: '/main', name: 'main', branch: 'feature', isWorktree: true, worktreeRoot: '/worktree' } }
const input = { udid: UDID, task: 'check empty state', originalName: 'iPhone 17', via: 'simslim' }
const directories: string[] = []
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))) })

describe('SimPoolRegistry', () => {
  it('shares one host-wide path, rereads across instances and persists idempotently and privately', async () => {
    vi.stubEnv('COMMANDO_SIM_POOL_PATH', undefined)
    expect(defaultSimPoolStatePath()).toMatch(/\.commando\/sim-pool.json$/)
    const directory = await mkdtemp(join(tmpdir(), 'commando-sim-pool-'))
    directories.push(directory)
    const statePath = join(directory, 'pool.json')
    vi.stubEnv('COMMANDO_SIM_POOL_PATH', statePath)
    expect(defaultSimPoolStatePath()).toBe(statePath)
    const first = new SimPoolRegistry({ statePath, now: () => 123 })
    const second = new SimPoolRegistry({ statePath, now: () => 456 })
    const a = { udid: UDID, name: 'Commando Pool 1', created: false, projects: [] }
    const b = { udid: OTHER, name: 'Commando Pool 2', created: true, projects: [] }
    expect(first.list()).toEqual([])
    first.add(a)
    expect(second.list()).toEqual([{ ...a, addedAt: 123 }])
    second.add(b)
    expect(first.add({ ...a, created: true })).toEqual({ ...a, addedAt: 123 })
    expect(first.list()).toEqual([{ ...a, addedAt: 123 }, { ...b, addedAt: 456 }])
    expect((await stat(statePath)).mode & 0o777).toBe(0o600)
    second.remove(UDID)
    expect(first.list()).toEqual([{ ...b, addedAt: 456 }])
    expect(() => first.add({ ...a, name: b.name })).toThrow('already in use')
    expect(() => first.add({ ...a, created: 'yes' })).toThrow('boolean')
    expect(() => first.add({ ...a, udid: 'bad' })).toThrow('UUID')
    expect(() => first.add({ ...a, name: 'Personal iPhone' })).toThrow('Commando Pool')
    expect(() => first.remove('bad')).toThrow('UUID')
    expect(JSON.parse(await readFile(statePath, 'utf8')).members).toEqual(first.list())
  })

  it('loads legacy members with no projects, validates pre-tags and sorts projects by most recent use', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'commando-pool-projects-'))
    directories.push(directory)
    const statePath = join(directory, 'pool.json')
    const legacy = { udid: UDID, name: 'Commando Pool 1', created: false, addedAt: 10 }
    await writeFile(statePath, JSON.stringify({ version: 1, members: [legacy] }))
    const pool = new SimPoolRegistry({ statePath })
    expect(pool.list()).toEqual([{ ...legacy, projects: [] }])
    const projects = [{ root: '/older', name: 'older', lastUsedAt: 1 }, { root: '/newer', name: 'newer', lastUsedAt: 2 }]
    pool.add({ udid: OTHER, name: 'Commando Pool 2', created: true, projects })
    expect(new SimPoolRegistry({ statePath }).list()[1].projects).toEqual([...projects].reverse())
    const copy = pool.list()
    copy[1].projects[0].name = 'mutated'
    expect(pool.list()[1].projects[0].name).toBe('newer')
    for (const invalid of [null, {}, Array.from({ length: 9 }, (_, i) => ({ root: `/repo${i}`, name: 'repo', lastUsedAt: 1 })),
      [{ ...projects[0], root: 'relative' }], [{ ...projects[0], root: '/bad\nroot' }], [projects[0], projects[0]],
      [{ ...projects[0], lastUsedAt: '1' }], [{ ...projects[0], name: 'bad\u0000name' }]]) {
      expect(() => pool.add({ ...legacy, projects: invalid })).toThrow('projects')
    }
  })

  it('recovers locks older than ten seconds, refuses fresh locks and leaves no lock or temp files', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'commando-pool-lock-'))
    directories.push(directory)
    const statePath = join(directory, 'pool.json')
    const lock = `${statePath}.lock`
    const pool = new SimPoolRegistry({ statePath })
    await mkdir(lock)
    expect(() => pool.add({ udid: UDID, name: 'Commando Pool 1', created: true })).toThrow('in progress')
    const old = new Date(Date.now() - 10_100)
    await utimes(lock, old, old)
    pool.add({ udid: UDID, name: 'Commando Pool 1', created: true })
    expect(pool.list()).toHaveLength(1)
    expect(await readdir(directory)).toEqual(['pool.json'])
    await mkdir(lock)
    await utimes(lock, old, old)
    pool.remove(UDID)
    expect(pool.list()).toEqual([])
    expect(await readdir(directory)).toEqual(['pool.json'])
  })

  it('fails closed on corrupt state rather than losing host-wide ownership', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'commando-sim-pool-bad-'))
    directories.push(directory)
    const statePath = join(directory, 'pool.json')
    await writeFile(statePath, 'broken')
    const registry = new SimPoolRegistry({ statePath })
    expect(() => registry.list()).toThrow()
    expect(() => registry.add({ udid: UDID, name: 'Commando Pool 1', created: true })).toThrow()
    expect(await readFile(statePath, 'utf8')).toBe('broken')
  })
})

describe('SimLeaseRegistry', () => {
  it('records the context main-checkout repo on pool leases, upserts names/times and keeps only eight recent projects', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'commando-lease-projects-'))
    directories.push(directory)
    const statePath = join(directory, 'pool.json')
    const pool = new SimPoolRegistry({ statePath })
    const otherDaemon = new SimPoolRegistry({ statePath })
    pool.add({ udid: UDID, name: 'Commando Pool 1', created: true })
    let now = 100
    const registry = new SimLeaseRegistry({ pool, now: () => now })
    registry.upsert('%1', target, { ...input, repo: { root: '/spoof', name: 'spoof' } })
    expect(otherDaemon.list()[0].projects).toEqual([{ root: '/main', name: 'main', lastUsedAt: 100 }])
    now = 200
    registry.touch('%1', { ...target, repo: { ...target.repo, name: 'Renamed repo' } }, {})
    expect(otherDaemon.list()[0].projects).toEqual([{ root: '/main', name: 'Renamed repo', lastUsedAt: 200 }])
    for (let i = 0; i < 8; i++) {
      now++
      registry.touch('%1', { ...target, repo: { ...target.repo, root: `/repo${i}`, name: `repo${i}` } }, {})
    }
    expect(otherDaemon.list()[0].projects.map((project) => project.root)).toEqual(Array.from({ length: 8 }, (_, i) => `/repo${7 - i}`))
    const before = await readFile(statePath, 'utf8')
    registry.touch('%1', { ...target, repo: undefined }, {})
    expect(await readFile(statePath, 'utf8')).toBe(before)
    registry.upsert('%2', target, { ...input, udid: OTHER })
    expect(await readFile(statePath, 'utf8')).toBe(before)
    expect(() => registry.upsert('%3', target, input)).toThrow('another pane')
    expect(await readFile(statePath, 'utf8')).toBe(before)
    now++
    registry.touch('%1', { ...target, repo: { ...target.repo, root: '/repo0', name: 'updated' } }, {})
    expect(otherDaemon.list()[0].projects).toHaveLength(8)
    expect(otherDaemon.list()[0].projects[0]).toEqual({ root: '/repo0', name: 'updated', lastUsedAt: now })
  })

  it('does not retain a lease after affinity persistence fails or tag a repo when lease persistence fails', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'commando-affinity-failure-'))
    directories.push(directory)
    const statePath = join(directory, 'leases.json')
    const pool = new SimPoolRegistry()
    pool.add({ udid: UDID, name: 'Commando Pool 1', created: true })
    const registry = new SimLeaseRegistry({ statePath, pool })
    const failure = vi.spyOn(pool, 'recordProject').mockImplementation(() => { throw new Error('affinity write failed') })
    expect(() => registry.upsert('%1', target, input)).toThrow('affinity write failed')
    expect(registry.list(() => true)).toEqual([])
    expect(JSON.parse(await readFile(statePath, 'utf8')).leases).toEqual([])
    expect(pool.list()[0].projects).toEqual([])
    failure.mockRestore()
    await rm(statePath)
    await mkdir(statePath)
    expect(() => registry.upsert('%1', target, input)).toThrow()
    expect(pool.list()[0].projects).toEqual([])
  })

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
    const endedState = JSON.parse(await readFile(statePath, 'utf8'))
    expect(endedState.leases).toEqual([])
    expect(endedState.ended).toEqual([expect.objectContaining({ udid: UDID, reason: 'pane-closed', endedAt: 101, originalName: input.originalName, ports: [], adopted: false })])
    expect(new SimLeaseRegistry({ statePath, now: () => 102 }).listEnded()).toEqual(replay.listEnded())
    await writeFile(statePath, 'broken')
    expect(new SimLeaseRegistry({ statePath }).list(() => true)).toEqual([])
  })

  it('validates metadata, preserves omitted PATCH fields and reloads legacy leases', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'commando-sim-metadata-'))
    directories.push(directory)
    const statePath = join(directory, 'state.json')
    const registry = new SimLeaseRegistry({ statePath })
    const ports = [{ name: 'metro', port: 1 }, { name: 'backend', port: 65535 }]
    registry.upsert('%1', target, { ...input, ports, branchOverride: 'feature/review' })
    registry.touch('%1', target, { task: 'new purpose' })
    expect(registry.list(() => true)[0]).toMatchObject({ task: 'new purpose', ports, branchOverride: 'feature/review' })
    expect(new SimLeaseRegistry({ statePath }).list(() => true)[0]).toMatchObject({ ports, branchOverride: 'feature/review' })
    for (const invalid of [null, {}, [{ name: 'Metro', port: 1 }], [{ name: 'a'.repeat(25), port: 1 }],
      [{ name: '', port: 1 }], [{ name: 'bad_name', port: 1 }], [{ name: 'metro', port: '8101' }],
      [{ name: 'metro', port: 0 }], [{ name: 'metro', port: 65536 }], [{ name: 'metro', port: 1.5 }],
      [ports[0], ports[0]], Array.from({ length: 7 }, (_, i) => ({ name: `port-${i}`, port: i + 1 }))]) {
      expect(() => registry.touch('%1', target, { ports: invalid })).toThrow('ports')
    }
    for (const branchOverride of [null, 123, 'a'.repeat(201), 'bad\nbranch', 'bad\u0085branch']) {
      expect(() => registry.touch('%1', target, { branchOverride })).toThrow('branchOverride')
    }
    registry.touch('%1', target, { ports: [] })
    expect(registry.list(() => true)[0]).toMatchObject({ ports: [], branchOverride: 'feature/review', task: 'new purpose' })
    const state = JSON.parse(await readFile(statePath, 'utf8'))
    delete state.leases[0].ports
    delete state.leases[0].branchOverride
    await writeFile(statePath, JSON.stringify(state))
    const legacy = new SimLeaseRegistry({ statePath }).list(() => true)[0]
    expect(legacy.ports).toEqual([])
    expect(legacy.branchOverride).toBeUndefined()
  })

  it('remembers releases, reuses the original name across adoption, and removes ended ownership', () => {
    const registry = new SimLeaseRegistry({ now: () => 123 })
    registry.upsert('%1', target, { ...input, ports: [{ name: 'metro', port: 8101 }] })
    registry.list(() => false)
    expect(registry.context('%2', target, () => true)).toMatchObject({ lease: null, heldUdids: [],
      ended: [{ udid: UDID, paneId: '%1', sessionName: target.sessionName, task: input.task,
        label: formatSimLabel(target.sessionName, input.task), originalName: input.originalName, repo: target.repo,
        ports: [{ name: 'metro', port: 8101 }], via: 'simslim', adopted: false, reason: 'pane-closed', endedAt: 123 }] })
    registry.upsert('%2', target, { ...input, originalName: 'Old session · old task', via: 'adopted', adopted: true })
    expect(registry.listEnded()).toEqual([])
    expect(registry.list(() => true)[0]).toMatchObject({ originalName: input.originalName, via: 'adopted', adopted: true })
    expect(() => registry.reserve('%2', UDID, true)).toThrow('before adopting')
    registry.touch('%2', target, { task: 'review' })
    registry.delete('%2')
    expect(registry.listEnded()).toEqual([expect.objectContaining({ reason: 'released', task: 'review', via: 'adopted', adopted: true })])
    registry.upsert('%3', target, input)
    expect(registry.listEnded()).toEqual([])
  })

  it('caps ended records at 50, prunes shut-down devices and expires records after seven days', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'commando-ended-leases-'))
    directories.push(directory)
    const statePath = join(directory, 'state.json')
    let now = 0
    const registry = new SimLeaseRegistry({ statePath, now: () => now })
    const udids = Array.from({ length: 52 }, (_, i) => `${i.toString(16).padStart(8, '0')}-1111-1111-1111-111111111111`.toUpperCase())
    for (const udid of udids) {
      now++
      registry.upsert('%1', target, { ...input, udid })
      registry.delete('%1')
    }
    expect(registry.listEnded()).toHaveLength(50)
    expect(registry.listEnded().map((entry) => entry.udid)).not.toContain(udids[0])
    registry.pruneEnded([udids[50].toLowerCase(), udids[51]])
    expect(registry.listEnded().map((entry) => entry.udid)).toEqual([udids[51], udids[50]])
    expect(JSON.parse(await readFile(statePath, 'utf8')).ended).toHaveLength(2)
    now = 51 + 7 * 24 * 60 * 60 * 1000
    registry.pruneEnded(udids)
    expect(registry.listEnded().map((entry) => entry.udid)).toEqual([udids[51]])
    now++
    registry.pruneEnded(udids)
    expect(JSON.parse(await readFile(statePath, 'utf8')).ended).toEqual([])
  })

  it('keeps ended history and active ownership unchanged if persistence fails', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'commando-ended-failure-'))
    directories.push(directory)
    const stateDirectory = join(directory, 'state')
    const statePath = join(stateDirectory, 'leases.json')
    const registry = new SimLeaseRegistry({ statePath, now: () => 100 })
    registry.upsert('%1', target, input)
    registry.delete('%1')
    const ended = registry.listEnded()
    await rm(stateDirectory, { recursive: true })
    await writeFile(stateDirectory, 'blocks state writes')
    expect(() => registry.upsert('%2', target, { ...input, via: 'adopted', adopted: true })).toThrow()
    expect(registry.list(() => true)).toEqual([])
    expect(registry.listEnded()).toEqual(ended)
    expect(() => registry.pruneEnded([])).toThrow()
    expect(registry.listEnded()).toEqual(ended)
  })

  it('loads legacy files and ignores malformed ended records or records overlapping active leases', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'commando-ended-load-'))
    directories.push(directory)
    const statePath = join(directory, 'state.json')
    const registry = new SimLeaseRegistry({ statePath, now: () => 100 })
    registry.upsert('%1', target, input)
    const state = JSON.parse(await readFile(statePath, 'utf8'))
    delete state.ended
    delete state.leases[0].adopted
    await writeFile(statePath, JSON.stringify(state))
    expect(new SimLeaseRegistry({ statePath, now: () => 101 }).listEnded()).toEqual([])
    registry.delete('%1')
    const ended = registry.listEnded()[0]
    state.ended = [ended, { ...ended, udid: OTHER, reason: 'invalid' }, { ...ended, udid: OTHER, endedAt: 'bad' },
      { ...ended, udid: OTHER, via: 'adopted', adopted: true }, { ...ended, udid: OTHER }]
    await writeFile(statePath, JSON.stringify(state))
    expect(new SimLeaseRegistry({ statePath, now: () => 101 }).listEnded()).toEqual([expect.objectContaining({ udid: OTHER, via: 'adopted', adopted: true })])
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
    const onChange = vi.fn()
    const api = new SimLeaseApi({ token, registry, paneExists, onChange, paneContext: async (pane) => paneExists(pane) ? target : null })
    return { api, registry, onChange }
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
    expect((await call(api, 'GET', '/context')).body).toEqual({ ...target, lease: null, ended: [], heldUdids: [], poolUdids: [] })
    const created = await call(api, 'PUT', '', { ...input, sessionName: 'spoofed', paneId: '%2', label: 'spoofed' })
    expect(created.status).toBe(200)
    expect((await call(api, 'POST', '/reservation', { udid: UDID, requireUnleased: true })).status).toBe(409)
    expect(created.body.lease).toMatchObject({ paneId: '%1', sessionName: target.sessionName, label: target.sessionName + ' · ' + input.task })
    const context = await call(api, 'GET', '/context', undefined, { 'x-commando-pane': '%2' })
    expect(context.body.heldUdids).toEqual([UDID])
    expect((await call(api, 'PUT', '', input, { 'x-commando-pane': '%2' })).status).toBe(409)
    expect((await call(api, 'PATCH', '', { task: 'ready: review' })).body.lease.label).toBe('Commando session · ready: review')
    expect((await call(api, 'GET')).body.leases).toHaveLength(1)
    expect((await call(api, 'DELETE', '', {})).status).toBe(200)
    expect((await call(api, 'GET')).body).toMatchObject({ leases: [], ended: [expect.objectContaining({ reason: 'released' })] })
    expect((await call(api, 'GET', '/context')).body.ended).toHaveLength(1)
  })

  it('authenticates pool CRUD, publishes context and refuses removal of leased or reserved members', async () => {
    const { api, registry } = setup()
    const member = { udid: UDID, name: 'Commando Pool 1', created: false }
    expect((await call(api, 'GET', '/pool', undefined, { authorization: 'Bearer wrong' })).status).toBe(401)
    expect((await call(api, 'PATCH', '/pool', member)).status).toBe(405)
    expect((await call(api, 'POST', '/pool', { ...member, created: 'yes' })).status).toBe(400)
    expect((await call(api, 'POST', '/pool', member)).body.member).toMatchObject(member)
    await call(api, 'POST', '/pool', member)
    expect((await call(api, 'GET', '/pool')).body.members).toHaveLength(1)
    expect((await call(api, 'GET', '/context')).body.poolUdids).toEqual([UDID])
    const operation = registry.reserve('%2', UDID)
    expect((await call(api, 'DELETE', '/pool', { udid: UDID })).status).toBe(409)
    registry.unlock('%2', operation)
    await call(api, 'PUT', '', input)
    expect(registry.list(() => true)[0].originalName).toBe(member.name)
    expect((await call(api, 'DELETE', '/pool', { udid: UDID })).status).toBe(409)
    await call(api, 'DELETE', '', {})
    expect((await call(api, 'DELETE', '/pool', { udid: UDID })).status).toBe(200)
    expect((await call(api, 'GET', '/pool')).body.members).toEqual([])
  })

  it('publishes lease, metadata updates, labels and release through the brief callback only after successful changes', async () => {
    const { api, onChange } = setup()
    await call(api, 'PUT', '', { ...input, ports: [{ name: 'metro', port: 8101 }], branchOverride: 'review' })
    const patched = await call(api, 'PATCH', '', { ports: [{ name: 'backend', port: 3001 }] })
    expect(patched.body.lease).toMatchObject({ task: input.task, branchOverride: 'review', ports: [{ name: 'backend', port: 3001 }] })
    await call(api, 'PATCH', '', { task: 'ready: review' })
    await call(api, 'DELETE', '', {})
    expect(onChange.mock.calls).toEqual([['%1'], ['%1'], ['%1'], ['%1']])
    await call(api, 'PATCH', '', {})
    await call(api, 'PUT', '', { ...input, ports: [{ name: 'metro', port: 0 }] })
    await call(api, 'POST', '/reservation', { udid: UDID })
    expect(onChange).toHaveBeenCalledTimes(4)
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
