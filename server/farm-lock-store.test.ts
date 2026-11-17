import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { QueueEntry } from './device-locks.js'
import { FarmClient, FarmLockStore, type FarmChanges } from './farm-lock-store.js'

/** A scripted device farm: tests set its state; it records requests and answers lock calls with what the test queued up. */
function fakeFarm(me: string, resources: FarmChanges['snapshot']['resources']) {
  const calls: Array<{ method: string; path: string; body?: Record<string, unknown> }> = []
  const changes: FarmChanges = { version: 1, snapshot: { resources, holders: [], queue: [], paused: [], cleaning: [] }, positions: {}, health: {}, waitingFor: {},
    timing: { offerMs: 300_000, undeliveredOfferMs: 900_000, idleMs: 1_200_000, maxHoldMs: 14_400_000 }, engineers: [{ id: me, name: me === 'commando' ? 'Commando' : 'Sam' }, { id: 'sam', name: 'Sam' }] }
  const replies: Record<string, unknown> = {}
  const fetcher = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined
    calls.push({ method: init?.method ?? 'GET', path: url.pathname, ...(body ? { body } : {}) })
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
    if (url.pathname === '/api/state') return json({ me: { id: me, name: me, admin: true } })
    if (url.pathname === '/api/changes') return json(changes)
    return json(replies[url.pathname] ?? { ok: true })
  }) as typeof fetch
  return { calls, changes, replies, fetcher, bump: () => { changes.version++ } }
}

const holder = (engineer: string, session: string, resourceId: string, extra: Record<string, unknown> = {}) =>
  ({ engineer, session, resourceId, task: 'run', acquiredAt: 1, lastSeenAt: 1, entryId: `h-${resourceId}`, ...extra })
const entry = (engineer: string, session: string, id: string, resourceIds: string[], extra: Record<string, unknown> = {}) =>
  ({ engineer, session, id, request: resourceIds[0], resourceIds, task: 'wait', mode: 'notify' as const, enqueuedAt: 1, ...extra })

async function setup() {
  const local = fakeFarm('commando', [{ id: 'pixel', name: 'Pixel 5', kind: 'android', serial: 'P1' }, { id: 'heavy', name: 'Mac builds', kind: 'host', busyProcesses: ['xcodebuild'] }])
  const remote = fakeFarm('leo', [{ id: 'pixel', name: 'Shelf Pixel', kind: 'android', serial: 'R1' }, { id: 'iphone', name: 'Shelf iPhone', kind: 'ios', serial: 'I1' }])
  const store = new FarmLockStore([
    new FarmClient({ name: 'local', url: 'http://local', token: 't', fetcher: local.fetcher }),
    new FarmClient({ name: 'remote', url: 'http://remote', token: 't', fetcher: remote.fetcher }),
  ])
  await store.ready()
  const offers: QueueEntry[] = []
  store.onOffered((entries) => offers.push(...entries))
  return { store, local, remote, offers }
}

describe('FarmLockStore', () => {
  it('shows both farms as one queue: panes and scripts for Commando\'s own sessions, names for everyone else', async () => {
    const { store, local, remote } = await setup()
    local.changes.snapshot.holders = [holder('commando', 'cmd:%7:4242', 'heavy', { as: 'SWEEP', label: 'Battery' })]
    remote.changes.snapshot.holders = [holder('sam', 'air:%3', 'iphone', { label: 'jank' })]
    remote.changes.snapshot.queue = [entry('leo', 'cmd:%9', 'q1', ['iphone'], { label: 'Mascot' })]
    await store.ready()
    const snapshot = store.snapshot()
    // The remote Pixel shares the local one's id, so it stays hidden rather than ambiguous.
    expect(snapshot.resources.map((resource) => `${resource.id}:${resource.name}`)).toEqual(['pixel:Pixel 5', 'heavy:Mac builds', 'iphone:Shelf iPhone'])
    expect(snapshot.holders).toEqual([
      expect.objectContaining({ paneId: '%7', pid: 4242, as: 'SWEEP', sessionName: 'Battery', resourceId: 'heavy' }),
      expect.objectContaining({ paneId: '@sam', sessionName: 'Sam · jank', resourceId: 'iphone' }),
    ])
    expect(snapshot.queue).toEqual([expect.objectContaining({ paneId: '%9', sessionName: 'Mascot', id: 'q1' })])
  })

  it('sends a lock to the farm that has the device, as a session of Commando\'s engineer', async () => {
    const { store, local, remote } = await setup()
    remote.replies['/api/lock'] = { status: 'queued', entry: entry('leo', 'cmd:%9', 'q2', ['iphone']), position: 2 }
    const result = await store.lock({ paneId: '%9', sessionName: 'Mascot', pid: 777, request: 'iphone', task: 'jank', estimateMs: 60_000 })
    expect(result).toMatchObject({ status: 'queued', position: 2, entry: { paneId: '%9', id: 'q2' } })
    // A pid means something only on the farm's own host, so the remote farm doesn't get it.
    expect(remote.calls.find((call) => call.path === '/api/lock')?.body).toEqual({ session: 'cmd:%9:777', label: 'Mascot', request: 'iphone', task: 'jank', estimateMs: 60_000 })
    local.replies['/api/lock'] = { status: 'held', holder: holder('commando', 'cmd:%9:777', 'heavy'), resource: { id: 'heavy', name: 'Mac builds', kind: 'host' } }
    await store.lock({ paneId: '%9', sessionName: 'Mascot', pid: 777, request: 'heavy', task: 'export', mode: 'wait' })
    expect(local.calls.find((call) => call.path === '/api/lock')?.body).toMatchObject({ session: 'cmd:%9:777', pid: 777, mode: 'wait' })
    expect(() => store.lock({ paneId: '%9', sessionName: 'x', request: 'nope', task: 't' })).rejects.toThrow(/No device lock named nope/)
  })

  it('announces each new offer to Commando\'s panes once, and confirms delivery to the farm', async () => {
    const { store, local, offers } = await setup()
    local.changes.snapshot.queue = [entry('commando', 'cmd:%7', 'q1', ['pixel'], { offer: { resourceId: 'pixel', at: 50 } }), entry('sam', 'x', 'q9', ['pixel'], { offer: { resourceId: 'pixel', at: 51 } })]
    await store.ready()
    await store.ready()
    expect(offers.map((offer) => offer.id)).toEqual(['q1'])
    expect(store.offerMessage('q1', 50, 'm-1')).toBe(true)
    expect(store.entry('q1')?.offer?.messageId).toBe('m-1')
    store.offerDelivered({ messageId: 'm-1' })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(local.calls.filter((call) => call.path === '/api/heartbeat').at(-1)?.body).toMatchObject({ session: 'cmd:%7' })
  })

  it('reports offers the farm let lapse, and ends the holds of closed panes and exited scripts', async () => {
    const { store, local } = await setup()
    local.changes.snapshot.queue = [entry('commando', 'cmd:%7', 'q1', ['pixel'], { offer: { resourceId: 'pixel', at: 50 } })]
    await store.ready()
    local.changes.snapshot.queue = [entry('commando', 'cmd:%7', 'q1', ['pixel'], { skips: 1 })]
    local.changes.snapshot.holders = [holder('commando', 'cmd:%5', 'pixel'), holder('commando', 'cmd:%6:99', 'heavy')]
    await store.ready()
    const events = await store.sweep({ paneExists: (paneId) => paneId !== '%5', pidAlive: (pid) => pid !== 99 })
    expect(events.expired).toEqual([expect.objectContaining({ id: 'q1', dropped: false })])
    expect(events.ended.map((ended) => `${ended.paneId}:${ended.reason}`)).toEqual(['%5:pane-closed', '%6:process-exited'])
    expect(local.calls.filter((call) => call.path === '/api/release').map((call) => call.body)).toEqual([
      expect.objectContaining({ session: 'cmd:%5', request: 'pixel' }), expect.objectContaining({ session: 'cmd:%6:99', request: 'heavy' })])
  })

  it('keeps live holds alive with one heartbeat per farm', async () => {
    const { store, local } = await setup()
    local.changes.snapshot.holders = [holder('commando', 'cmd:%5', 'pixel'), holder('commando', 'cmd:%6', 'heavy')]
    await store.ready()
    await store.sweep({ paneExists: () => true, pidAlive: () => true })
    expect(local.calls.filter((call) => call.path === '/api/heartbeat').at(-1)?.body).toEqual({ owners: [{ session: 'cmd:%5' }, { session: 'cmd:%6' }] })
  })

  it('treats only a missed turn as a lapse: a pause or a device turning unhealthy takes an offer back silently', async () => {
    const { store, local } = await setup()
    local.changes.snapshot.queue = [entry('commando', 'cmd:%7', 'q1', ['pixel'], { offer: { resourceId: 'pixel', at: 50 } })]
    await store.ready()
    local.changes.snapshot.queue = [entry('commando', 'cmd:%7', 'q1', ['pixel'])]
    await store.ready()
    expect((await store.sweep({ paneExists: () => true, pidAlive: () => true })).expired).toEqual([])
  })

  it('says a farm isn\'t answering rather than that a device doesn\'t exist', async () => {
    const down = new FarmLockStore([new FarmClient({ name: 'local', url: 'http://local', token: 't', fetcher: (async () => { throw new Error('ECONNREFUSED') }) as typeof fetch })])
    await down.ready()
    await expect(down.lock({ paneId: '%1', sessionName: 'x', request: 'pixel', task: 't' })).rejects.toMatchObject({ status: 503, message: expect.stringMatching(/local device farm isn't answering/) })
  })

  it('uses this daemon\'s own session prefix, and doesn\'t announce an offer again after a restart', async () => {
    const local = fakeFarm('commando-4310', [{ id: 'pixel', name: 'Pixel 5', kind: 'android', serial: 'P1' }])
    local.changes.snapshot.queue = [entry('commando-4310', 'cmd4310:%7', 'q1', ['pixel'], { offer: { resourceId: 'pixel', at: 50 } }), entry('commando-4410', 'cmd4410:%7', 'q2', ['pixel'])]
    const statePath = join(mkdtempSync(join(tmpdir(), 'farm-offers-')), 'offers.json')
    const make = () => new FarmLockStore([new FarmClient({ name: 'local', url: 'http://local', token: 't', fetcher: local.fetcher })], { sessionPrefix: 'cmd4310:', statePath })
    const first = make(), offers: string[] = []
    first.onOffered((entries) => offers.push(...entries.map((offer) => offer.id)))
    await first.ready()
    expect(first.snapshot().queue.map((queued) => queued.paneId)).toEqual(['%7', '@commando-4410'])
    expect(offers).toEqual(['q1'])
    const second = make()
    second.onOffered((entries) => offers.push(...entries.map((offer) => offer.id)))
    await second.ready()
    expect(offers).toEqual(['q1'])
  })

  it('counts a write as in flight until the mirror shows its result', async () => {
    const { store, local } = await setup()
    local.replies['/api/lock'] = { status: 'held', holder: holder('commando', 'cmd:%9', 'pixel'), resource: { id: 'pixel', name: 'Pixel 5', kind: 'android' } }
    const counts: number[] = []
    const originalRefresh = FarmClient.prototype.refresh
    const client = (store as unknown as { clients: FarmClient[] }).clients[0]
    client.refresh = async function () { counts.push(store.pending); return originalRefresh.call(this) }
    await store.lock({ paneId: '%9', sessionName: 'x', request: 'pixel', task: 't' })
    expect(counts).toEqual([1])
    expect(store.pending).toBe(0)
  })
})
