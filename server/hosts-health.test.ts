import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { HostRegistry } from './hosts.js'
import { HostsHealthMonitor, type HostProbe } from './hosts-health.js'

let directory: string | undefined
afterEach(async () => { vi.useRealTimers(); if (directory) await rm(directory, { recursive: true, force: true }) })

it('checks immediately, backs off on failures, resets after success and stops timers', async () => {
  vi.useFakeTimers()
  directory = await mkdtemp(join(tmpdir(), 'commando-hosts-health-'))
  const registry = new HostRegistry(join(directory, 'hosts.json'))
  const host = registry.add({ name: 'Hub', baseUrl: 'http://localhost', token: 'secret' })
  const probe = vi.fn<HostProbe>().mockImplementation(async () => ({ state: 'offline', checkedAt: Date.now() }))
  const monitor = new HostsHealthMonitor(registry, probe)
  expect(monitor.health(host.id)).toEqual({ state: 'unknown', checkedAt: null })
  monitor.start()
  await vi.advanceTimersByTimeAsync(0)
  expect(probe).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(25_000)
  expect(probe).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(5_000)
  expect(probe).toHaveBeenCalledTimes(2)
  await vi.advanceTimersByTimeAsync(55_000)
  expect(probe).toHaveBeenCalledTimes(2)
  probe.mockResolvedValue({ state: 'online', checkedAt: Date.now(), version: 'test' })
  await vi.advanceTimersByTimeAsync(5_000)
  expect(probe).toHaveBeenCalledTimes(3)
  await vi.advanceTimersByTimeAsync(30_000)
  expect(probe).toHaveBeenCalledTimes(4)
  expect(monitor.health(host.id).state).toBe('online')
  monitor.stop()
  await vi.advanceTimersByTimeAsync(600_000)
  expect(probe).toHaveBeenCalledTimes(4)
})

it('aborts an in-flight probe on shutdown and does not publish stale results', async () => {
  directory = await mkdtemp(join(tmpdir(), 'commando-hosts-health-'))
  const registry = new HostRegistry(join(directory, 'hosts.json'))
  const host = registry.add({ name: 'Hub', baseUrl: 'http://localhost', token: 'secret' })
  let finish!: () => void
  let signal: AbortSignal | undefined
  const probe: HostProbe = async (_host, abort) => {
    signal = abort
    await new Promise<void>((resolve) => { finish = resolve })
    return { state: 'online', checkedAt: 1 }
  }
  const monitor = new HostsHealthMonitor(registry, probe)
  const pending = monitor.tick()
  monitor.stop()
  expect(signal?.aborted).toBe(true)
  finish()
  await pending
  expect(monitor.health(host.id).state).toBe('unknown')
})

it('ignores the result of an old token probe after token replacement', async () => {
  directory = await mkdtemp(join(tmpdir(), 'commando-hosts-health-'))
  const registry = new HostRegistry(join(directory, 'hosts.json'))
  const host = registry.add({ name: 'Hub', baseUrl: 'http://localhost', token: 'secret' })
  let finish!: () => void
  const monitor = new HostsHealthMonitor(registry, async () => {
    await new Promise<void>((resolve) => { finish = resolve })
    return { state: 'unauthorized', checkedAt: 1 }
  })
  const pending = monitor.tick()
  const updated = registry.update(host.id, { token: 'new-secret' })
  monitor.record(updated, { state: 'online', checkedAt: 2 })
  finish(); await pending
  expect(monitor.health(host.id)).toEqual({ state: 'online', checkedAt: 2 })
  monitor.stop()
})
