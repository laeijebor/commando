import { mkdtempSync, rmSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Readable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { BusyProcessWatch, DeviceLockApi, expiredMessage, offerMessage } from './device-lock-api.js'
import { DeviceLockRegistry, OFFER_TIMEOUT_MS } from './device-locks.js'

const token = 't'.repeat(32)

function setup(ps = '') {
  let now = 1_000
  const registry = new DeviceLockRegistry({ now: () => now })
  registry.addResource({ id: 'pixel', name: 'Pixel 5', kind: 'android', release: 'restore a2' })
  let messages = 0
  const message = vi.fn(async (_paneId: string, _text: string): Promise<string | undefined> => `m${++messages}`)
  const cancelMessage = vi.fn(async (_id: string) => {})
  const processes = new BusyProcessWatch(async () => ps)
  const api = new DeviceLockApi({ token, registry, processes, message, cancelMessage, cli: 'node ~/.commando/hooks/commando-device.mjs',
    paneExists: (pane) => ['%1', '%2', '%3'].includes(pane), sessionName: async (pane) => `session ${pane}`, pidAlive: () => true })
  return { api, registry, message, cancelMessage, advance: (ms: number) => { now += ms } }
}

async function call(api: DeviceLockApi, method: string, suffix = '', body?: unknown, headers: Record<string, string> = {}) {
  const request = Readable.from(body === undefined ? [] : [JSON.stringify(body)]) as IncomingMessage
  request.method = method
  request.headers = { authorization: `Bearer ${token}`, 'x-commando-pane': '%1', 'content-type': 'application/json', ...headers }
  const response = new PassThrough() as unknown as ServerResponse
  const chunks: Buffer[] = []
  response.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
  response.setHeader = vi.fn().mockReturnValue(response)
  response.writeHead = vi.fn().mockReturnValue(response)
  const handled = await api.handle(request, response, new URL('http://localhost/api/device-locks' + suffix))
  return { handled, status: vi.mocked(response.writeHead).mock.calls[0]?.[0], body: chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null }
}

describe('DeviceLockApi', () => {
  it('ignores other paths and rejects a bad token', async () => {
    const { api } = setup()
    const response = new PassThrough() as unknown as ServerResponse
    expect(await api.handle({ headers: {} } as IncomingMessage, response, new URL('http://localhost/api/sim-leases'))).toBe(false)
    expect((await call(api, 'GET', '', undefined, { authorization: 'Bearer nope' })).status).toBe(401)
  })

  it('locks, queues behind the holder, and hands over with a pane message', async () => {
    const { api, message } = setup()
    const held = await call(api, 'POST', '/lock', { request: 'pixel', task: 'Rive round', as: 'MASCOT', paneId: '%9', sessionName: 'spoofed' })
    expect(held.body).toMatchObject({ status: 'held', holder: { paneId: '%1', sessionName: 'session %1', as: 'MASCOT' }, resource: { id: 'pixel' } })
    const queued = await call(api, 'POST', '/lock', { request: 'pixel', task: 'Allocations' }, { 'x-commando-pane': '%2' })
    expect(queued.body).toMatchObject({ status: 'queued', position: 1, holders: [{ as: 'MASCOT', task: 'Rive round' }] })
    expect((await call(api, 'POST', '/release', { request: 'pixel', as: 'MASCOT' })).body.released).toHaveLength(1)
    expect(message).toHaveBeenCalledWith('%2', expect.stringContaining('Pixel 5 is yours for "Allocations"'))
    expect(message.mock.calls[0][1]).toContain('Before releasing: restore a2.')
    expect((await call(api, 'POST', '/claim', { request: 'pixel' }, { 'x-commando-pane': '%2' })).body).toMatchObject({ status: 'held' })
  })

  it('starts the claim window when the offer message is delivered, and tells the agent when it lapses', async () => {
    const { api, message, advance } = setup()
    await call(api, 'POST', '/lock', { request: 'pixel', task: 'one' })
    await call(api, 'POST', '/lock', { request: 'pixel', task: 'two' }, { 'x-commando-pane': '%2' })
    await call(api, 'POST', '/lock', { request: 'pixel', task: 'three' }, { 'x-commando-pane': '%3' })
    await call(api, 'POST', '/release', { request: 'pixel' })
    await Promise.resolve()
    advance(OFFER_TIMEOUT_MS)
    await api.sweep()
    expect(message).toHaveBeenCalledTimes(1) // Not delivered yet, so the offer stands.
    api.messageSettled('m1', 'delivered')
    advance(OFFER_TIMEOUT_MS)
    await api.sweep()
    expect(message).toHaveBeenCalledWith('%2', expect.stringContaining('You are still queued (#2)'))
    expect(message).toHaveBeenCalledWith('%3', expect.stringContaining('Pixel 5 is yours for "three"'))
  })

  it('keeps the claim window working across a daemon restart', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'device-lock-api-'))
    try {
      let now = 1_000
      const statePath = join(directory, 'locks.json')
      const build = () => {
        const registry = new DeviceLockRegistry({ statePath, now: () => now })
        const message = vi.fn(async (_paneId: string, _text: string): Promise<string | undefined> => 'relay-1')
        const api = new DeviceLockApi({ token, registry, processes: new BusyProcessWatch(async () => ''), message, cli: 'cli',
          paneExists: () => true, sessionName: async () => 's', pidAlive: () => true })
        return { registry, api }
      }
      const first = build()
      first.registry.addResource({ id: 'pixel', name: 'Pixel 5', kind: 'android' })
      await call(first.api, 'POST', '/lock', { request: 'pixel', task: 'one' })
      await call(first.api, 'POST', '/lock', { request: 'pixel', task: 'two' }, { 'x-commando-pane': '%2' })
      await call(first.api, 'POST', '/release', { request: 'pixel' })
      await new Promise((resolve) => setTimeout(resolve))
      const second = build() // The daemon restarted; the relay is delivered afterwards.
      now += 14 * 60_000
      second.api.messageSettled('relay-1', 'delivered', now)
      now += 4 * 60_000
      await second.api.sweep()
      expect(second.registry.snapshot().queue[0].offer).toMatchObject({ messageId: 'relay-1', deliveredAt: 1_000 + 14 * 60_000 })
    } finally { rmSync(directory, { recursive: true, force: true }) }
  })

  it('withdraws an offer message that was still being queued when the offer went away', async () => {
    const { registry, cancelMessage } = setup()
    let resolve: (id: string) => void = () => {}
    const message = vi.fn(() => new Promise<string | undefined>((done) => { resolve = done }))
    const api = new DeviceLockApi({ token, registry, processes: new BusyProcessWatch(async () => ''), message, cancelMessage, cli: 'cli',
      paneExists: () => true, sessionName: async () => 's', pidAlive: () => true })
    await call(api, 'POST', '/lock', { request: 'pixel', task: 'one' })
    await call(api, 'POST', '/lock', { request: 'pixel', task: 'two' }, { 'x-commando-pane': '%2' })
    await call(api, 'POST', '/release', { request: 'pixel' })
    await call(api, 'POST', '/cancel', { request: 'pixel' }, { 'x-commando-pane': '%2' })
    resolve('late-relay')
    await new Promise((done) => setTimeout(done))
    expect(cancelMessage).toHaveBeenCalledWith('late-relay')
  })

  it('withdraws an undelivered offer message when the offer lapses', async () => {
    const { api, cancelMessage, advance } = setup()
    await call(api, 'POST', '/lock', { request: 'pixel', task: 'one' })
    await call(api, 'POST', '/lock', { request: 'pixel', task: 'two' }, { 'x-commando-pane': '%2' })
    await call(api, 'POST', '/release', { request: 'pixel' })
    await Promise.resolve()
    advance(15 * 60_000)
    await api.sweep()
    expect(cancelMessage).toHaveBeenCalledWith('m1')
  })

  it('cancels by request id, releasing a lock granted in the meantime', async () => {
    const { api, registry } = setup()
    await call(api, 'POST', '/lock', { request: 'pixel', task: 'one' })
    const queued = await call(api, 'POST', '/lock', { request: 'pixel', task: 'script', mode: 'wait', pid: 9 }, { 'x-commando-pane': '%2' })
    await call(api, 'POST', '/release', { request: 'pixel' })
    expect((await call(api, 'POST', '/cancel', { entryId: queued.body.entry.id }, { 'x-commando-pane': '%2' })).body).toEqual({ withdrawn: 'released' })
    expect(registry.holdersOf('pixel')).toEqual([])
  })

  it('wakes a blocked script when its request is granted', async () => {
    const { api } = setup()
    await call(api, 'POST', '/lock', { request: 'pixel', task: 'one' })
    const queued = await call(api, 'POST', '/lock', { request: 'pixel', task: 'sweep', mode: 'wait', pid: 4242 }, { 'x-commando-pane': '%2' })
    const waiting = call(api, 'GET', `/entry?id=${queued.body.entry.id}&wait=5`)
    await call(api, 'POST', '/release', { request: 'pixel' })
    expect((await waiting).body).toMatchObject({ status: 'held', holder: { paneId: '%2', pid: 4242 }, resource: { id: 'pixel' } })
  })

  it('reports a build running outside the heavy-job lock', async () => {
    const { api, registry } = setup('  17 /bin/bash ./gradlew assembleRelease\n  18 node commando-device.mjs lock heavy --task gradlew\n  19 tail -f xcodebuild.log\n  20 /usr/bin/grep -r gradlew .\n')
    registry.addResource({ id: 'heavy', name: 'Mac builds', kind: 'host', busyProcesses: ['xcodebuild', 'gradlew'] })
    const queued = await call(api, 'POST', '/lock', { request: 'heavy', task: 'pod install', mode: 'wait' })
    expect(queued.body).toMatchObject({ status: 'queued', waitingFor: 'gradlew (pid 17)' })
    expect((await call(api, 'GET')).body.waitingFor).toEqual({ heavy: 'gradlew (pid 17)' })
  })

  it('adds and removes resources', async () => {
    const { api } = setup()
    expect((await call(api, 'POST', '/resources', { id: 'moto', name: 'moto e13', kind: 'android', serial: 'ZY22HCMSMZ' })).body.resource).toMatchObject({ id: 'moto' })
    expect((await call(api, 'DELETE', '/resources', { id: 'moto' })).status).toBe(200)
    expect((await call(api, 'DELETE', '/resources', { id: 'moto' })).status).toBe(404)
  })

  it('formats messages with the owner name so subagents claim their own offer', () => {
    const entry = { id: 'e', paneId: '%1', sessionName: 's', as: 'MEMLEAK', request: 'any-android', resourceIds: ['pixel'], task: 'Allocations', mode: 'notify' as const, enqueuedAt: 0 }
    const resource = { id: 'pixel', name: 'Pixel 5', kind: 'android' as const }
    expect(offerMessage(entry, resource, 'cli')).toContain('cli claim pixel --as "MEMLEAK"')
    expect(expiredMessage({ ...entry, dropped: true }, resource, 'cli', 0)).toContain('cli lock any-android --as "MEMLEAK" --task "Allocations"')
    expect(expiredMessage({ ...entry, dropped: false }, resource, 'cli', 2)).toContain('still queued (#2)')
  })
})
