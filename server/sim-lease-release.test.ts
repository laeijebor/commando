import { describe, expect, it, vi } from 'vitest'
import { releaseClosedSimLease, type SimReleaseRunner } from './sim-lease-release.js'
import type { EndedSimLease } from './sim-leases.js'

const UDID = '11111111-1111-1111-1111-111111111111'
const lease: EndedSimLease = { udid: UDID, sessionName: 'demo', task: 'check', label: 'demo · check', originalName: 'Commando Pool 1',
  repo: { root: '/repo', name: 'repo', branch: 'main', isWorktree: false }, paneId: '%1', via: 'simslim', adopted: false, ports: [], endedAt: 1, reason: 'pane-closed' }

function runner(state: string | null, simfleet?: Error) {
  return vi.fn<SimReleaseRunner>(async (command, args) => {
    if (command === 'simfleet' && simfleet) throw simfleet
    if (args[1] === 'list') return JSON.stringify({ devices: { 'com.apple.CoreSimulator.SimRuntime.iOS-26-0': state ? [{ udid: UDID.toLowerCase(), state }] : [] } })
    return ''
  })
}

describe('releaseClosedSimLease', () => {
  it('restores the name and shuts a booted leased device down', async () => {
    const run = runner('Booted')
    await releaseClosedSimLease(lease, run)
    expect(run.mock.calls.slice(1)).toEqual([['xcrun', ['simctl', 'rename', UDID, 'Commando Pool 1']], ['xcrun', ['simctl', 'shutdown', UDID]]])
  })

  it('leaves adopted and already shut-down devices running state alone, and skips missing devices', async () => {
    for (const [entry, state] of [[{ ...lease, via: 'adopted', adopted: true }, 'Booted'], [lease, 'Shutdown']] as const) {
      const run = runner(state)
      await releaseClosedSimLease(entry, run)
      expect(run.mock.calls.slice(1)).toEqual([['xcrun', ['simctl', 'rename', UDID, 'Commando Pool 1']]])
    }
    const missing = runner(null)
    await releaseClosedSimLease(lease, missing)
    expect(missing).toHaveBeenCalledOnce()
  })

  it('releases a simfleet claim from the repo, tolerating one that is already gone', async () => {
    const run = runner('Booted')
    await releaseClosedSimLease({ ...lease, via: 'simfleet' }, run)
    expect(run.mock.calls.at(-1)).toEqual(['simfleet', ['release', UDID], '/repo'])
    await expect(releaseClosedSimLease({ ...lease, via: 'simfleet' }, runner('Shutdown', new Error('device is not claimed')))).resolves.toBeUndefined()
    await expect(releaseClosedSimLease({ ...lease, via: 'simfleet' }, runner('Shutdown', new Error('simfleet exploded')))).rejects.toThrow('exploded')
  })
})
