import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, utimes, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { SimOpenResult, SimWallDevice, SimWallListing } from '../shared/protocol.js'
import type { SimLeaseRegistry } from './sim-leases.js'

export type SimWallRunner = (command: string, args: string[]) => Promise<string>
const execute = promisify(execFile)
const run: SimWallRunner = async (command, args) => (await execute(command, args, {
  timeout: 120_000, maxBuffer: 8 * 1024 * 1024,
})).stdout
const UDID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const CACHE_MS = 2_000
type Snapshot = { at: number; data: Buffer }

export function defaultSimSnapshotDirectory(port: number): string {
  return join(homedir(), '.commando', `sim-snapshots-${port}`)
}

class SimWallError extends Error {
  constructor(readonly status: number, message: string) { super(message) }
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  response.end(JSON.stringify(body))
}

const RAISE_SIMULATOR = `on run argv
  set deviceName to item 1 of argv
  if application "Simulator" is not running then return "not-running"
  tell application "Simulator" to activate
  try
    tell application "System Events"
      tell process "Simulator"
        set frontmost to true
        repeat with simulatorWindow in windows
          if (name of simulatorWindow) starts with deviceName then
            perform action "AXRaise" of simulatorWindow
            return "raised"
          end if
        end repeat
      end tell
    end tell
    return "not-raised" & linefeed & "Simulator activated, but no window matched this device."
  on error reason
    return "not-raised" & linefeed & "Simulator activated, but could not raise the device window: " & reason
  end try
end run`

export class SimWallApi {
  private readonly runner: SimWallRunner
  private readonly now: () => number
  private listing?: { at: number; devices: SimWallDevice[] }
  private listingFlight?: Promise<SimWallDevice[]>
  private listingRead?: Promise<void>
  private readonly images = new Map<string, Snapshot>()
  private readonly imageReads = new Map<string, Promise<Snapshot | undefined>>()
  private readonly captures = new Map<string, Promise<Snapshot>>()
  private diskWork: Promise<void> = Promise.resolve()
  private readonly slimming = new Set<string>()
  private activeCaptures = 0
  private readonly captureQueue: Array<() => void> = []

  constructor(private readonly dependencies: {
    registry: SimLeaseRegistry
    paneExists: (paneId: string) => boolean
    runner?: SimWallRunner
    now?: () => number
    cacheDirectory?: string
  }) {
    this.runner = dependencies.runner ?? run
    this.now = dependencies.now ?? Date.now
  }

  async list(): Promise<SimWallDevice[]> {
    return (await this.listPayload()).sims
  }

  private async listPayload(): Promise<SimWallListing> {
    this.listingRead ??= this.readListing()
    await this.listingRead
    const cached = this.listing
    if (cached) {
      if (this.now() - cached.at >= CACHE_MS) void this.refreshListing().catch(() => { /* Keep the last listing. */ })
      return { sims: cached.devices, listedAt: cached.at, stale: true }
    }
    const sims = await this.refreshListing()
    return { sims, listedAt: this.listing!.at, stale: false }
  }

  private async readListing(): Promise<void> {
    if (!this.dependencies.cacheDirectory) return
    try {
      const stored = JSON.parse(await readFile(join(this.dependencies.cacheDirectory, 'listing.json'), 'utf8')) as SimWallListing
      if (Number.isFinite(stored.listedAt) && Array.isArray(stored.sims) && stored.sims.every((device) => UDID.test(device.udid))) {
        this.listing = { at: stored.listedAt, devices: stored.sims }
      }
    } catch { /* Missing or damaged caches are rebuilt on demand. */ }
  }

  private async refreshListing(): Promise<SimWallDevice[]> {
    if (this.listingFlight) return this.listingFlight
    const flight = this.loadListing()
    this.listingFlight = flight
    try { return await flight } finally { this.listingFlight = undefined }
  }

  // Serialize writes and pruning so an in-flight capture cannot recreate a removed device's file.
  private persist(work: (directory: string) => Promise<void>): Promise<void> {
    const directory = this.dependencies.cacheDirectory
    if (!directory) return Promise.resolve()
    this.diskWork = this.diskWork.then(async () => {
      await mkdir(directory, { recursive: true, mode: 0o700 })
      await chmod(directory, 0o700)
      await work(directory)
    }).catch(() => { /* Disk caching is best effort; the memory cache still works. */ })
    return this.diskWork
  }

  private async atomicWrite(directory: string, name: string, data: Buffer | string, at?: number): Promise<void> {
    const temporary = join(directory, `${name}.tmp`)
    try {
      await writeFile(temporary, data, { mode: 0o600 })
      if (at !== undefined) await utimes(temporary, at / 1000, at / 1000)
      await rename(temporary, join(directory, name))
    } finally { await rm(temporary, { force: true }) }
  }

  private async prune(directory: string): Promise<void> {
    const files = (await readdir(directory)).filter((name) => UDID.test(name.replace(/\.jpg$/, '')) && name.endsWith('.jpg'))
    const booted = new Set(this.listing?.devices.map((device) => device.udid))
    const kept: Array<{ name: string; at: number }> = []
    for (const name of files) {
      if (this.listing && !booted.has(name.slice(0, -4))) await rm(join(directory, name), { force: true })
      else kept.push({ name, at: (await stat(join(directory, name))).mtimeMs })
    }
    kept.sort((a, b) => b.at - a.at)
    for (const { name } of kept.slice(50)) await rm(join(directory, name), { force: true })
  }

  private async loadListing(): Promise<SimWallDevice[]> {
    const [devicesJson, slimText] = await Promise.all([
      this.runner('xcrun', ['simctl', 'list', 'devices', '--json']),
      this.runner('simslim', ['list', '--booted']).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null
        throw error
      }),
    ])
    const slimStates = new Map<string, SimWallDevice['slim']>()
    for (const line of slimText?.split('\n') ?? []) {
      const match = /^\s*([0-9a-f-]{36})\s+/i.exec(line)
      const count = /\b(\d+)\/(\d+)\s+slim\b/i.exec(line)
      if (match) slimStates.set(match[1].toUpperCase(), count && Number(count[1]) > 0 && Number(count[1]) === Number(count[2]) ? 'slim' : 'unslimmed')
    }
    const leases = this.dependencies.registry.list(this.dependencies.paneExists)
    const parsed = JSON.parse(devicesJson) as { devices: Record<string, Array<{
      udid: string; name: string; state: string; deviceTypeIdentifier?: string
    }>> }
    const devices: SimWallDevice[] = []
    for (const [runtimeId, entries] of Object.entries(parsed.devices)) {
      if (!runtimeId.includes('.iOS-')) continue
      for (const device of entries) {
        if (device.state !== 'Booted' || !UDID.test(device.udid)) continue
        const udid = device.udid.toUpperCase()
        const lease = leases.find((entry) => entry.udid === udid)
        devices.push({ udid, name: device.name,
          runtime: `iOS ${runtimeId.split('.iOS-')[1].replaceAll('-', '.')}`,
          deviceModel: device.deviceTypeIdentifier?.split('.').at(-1)?.replaceAll('-', ' ') ?? lease?.originalName ?? device.name,
          slim: slimText === null ? 'unknown' : slimStates.get(udid) ?? 'unknown',
          lease: lease ? { sessionName: lease.sessionName, task: lease.task, label: lease.label,
            repo: lease.repo, paneId: lease.paneId, idle: lease.idle } : null,
        })
      }
    }
    for (const key of this.images.keys()) if (!devices.some((device) => device.udid === key)) this.images.delete(key)
    const listedAt = this.now()
    this.listing = { at: listedAt, devices }
    await this.persist(async (directory) => {
      await this.atomicWrite(directory, 'listing.json', JSON.stringify({ sims: devices, listedAt, stale: false }))
      await this.prune(directory)
    })
    return devices
  }

  private async booted(udid: string): Promise<void> {
    if (!(await this.list()).some((device) => device.udid === udid)) throw new SimWallError(404, 'Simulator is not booted')
  }

  private async openSimulator(udid: string): Promise<SimOpenResult> {
    // Look up the current name after any lease relabel, without the wall's listing cache.
    const listing = JSON.parse(await this.runner('xcrun', ['simctl', 'list', 'devices', '--json'])) as {
      devices: Record<string, Array<{ udid: string; name: string; state: string }>>
    }
    const device = Object.entries(listing.devices).filter(([runtime]) => runtime.includes('.iOS-'))
      .flatMap(([, devices]) => devices).find((entry) => entry.udid.toUpperCase() === udid)
    if (!device || device.state !== 'Booted') throw new SimWallError(404, 'Simulator is not booted')
    let result: string
    try {
      result = (await this.runner('osascript', ['-e', RAISE_SIMULATOR, '--', device.name])).trim()
    } catch (error) {
      // A script/runtime failure must still bring Simulator forward.
      await this.runner('open', ['-a', 'Simulator'])
      return { ok: true, raised: false, reason: `Simulator activated, but could not raise the device window: ${error instanceof Error ? error.message : String(error)}` }
    }
    if (result === 'not-running') {
      await this.runner('open', ['-a', 'Simulator', '--args', '-CurrentDeviceUDID', udid])
      return { ok: true }
    }
    if (result === 'raised') return { ok: true, raised: true }
    return { ok: true, raised: false, reason: result.replace(/^not-raised\s*/, '') || 'Simulator activated, but could not raise the device window.' }
  }

  private async capture(udid: string): Promise<Snapshot> {
    // A released slot transfers directly to the next waiter, keeping the cap at three.
    if (this.activeCaptures >= 3) await new Promise<void>((resolve) => this.captureQueue.push(resolve))
    else this.activeCaptures++
    let directory: string | undefined
    try {
      await this.booted(udid)
      directory = await mkdtemp(join(tmpdir(), 'commando-sim-wall-'))
      const path = join(directory, 'snapshot.jpg')
      await this.runner('xcrun', ['simctl', 'io', udid, 'screenshot', '--type=jpeg', path])
      const data = await readFile(path)
      const frame = { at: this.now(), data }
      if (this.listing?.devices.some((device) => device.udid === udid)) {
        this.images.set(udid, frame)
        await this.persist(async (directory) => {
          if (!this.images.has(udid)) return
          await this.atomicWrite(directory, `${udid}.jpg`, data, frame.at)
          await this.prune(directory)
        })
      }
      return frame
    } finally {
      try { if (directory) await rm(directory, { recursive: true, force: true }) }
      finally {
        const next = this.captureQueue.shift()
        if (next) next()
        else this.activeCaptures--
      }
    }
  }

  private async readSnapshot(udid: string): Promise<Snapshot | undefined> {
    if (!this.dependencies.cacheDirectory) return
    try {
      const path = join(this.dependencies.cacheDirectory, `${udid}.jpg`)
      const [data, metadata] = await Promise.all([readFile(path), stat(path)])
      const frame = { data, at: Math.round(metadata.mtimeMs) }
      if (this.listing && !this.listing.devices.some((device) => device.udid === udid)) return
      this.images.set(udid, frame)
      return frame
    } catch { return undefined }
  }

  private async snapshot(udid: string): Promise<Snapshot> {
    let cached = this.images.get(udid)
    if (!cached) {
      let read = this.imageReads.get(udid)
      if (!read) { read = this.readSnapshot(udid); this.imageReads.set(udid, read) }
      try { cached = await read } finally { this.imageReads.delete(udid) }
    }
    if (cached) {
      if (this.now() - cached.at >= CACHE_MS) void this.refreshSnapshot(udid).catch(() => { /* Keep the last frame. */ })
      return cached
    }
    return this.refreshSnapshot(udid)
  }

  private async refreshSnapshot(udid: string): Promise<Snapshot> {
    const existing = this.captures.get(udid)
    if (existing) return existing
    const flight = this.capture(udid)
    this.captures.set(udid, flight)
    try { return await flight } finally { this.captures.delete(udid) }
  }

  async handle(request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean> {
    if (url.pathname !== '/api/sims' && !url.pathname.startsWith('/api/sims/')) return false
    try {
      if (url.pathname === '/api/sims') {
        if (request.method !== 'GET') throw new SimWallError(405, 'Method not allowed')
        json(response, 200, await this.listPayload())
        return true
      }
      const match = /^\/api\/sims\/([^/]+)\/(snapshot\.jpg|slim|open)$/.exec(url.pathname)
      if (!match) throw new SimWallError(404, 'Not found')
      if (!UDID.test(match[1])) throw new SimWallError(400, 'udid must be a simulator UUID')
      const udid = match[1].toUpperCase()
      const action = match[2]
      if (request.method !== (action === 'snapshot.jpg' ? 'GET' : 'POST')) throw new SimWallError(405, 'Method not allowed')
      if (action === 'snapshot.jpg') {
        const { data, at } = await this.snapshot(udid)
        response.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store', 'Content-Length': data.length,
          'X-Commando-Snapshot-At': String(at), 'Access-Control-Expose-Headers': 'X-Commando-Snapshot-At' })
        response.end(data)
      } else if (action === 'slim') {
        if (this.slimming.has(udid)) throw new SimWallError(409, 'Slimming is already running')
        this.slimming.add(udid)
        try {
          await this.booted(udid)
          await this.runner('simslim', ['on', udid])
          json(response, 200, { ok: true })
        } finally {
          this.slimming.delete(udid)
          this.listing = undefined
          this.images.delete(udid)
          await this.persist(async (directory) => { await rm(join(directory, `${udid}.jpg`), { force: true }) })
        }
      } else {
        json(response, 200, await this.openSimulator(udid))
      }
    } catch (error) {
      json(response, error instanceof SimWallError ? error.status : 500, {
        error: error instanceof Error ? error.message : 'Simulator request failed',
      })
    }
    return true
  }
}
