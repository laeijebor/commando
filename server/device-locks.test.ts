import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DeviceLockRegistry, deviceLockClaimsByPane, OFFER_TIMEOUT_MS, UNDELIVERED_OFFER_TIMEOUT_MS, type QueueEntry } from './device-locks.js'

const directories: string[] = []
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })

function setup() {
  let now = 1_000
  const registry = new DeviceLockRegistry({ now: () => now })
  registry.addResource({ id: 'pixel', name: 'Pixel 5', kind: 'android', serial: '25121FDD4S00H7', release: 'Restore a2' })
  registry.addResource({ id: 'moto', name: 'moto e13', kind: 'android', serial: 'ZY22HCMSMZ' })
  registry.addResource({ id: 'heavy', name: 'Mac builds', kind: 'host', busyProcesses: ['xcodebuild', 'gradlew'] })
  const offers: QueueEntry[] = []
  registry.onOffered((entries) => offers.push(...entries))
  /** Offers made since the last call. */
  const offered = () => offers.splice(0)
  return { registry, offered, advance: (ms: number) => { now += ms } }
}
const live = { paneExists: () => true, pidAlive: () => true }
const a = { paneId: '%1', sessionName: 'mascot', as: 'MASCOT' }
const b = { paneId: '%2', sessionName: 'memleak', as: 'MEMLEAK' }
const c = { paneId: '%3', sessionName: 'lottie' }

describe('DeviceLockRegistry', () => {
  it('grants a free device straight away and queues the next request', () => {
    const { registry } = setup()
    expect(registry.lock({ ...a, request: 'pixel', task: 'Rive round' })).toMatchObject({ status: 'held', holder: { resourceId: 'pixel', as: 'MASCOT' }, resource: { serial: '25121FDD4S00H7' } })
    expect(registry.lock({ ...b, request: 'pixel', task: 'Allocations' })).toMatchObject({ status: 'queued', position: 1 })
    expect(registry.lock({ ...c, request: 'pixel', task: 'Redraw' })).toMatchObject({ status: 'queued', position: 2 })
  })

  it('is idempotent for holders and queued requests', () => {
    const { registry } = setup()
    registry.lock({ ...a, request: 'pixel', task: 'one' })
    expect(registry.lock({ ...a, request: 'pixel', task: 'again' }).status).toBe('held')
    const first = registry.lock({ ...b, request: 'pixel', task: 'x' })
    const second = registry.lock({ ...b, request: 'pixel', task: 'x' })
    expect(second.status === 'queued' && first.status === 'queued' && second.entry.id === first.entry.id).toBe(true)
    expect(registry.snapshot().queue).toHaveLength(1)
  })

  it('offers a released device to the next agent, who must claim it', () => {
    const { registry, offered } = setup()
    registry.lock({ ...a, request: 'pixel', task: 'one' })
    registry.lock({ ...b, request: 'pixel', task: 'two' })
    registry.release(a, 'pixel')
    expect(offered()).toMatchObject([{ as: 'MEMLEAK', offer: { resourceId: 'pixel' } }])
    expect(registry.holdersOf('pixel')).toEqual([])
    expect(registry.lock({ ...c, request: 'pixel', task: 'three' })).toMatchObject({ status: 'queued', position: 2 })
    expect(registry.claim(b, 'pixel')).toMatchObject({ status: 'held', holder: { as: 'MEMLEAK', task: 'two' } })
  })

  it('treats asking again for an offered lock as claiming it', () => {
    const { registry } = setup()
    registry.lock({ ...a, request: 'pixel', task: 'one' })
    registry.lock({ ...b, request: 'pixel', task: 'two' })
    registry.release(a, 'pixel')
    expect(registry.lock({ ...b, request: 'pixel', task: 'two' })).toMatchObject({ status: 'held' })
  })

  it('grants a blocking script without an offer', () => {
    const { registry } = setup()
    registry.lock({ ...a, request: 'heavy', task: 'export' })
    registry.lock({ ...c, request: 'heavy', task: 'pod install', mode: 'wait', pid: 4242 })
    registry.release(a, 'heavy')
    expect(registry.holdersOf('heavy')).toMatchObject([{ paneId: '%3', pid: 4242, task: 'pod install' }])
  })

  it('starts the claim window when the agent gets the message, then lets the next task go first', () => {
    const { registry, offered, advance } = setup()
    registry.lock({ ...a, request: 'pixel', task: 'one' })
    registry.lock({ ...b, request: 'pixel', task: 'two' })
    registry.lock({ ...c, request: 'pixel', task: 'three' })
    registry.release(a, 'pixel')
    const [offer] = offered()
    advance(10 * 60_000) // The agent is busy; the message has not been delivered yet.
    expect(registry.sweep(live).expired).toEqual([])
    registry.offerDelivered({ entryId: offer.id })
    advance(OFFER_TIMEOUT_MS - 1)
    expect(registry.sweep(live).expired).toEqual([])
    advance(1)
    expect(registry.sweep(live).expired).toMatchObject([{ as: 'MEMLEAK', dropped: false, skips: 1 }])
    expect(offered()).toMatchObject([{ paneId: '%3', offer: { resourceId: 'pixel' } }])
    expect(() => registry.claim(b, 'pixel')).toThrow(/Nothing is offered/)
    // MEMLEAK keeps its place behind the task that went ahead.
    expect(registry.snapshot().queue.map((entry) => entry.task)).toEqual(['three', 'two'])
  })

  it('does not hold a device for an agent that never sees the offer, and drops it after three missed turns', () => {
    const { registry, offered, advance } = setup()
    registry.lock({ ...a, request: 'pixel', task: 'one' })
    registry.lock({ ...b, request: 'pixel', task: 'two' })
    registry.release(a, 'pixel')
    for (let turn = 1; turn <= 3; turn++) {
      expect(offered()).toMatchObject([{ as: 'MEMLEAK' }])
      advance(UNDELIVERED_OFFER_TIMEOUT_MS)
      expect(registry.sweep(live).expired).toMatchObject([{ as: 'MEMLEAK', dropped: turn === 3 }])
    }
    expect(registry.snapshot().queue).toEqual([])
  })

  it('serves an any-device request from whichever device frees first', () => {
    const { registry, offered } = setup()
    registry.lock({ ...a, request: 'pixel', task: 'one' })
    registry.lock({ ...b, request: 'moto', task: 'two' })
    const queued = registry.lock({ ...c, request: 'any-android', task: 'smoke test' })
    expect(queued).toMatchObject({ status: 'queued', entry: { resourceIds: ['pixel', 'moto'] } })
    registry.release(b, 'moto')
    expect(offered()).toMatchObject([{ paneId: '%3', offer: { resourceId: 'moto' } }])
    // The Pixel freeing up later must not offer the same request twice.
    registry.release(a, 'pixel')
    expect(offered()).toEqual([])
    expect(registry.claim(c)).toMatchObject({ holder: { resourceId: 'moto' } })
  })

  it('takes a free device for an any-device request', () => {
    const { registry } = setup()
    registry.lock({ ...a, request: 'pixel', task: 'one' })
    expect(registry.lock({ ...c, request: 'any-android', task: 'smoke' })).toMatchObject({ status: 'held', resource: { id: 'moto' } })
  })

  it('ends locks and requests whose pane closed or process exited', () => {
    const { registry, offered } = setup()
    registry.lock({ ...a, request: 'pixel', task: 'one' })
    registry.lock({ ...c, request: 'heavy', task: 'build', mode: 'wait', pid: 77 })
    registry.lock({ ...b, request: 'pixel', task: 'two' })
    const events = registry.sweep({ paneExists: (pane) => pane !== '%1', pidAlive: (pid) => pid !== 77 })
    expect(events.ended).toMatchObject([{ as: 'MASCOT', reason: 'pane-closed' }, { pid: 77, reason: 'process-exited' }])
    expect(offered()).toMatchObject([{ as: 'MEMLEAK' }])
  })

  it('keeps a heavy job waiting while a build runs outside the lock', () => {
    const { registry } = setup()
    let building = true
    const busy = (resource: { busyProcesses?: string[] }) => building && resource.busyProcesses ? 'gradlew (pid 9)' : undefined
    expect(registry.lock({ ...c, request: 'heavy', task: 'pod install', mode: 'wait' }, busy)).toMatchObject({ status: 'queued' })
    building = false
    registry.sweep({ ...live, busy })
    expect(registry.holdersOf('heavy')).toMatchObject([{ paneId: '%3' }])
  })

  it('lets subagents in one pane queue separately by name', () => {
    const { registry } = setup()
    registry.lock({ paneId: '%1', sessionName: 's', as: 'ONE', request: 'pixel', task: 'x' })
    expect(registry.lock({ paneId: '%1', sessionName: 's', as: 'TWO', request: 'pixel', task: 'y' }).status).toBe('queued')
    expect(() => registry.release({ paneId: '%1', sessionName: 's', as: 'TWO' }, 'pixel')).toThrow(/don't hold/)
  })

  it('reorders the queue, pauses a device and force-releases a holder', () => {
    const { registry, offered } = setup()
    registry.lock({ ...a, request: 'pixel', task: 'one' })
    const two = registry.lock({ ...b, request: 'pixel', task: 'two' })
    const three = registry.lock({ ...c, request: 'pixel', task: 'three' })
    if (two.status !== 'queued' || three.status !== 'queued') throw new Error('expected queued')
    registry.reorder(three.entry.id, two.entry.id)
    expect(registry.snapshot().queue.map((entry) => entry.task)).toEqual(['three', 'two'])
    registry.setPaused('pixel', true)
    registry.forceRelease('pixel')
    expect(offered()).toEqual([])
    registry.setPaused('pixel', false)
    expect(offered()).toMatchObject([{ task: 'three' }])
  })

  it('announces offers made while serving someone else\'s request', () => {
    const { registry, offered } = setup()
    let building = true
    const busy = (resource: { busyProcesses?: string[] }) => building && resource.busyProcesses ? 'xcodebuild (pid 1)' : undefined
    registry.lock({ ...a, request: 'heavy', task: 'archive' }, busy)
    building = false
    // B locking the Pixel serves the whole queue, so A's Mac-builds offer must be announced too.
    registry.lock({ ...b, request: 'pixel', task: 'x' }, busy)
    expect(offered()).toMatchObject([{ as: 'MASCOT', offer: { resourceId: 'heavy' } }])
  })

  it('keeps a script and its agent apart even in the same pane', () => {
    const { registry } = setup()
    registry.lock({ paneId: '%1', sessionName: 's', request: 'pixel', task: 'agent' })
    const script = registry.lock({ paneId: '%1', sessionName: 's', pid: 4242, request: 'pixel', task: 'script', mode: 'wait' })
    expect(script.status).toBe('queued')
    expect(() => registry.release({ paneId: '%1', sessionName: 's', pid: 4242 }, 'pixel')).toThrow(/don't hold/)
    registry.release({ paneId: '%1', sessionName: 's' }, 'pixel')
    expect(registry.holdersOf('pixel')).toMatchObject([{ pid: 4242, task: 'script' }])
  })

  it('switches a queued request to blocking when asked again with --wait', () => {
    const { registry } = setup()
    registry.lock({ ...a, request: 'pixel', task: 'one' })
    registry.lock({ ...b, request: 'pixel', task: 'two' })
    expect(registry.lock({ ...b, request: 'pixel', task: 'two', mode: 'wait' })).toMatchObject({ status: 'queued', entry: { mode: 'wait' } })
    registry.release(a, 'pixel')
    expect(registry.holdersOf('pixel')).toMatchObject([{ as: 'MEMLEAK' }])
  })

  it('lets waiting any-device requests use a device added later', () => {
    const { registry } = setup()
    registry.lock({ ...a, request: 'pixel', task: 'one' })
    registry.lock({ ...b, request: 'moto', task: 'two' })
    registry.lock({ ...c, request: 'any-android', task: 'smoke', mode: 'wait' })
    registry.addResource({ id: 'pixel-6', name: 'Pixel 6', kind: 'android' })
    expect(registry.holdersOf('pixel-6')).toMatchObject([{ paneId: '%3', task: 'smoke' }])
  })

  it('withdraws a request by id, releasing it if it was granted meanwhile', () => {
    const { registry } = setup()
    registry.lock({ ...a, request: 'pixel', task: 'one' })
    const queued = registry.lock({ ...c, request: 'pixel', task: 'script', mode: 'wait', pid: 7 })
    if (queued.status !== 'queued') throw new Error('expected queued')
    registry.release(a, 'pixel')
    expect(registry.withdraw('%3', queued.entry.id)).toBe('released')
    expect(registry.holdersOf('pixel')).toEqual([])
    expect(registry.withdraw('%3', queued.entry.id)).toBe('gone')
  })

  it('lists each pane\'s locks for its worklog', () => {
    const { registry } = setup()
    registry.lock({ ...a, request: 'pixel', task: 'one' })
    registry.lock({ ...b, request: 'pixel', task: 'two' })
    registry.lock({ ...b, request: 'any-android', task: 'smoke' })
    registry.lock({ ...c, request: 'pixel', task: 'three' })
    registry.release(a, 'pixel')
    const claims = deviceLockClaimsByPane(registry)
    expect(claims.get('%1')).toBeUndefined()
    expect(claims.get('%2')).toEqual({ sessionName: 'memleak', claims: [
      { resourceId: 'moto', name: 'moto e13', state: 'held', task: 'smoke', as: 'MEMLEAK' },
      { resourceId: 'pixel', name: 'Pixel 5', state: 'offered', task: 'two', as: 'MEMLEAK' },
    ] })
    expect(claims.get('%3')?.claims).toEqual([{ resourceId: 'pixel', name: 'Pixel 5', state: 'queued', position: 2, task: 'three' }])
  })

  it('refuses to remove a resource that is in use', () => {
    const { registry } = setup()
    registry.lock({ ...a, request: 'pixel', task: 'one' })
    expect(() => registry.removeResource('pixel')).toThrow(/held or has a queue/)
    registry.removeResource('moto')
    expect(() => registry.lock({ ...b, request: 'moto', task: 'x' })).toThrow(/No device lock named moto/)
  })

  it('persists and reloads state', () => {
    const directory = mkdtempSync(join(tmpdir(), 'device-locks-'))
    directories.push(directory)
    const statePath = join(directory, 'locks.json')
    const first = new DeviceLockRegistry({ statePath })
    first.addResource({ id: 'pixel', name: 'Pixel 5', kind: 'android' })
    first.lock({ ...a, request: 'pixel', task: 'one' })
    first.lock({ ...b, request: 'pixel', task: 'two', estimateMs: 60_000 })
    first.setPaused('pixel', true)
    expect(JSON.parse(readFileSync(statePath, 'utf8')).version).toBe(1)
    const second = new DeviceLockRegistry({ statePath })
    expect(second.snapshot()).toEqual(first.snapshot())
  })

  it('rejects bad input', () => {
    const { registry } = setup()
    expect(() => registry.addResource({ id: 'any-android', name: 'x', kind: 'android' })).toThrow(/any-\* selector/)
    expect(() => registry.addResource({ id: 'x', name: 'x', kind: 'tablet' })).toThrow(/kind/)
    expect(() => registry.lock({ ...a, request: 'pixel', task: '' })).toThrow(/task is required/)
    expect(() => registry.lock({ ...a, request: 'any-ios', task: 'x' })).toThrow(/No ios devices/)
  })
})
