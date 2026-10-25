import { execFile } from 'node:child_process'
import type { EndedSimLease } from './sim-leases.js'

export type SimReleaseRunner = (command: string, args: string[], cwd?: string) => Promise<string>
export const runSimTool: SimReleaseRunner = (command, args, cwd) => new Promise((resolve, reject) => {
  execFile(command, args, { cwd, timeout: 120_000, killSignal: 'SIGKILL', maxBuffer: 8 * 1024 * 1024 },
    (error, stdout, stderr) => error ? reject(Object.assign(error, { stdout, stderr })) : resolve(stdout))
})
const UNCLAIMED = /\b(?:not (?:currently )?claimed|unclaimed|nothing (?:is )?claimed|no (?:active )?claims?|already released)\b/i

/**
 * Returns a closed pane's simulator the way `commando-sim.mjs release` does:
 * restores its name, shuts it down unless it was adopted, and drops a simfleet claim.
 */
export async function releaseClosedSimLease(lease: EndedSimLease, runner: SimReleaseRunner = runSimTool): Promise<void> {
  const listing = JSON.parse(await runner('xcrun', ['simctl', 'list', 'devices', '--json'])) as { devices?: Record<string, Array<{ udid: string; state: string }>> }
  const device = Object.values(listing.devices ?? {}).flat().find((entry) => entry.udid.toUpperCase() === lease.udid)
  if (device) {
    await runner('xcrun', ['simctl', 'rename', lease.udid, lease.originalName])
    if (!lease.adopted && lease.via !== 'adopted' && device.state !== 'Shutdown') await runner('xcrun', ['simctl', 'shutdown', lease.udid])
  }
  if (lease.via === 'simfleet') {
    try { await runner('simfleet', ['release', lease.udid], lease.repo?.root) }
    catch (error) {
      const message = `${(error as Error)?.message ?? error}\n${(error as { stderr?: string })?.stderr ?? ''}`
      if (!UNCLAIMED.test(message)) throw error
    }
  }
}
