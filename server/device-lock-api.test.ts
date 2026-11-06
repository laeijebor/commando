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

  it('withdraws a queued offer message when the agent cancels or claims first', async () => {
    const { api, cancelMessage } = setup()
    await call(api, 'POST', '/lock', { request: 'pixel', task: 'one' })
    await call(api, 'POST', '/lock', { request: 'pixel', task: 'two' }, { 'x-commando-pane': '%2' })
    await call(api, 'POST', '/lock', { request: 'pixel', task: 'three' }, { 'x-commando-pane': '%3' })
    await call(api, 'POST', '/release', { request: 'pixel' })
    await new Promise((done) => setTimeout(done))
    await call(api, 'POST', '/cancel', { request: 'pixel' }, { 'x-commando-pane': '%2' })
    expect(cancelMessage).toHaveBeenCalledWith('m1')
    await new Promise((done) => setTimeout(done))
    await call(api, 'POST', '/claim', { request: 'pixel' }, { 'x-commando-pane': '%3' })
    expect(cancelMessage).toHaveBeenCalledWith('m2')
    expect(cancelMessage).toHaveBeenCalledTimes(2)
  })

  it('withdraws a queued offer message when its requester\'s process exits', async () => {
    let alive = true
    const registry = new DeviceLockRegistry()
    registry.addResource({ id: 'pixel', name: 'Pixel 5', kind: 'android' })
    const cancelMessage = vi.fn(async (_id: string) => {})
    const api = new DeviceLockApi({ token, registry, processes: new BusyProcessWatch(async () => ''), message: async () => 'm1', cancelMessage, cli: 'cli',
      paneExists: () => true, sessionName: async () => 's', pidAlive: () => alive })
    await call(api, 'POST', '/lock', { request: 'pixel', task: 'one' })
    await call(api, 'POST', '/lock', { request: 'pixel', task: 'script', pid: 4242 }, { 'x-commando-pane': '%2' })
    await call(api, 'POST', '/release', { request: 'pixel' })
    await new Promise((done) => setTimeout(done))
    alive = false
    await api.sweep()
    expect(cancelMessage).toHaveBeenCalledWith('m1')
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
    const { api, registry } = setup('  17 1 /bin/bash ./gradlew assembleRelease\n  18 1 node commando-device.mjs lock heavy --task gradlew\n  19 1 tail -f xcodebuild.log\n  20 1 /usr/bin/grep -r gradlew .\n')
    registry.addResource({ id: 'heavy', name: 'Mac builds', kind: 'host', busyProcesses: ['xcodebuild', 'gradlew'] })
    const queued = await call(api, 'POST', '/lock', { request: 'heavy', task: 'pod install', mode: 'wait' })
    expect(queued.body).toMatchObject({ status: 'queued', waitingFor: 'gradlew (pid 17)' })
    expect((await call(api, 'GET')).body.waitingFor).toEqual({ heavy: 'gradlew (pid 17)' })
  })

  it('does not count the requesting script, the shell that started it, or its children as a build', async () => {
    // 100 = an agent's shell running the wrapper; 200 = the wrapper (the lock's --pid); 300 = its child; 400 = someone else's build.
    const ps = ['  100 1 /bin/zsh -c scripts/video-heavy.sh export npx expo export', '  200 100 bash scripts/video-heavy.sh export npx expo export',
      '  300 200 node commando-device.mjs lock heavy --wait --pid 200'].join('\n')
    const own = setup(ps)
    own.registry.addResource({ id: 'heavy', name: 'Mac builds', kind: 'host', busyProcesses: ['expo export'] })
    expect((await call(own.api, 'POST', '/lock', { request: 'heavy', task: 'export', mode: 'wait', pid: 200 })).body).toMatchObject({ status: 'held' })
    // The wrapper's own child running the export is still its own; a sibling started from the same shell is not.
    const child = setup(ps + '\n  350 200 node /repo/node_modules/.bin/expo export --platform ios')
    child.registry.addResource({ id: 'heavy', name: 'Mac builds', kind: 'host', busyProcesses: ['expo export'] })
    expect((await call(child.api, 'POST', '/lock', { request: 'heavy', task: 'export', mode: 'wait', pid: 200 })).body).toMatchObject({ status: 'held' })
    const sibling = setup(ps + '\n  450 100 node /repo/node_modules/.bin/expo export --platform android')
    sibling.registry.addResource({ id: 'heavy', name: 'Mac builds', kind: 'host', busyProcesses: ['expo export'] })
    expect((await call(sibling.api, 'POST', '/lock', { request: 'heavy', task: 'export', mode: 'wait', pid: 200 })).body).toMatchObject({ status: 'queued', waitingFor: 'expo export (pid 450)' })
    const other = setup(ps + '\n  400 1 node /repo/node_modules/.bin/expo export --platform ios')
    other.registry.addResource({ id: 'heavy', name: 'Mac builds', kind: 'host', busyProcesses: ['expo export'] })
    expect((await call(other.api, 'POST', '/lock', { request: 'heavy', task: 'export', mode: 'wait', pid: 200 })).body).toMatchObject({ status: 'queued', waitingFor: 'expo export (pid 400)' })
  })

  it('does not let a queued wrapper\'s command line hold up the request ahead of it', async () => {
    // 500 waits first (plain build script); 600 queued behind it with "xcodebuild" in its own arguments.
    let ps = ''
    const registry = new DeviceLockRegistry()
    registry.addResource({ id: 'heavy', name: 'Mac builds', kind: 'host', busyProcesses: ['xcodebuild'] })
    const api = new DeviceLockApi({ token, registry, processes: new BusyProcessWatch(async () => ps), message: async () => undefined, cli: 'cli',
      paneExists: () => true, sessionName: async () => 's', pidAlive: () => true })
    await call(api, 'POST', '/lock', { request: 'heavy', task: 'holder' })
    ps = ['  500 1 bash scripts/build-device.sh v7', '  600 1 bash scripts/sim-heavy.sh "v7: sim xcodebuild" bash sim-xcbuild.sh'].join('\n')
    await call(api, 'POST', '/lock', { request: 'heavy', task: 'build-device', mode: 'wait', pid: 500 }, { 'x-commando-pane': '%2' })
    await call(api, 'POST', '/lock', { request: 'heavy', task: 'sim', mode: 'wait', pid: 600 }, { 'x-commando-pane': '%3' })
    await call(api, 'POST', '/release', { request: 'heavy' })
    expect(registry.holdersOf('heavy')).toMatchObject([{ pid: 500 }])
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
    expect(offerMessage({ ...entry, pid: 4242 }, resource, 'cli')).toContain('cli claim pixel --as "MEMLEAK" --pid 4242')
    expect(offerMessage({ ...entry, pid: 4242 }, resource, 'cli')).toContain('cli release pixel --as "MEMLEAK" --pid 4242')
    expect(expiredMessage({ ...entry, pid: 4242, dropped: true }, resource, 'cli', 0)).toContain('cli lock any-android --as "MEMLEAK" --pid 4242 --task')
    expect(expiredMessage({ ...entry, dropped: true }, resource, 'cli', 0)).toContain('cli lock any-android --as "MEMLEAK" --task "Allocations"')
    expect(expiredMessage({ ...entry, dropped: false }, resource, 'cli', 2)).toContain('still queued (#2)')
  })
})
