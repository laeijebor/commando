import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { POOL_IDLE_SHUTDOWN_MS, SimPoolReaper, leasedUdidsInSiblingFiles, simPoolReaperEnabled } from './sim-pool-reaper.js'

const POOLED = 'ABCEADF3-B3D2-4BF9-8745-9EDEABF7CB54'
const LEASED = '114F9428-0C7C-4BF8-A764-5DA2C4888ACD'
const ELSEWHERE = 'B25D79EB-FABC-456B-94C5-26DA6EC46792'
const PERSONAL = '4A62BBCB-B988-4395-863D-598C185EA653'

function setup(options: { booted?: string[]; held?: Set<string>; elsewhere?: Set<string>; failShutdown?: boolean } = {}) {
  let clock = 1_000
  const held = options.held ?? new Set([LEASED])
  const booted = options.booted ?? [POOLED.toLowerCase(), LEASED, ELSEWHERE, PERSONAL]
  const runner = vi.fn(async (_command: string, args: string[]) => {
    if (args[1] === 'list') {
      return JSON.stringify({ devices: { 'com.apple.CoreSimulator.SimRuntime.iOS-26-5': booted.map((udid) => ({ udid, state: 'Booted' })) } })
    }
    if (args[1] === 'shutdown' && options.failShutdown) throw new Error('Unable to shutdown device')
    return ''
  })
  const log = vi.fn()
  const reaper = new SimPoolReaper({
    poolUdids: () => [POOLED, LEASED, ELSEWHERE],
    isHeld: (udid) => held.has(udid),
    otherLeasedUdids: () => options.elsewhere ?? new Set([ELSEWHERE]),
    runner,
    now: () => clock,
    log,
  })
  const shutdowns = () => runner.mock.calls.filter(([, args]) => args[1] === 'shutdown').map(([, args]) => args[2])
  return { reaper, runner, held, log, shutdowns, advance: (ms: number) => { clock += ms } }
}

describe('SimPoolReaper', () => {
  it('shuts down a pool simulator only after it stays booted and unleased for the idle period', async () => {
    const { reaper, advance, shutdowns, log } = setup()
    expect(await reaper.sweep()).toEqual([])
    advance(POOL_IDLE_SHUTDOWN_MS - 1)
    expect(await reaper.sweep()).toEqual([])
    advance(1)
    expect(await reaper.sweep()).toEqual([POOLED])
    expect(shutdowns()).toEqual([POOLED])
    expect(log).toHaveBeenCalledWith(`shut down unleased pool simulator ${POOLED}`)
  })

  it('never touches leased, reserved, other-daemon leased, or non-pool simulators', async () => {
    const { reaper, advance, shutdowns } = setup({ booted: [LEASED, ELSEWHERE, PERSONAL] })
    await reaper.sweep()
    advance(POOL_IDLE_SHUTDOWN_MS * 3)
    expect(await reaper.sweep()).toEqual([])
    expect(shutdowns()).toEqual([])
  })

  it('restarts the idle clock when a device is leased in between', async () => {
    const { reaper, advance, held, shutdowns } = setup()
    await reaper.sweep()
    advance(POOL_IDLE_SHUTDOWN_MS - 1)
    held.add(POOLED)
    await reaper.sweep()
    held.delete(POOLED)
    advance(POOL_IDLE_SHUTDOWN_MS - 1)
    await reaper.sweep()
    expect(shutdowns()).toEqual([])
    advance(POOL_IDLE_SHUTDOWN_MS)
    expect(await reaper.sweep()).toEqual([POOLED])
  })

  it('logs a failed shutdown and retries it on the next sweep', async () => {
    const { reaper, advance, shutdowns, log } = setup({ failShutdown: true })
    await reaper.sweep()
    advance(POOL_IDLE_SHUTDOWN_MS)
    expect(await reaper.sweep()).toEqual([])
    expect(log).toHaveBeenCalledWith(expect.stringContaining('could not shut down unleased pool simulator'))
    await reaper.sweep()
    expect(shutdowns()).toEqual([POOLED, POOLED])
  })
})

describe('leasedUdidsInSiblingFiles', () => {
  it('reads other daemons’ lease files, ignoring its own, unrelated, and unreadable files', () => {
    const directory = mkdtempSync(join(tmpdir(), 'commando-reaper-'))
    const own = join(directory, 'sim-leases-4310.json')
    writeFileSync(own, JSON.stringify({ version: 1, leases: [{ udid: POOLED }], ended: [] }))
    writeFileSync(join(directory, 'sim-leases-4410.json'), JSON.stringify({ version: 1, leases: [{ udid: ELSEWHERE.toLowerCase() }], ended: [{ udid: PERSONAL }] }))
    writeFileSync(join(directory, 'sim-leases-4411.json'), '{ partial')
    writeFileSync(join(directory, 'sim-pool.json'), JSON.stringify({ leases: [{ udid: LEASED }] }))
    expect(leasedUdidsInSiblingFiles(own)).toEqual(new Set([ELSEWHERE]))
    expect(leasedUdidsInSiblingFiles(join(directory, 'missing', 'sim-leases-4310.json'))).toEqual(new Set())
  })
})

describe('simPoolReaperEnabled', () => {
  it('runs on the default daemon unless overridden', () => {
    expect(simPoolReaperEnabled({}, 4310, 4310)).toBe(true)
    expect(simPoolReaperEnabled({}, 4410, 4310)).toBe(false)
    expect(simPoolReaperEnabled({ COMMANDO_SIM_POOL_REAPER: 'on' }, 4410, 4310)).toBe(true)
    expect(simPoolReaperEnabled({ COMMANDO_SIM_POOL_REAPER: 'OFF' }, 4310, 4310)).toBe(false)
  })
})
