import { readdirSync, readFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { SimReleaseRunner } from './sim-lease-release.js'

/** A pool simulator left booted without a lease this long is shut down. */
export const POOL_IDLE_SHUTDOWN_MS = 10 * 60 * 1_000
export const POOL_REAP_INTERVAL_MS = 60 * 1_000

export type SimPoolReaperDependencies = {
  /** UDIDs of the shared simulator pool. */
  poolUdids: () => string[]
  /** True while this daemon leases, reserves, or is releasing the device. */
  isHeld: (udid: string) => boolean
  /** Devices leased by other Commando daemons (other ports keep their own lease files). */
  otherLeasedUdids: () => Set<string>
  runner: SimReleaseRunner
  now?: () => number
  idleMs?: number
  log?: (message: string) => void
}

/**
 * Shuts down pool simulators that stay booted with nobody leasing them, such as a device
 * Simulator.app re-booted at login or one left behind by a daemon that crashed mid-release.
 */
export class SimPoolReaper {
  private readonly idleSince = new Map<string, number>()
  private sweeping = false

  constructor(private readonly dependencies: SimPoolReaperDependencies) {}

  /** Returns the UDIDs it shut down. */
  async sweep(): Promise<string[]> {
    if (this.sweeping) return []
    this.sweeping = true
    try {
      const { poolUdids, isHeld, otherLeasedUdids, runner, now = Date.now, idleMs = POOL_IDLE_SHUTDOWN_MS, log } = this.dependencies
      const pool = new Set(poolUdids().map((udid) => udid.toUpperCase()))
      const listing = JSON.parse(await runner('xcrun', ['simctl', 'list', 'devices', 'booted', '--json'])) as
        { devices?: Record<string, Array<{ udid: string; state: string }>> }
      const booted = Object.values(listing.devices ?? {}).flat()
        .filter((device) => device.state === 'Booted').map((device) => device.udid.toUpperCase())
      const elsewhere = otherLeasedUdids()
      const idle = booted.filter((udid) => pool.has(udid) && !isHeld(udid) && !elsewhere.has(udid))
      for (const udid of this.idleSince.keys()) if (!idle.includes(udid)) this.idleSince.delete(udid)
      const due: string[] = []
      for (const udid of idle) {
        const since = this.idleSince.get(udid)
        if (since === undefined) this.idleSince.set(udid, now())
        else if (now() - since >= idleMs) due.push(udid)
      }
      const stopped: string[] = []
      for (const udid of due) {
        // A lease may have started while earlier shutdowns ran.
        if (isHeld(udid)) continue
        try {
          await runner('xcrun', ['simctl', 'shutdown', udid])
          this.idleSince.delete(udid)
          stopped.push(udid)
          log?.(`shut down unleased pool simulator ${udid}`)
        } catch (error) { log?.(`could not shut down unleased pool simulator ${udid}: ${(error as Error)?.message ?? error}`) }
      }
      return stopped
    } finally { this.sweeping = false }
  }
}

/** Reads the leases recorded by every other daemon's `sim-leases-<port>.json` beside this one. */
export function leasedUdidsInSiblingFiles(ownStatePath: string): Set<string> {
  const directory = dirname(ownStatePath)
  const udids = new Set<string>()
  let names: string[]
  try { names = readdirSync(directory) } catch { return udids }
  for (const name of names) {
    if (!/^sim-leases-\d+\.json$/.test(name) || name === basename(ownStatePath)) continue
    try {
      const parsed = JSON.parse(readFileSync(join(directory, name), 'utf8')) as { leases?: Array<{ udid?: unknown }> }
      for (const lease of parsed.leases ?? []) if (typeof lease.udid === 'string') udids.add(lease.udid.toUpperCase())
    } catch { /* A file mid-write or from another version leases nothing we can read. */ }
  }
  return udids
}

/** Only the default daemon reaps by default, so test daemons never shut down devices they cannot see leased. */
export function simPoolReaperEnabled(env: NodeJS.ProcessEnv, port: number, defaultPort: number): boolean {
  const setting = env.COMMANDO_SIM_POOL_REAPER?.toLowerCase()
  if (setting === 'on') return true
  if (setting === 'off') return false
  return port === defaultPort
}
