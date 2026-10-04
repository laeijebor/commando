import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, utimes, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SimOpenResult, SimPoolSummary, SimWallDevice, SimWallListing } from '../shared/protocol.js'
import type { SimLeaseRegistry } from './sim-leases.js'
import { SIM_BUNDLE_ID, SIM_NETWORK_PROFILES, SIM_ORIENTATIONS, SIM_PRIVACY_SERVICES, SIM_TEXT_SIZES, type SimAction, type SimActionResult, type SimApp } from '../shared/sim-actions.js'
import type { SimSourceResult } from '../shared/sim-inspector.js'
import { inspectorJson, parseSimComponents, parseSimElement } from './sim-inspector.js'

export type SimWallRunner = (command: string, args: string[], options?: { timeout: number; stdin?: string }) => Promise<string>
const run: SimWallRunner = (command, args, options) => new Promise((resolve, reject) => {
  const child = execFile(command, args, {
    timeout: options?.timeout ?? 120_000, killSignal: 'SIGKILL', maxBuffer: 8 * 1024 * 1024,
  }, (error, stdout, stderr) => error ? reject(Object.assign(error, { stdout, stderr })) : resolve(stdout))
  child.stdin?.on('error', reject)
  child.stdin?.end(options?.stdin)
})
const UDID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const CACHE_MS = 2_000
type Snapshot = { at: number; data: Buffer }

export function defaultSimSnapshotDirectory(port: number): string {
  return join(homedir(), '.commando', `sim-snapshots-${port}`)
}

class SimWallError extends Error {
  constructor(readonly status: number, message: string) { super(message) }
}

async function readAction(request: IncomingMessage): Promise<SimAction> {
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk)
    bytes += buffer.length
    if (bytes > 16 * 1024) throw new SimWallError(400, 'Action body is too large')
    chunks.push(buffer)
  }
  let body: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error()
    body = parsed as Record<string, unknown>
  } catch { throw new SimWallError(400, 'Action body must be a JSON object') }
  const only = (...keys: string[]) => Object.keys(body).every((key) => key === 'action' || keys.includes(key))
  let valid = false
  switch (body.action) {
    case 'privacy': valid = only('operation', 'service', 'bundleId')
      && ['grant', 'revoke', 'reset'].includes(body.operation as string)
      && SIM_PRIVACY_SERVICES.includes(body.service as typeof SIM_PRIVACY_SERVICES[number])
      && (body.bundleId === undefined ? body.operation === 'reset' : typeof body.bundleId === 'string' && SIM_BUNDLE_ID.test(body.bundleId)); break
    case 'orientation': valid = only('value') && SIM_ORIENTATIONS.includes(body.value as typeof SIM_ORIENTATIONS[number]); break
    case 'appearance': valid = only('value') && ['light', 'dark', 'toggle'].includes(body.value as string); break
    case 'shake': case 'heal': valid = only(); break
    case 'status-bar': valid = only('mode') && ['clean', 'clear'].includes(body.mode as string); break
    case 'open-url':
      if (only('url') && typeof body.url === 'string' && body.url.length > 0 && body.url.length <= 2048
        && /^[a-z][a-z\d+.-]*:/i.test(body.url) && !/[\x00-\x1f\x7f]/.test(body.url)) {
        try { valid = !!new URL(body.url).protocol } catch { /* Invalid URL. */ }
      }
      break
    case 'text-size': valid = (only('value') && SIM_TEXT_SIZES.includes(body.value as typeof SIM_TEXT_SIZES[number]))
      || (only('step') && (body.step === 1 || body.step === -1)); break
    case 'contrast': case 'reduce-motion': valid = only('enabled') && typeof body.enabled === 'boolean'; break
    case 'network': valid = only('profile') && SIM_NETWORK_PROFILES.includes(body.profile as typeof SIM_NETWORK_PROFILES[number]); break
  }
  if (!valid) throw new SimWallError(400, 'Invalid simulator action or parameters')
  return body as SimAction
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
  private listing?: { at: number; devices: SimWallDevice[]; pool?: SimPoolSummary }
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
      // `stale` tells the client a refresh is in flight, so it can ask again soon instead of waiting a full poll.
      const stale = this.now() - cached.at >= CACHE_MS
      if (stale) void this.refreshListing().catch(() => { /* Keep the last listing. */ })
      return { sims: cached.devices, listedAt: cached.at, stale, ...(cached.pool ? { pool: cached.pool } : {}) }
    }
    const sims = await this.refreshListing()
    return { sims, listedAt: this.listing!.at, stale: false, pool: this.listing!.pool }
  }

  private async readListing(): Promise<void> {
    if (!this.dependencies.cacheDirectory) return
    try {
      const stored = JSON.parse(await readFile(join(this.dependencies.cacheDirectory, 'listing.json'), 'utf8')) as SimWallListing
      if (Number.isFinite(stored.listedAt) && Array.isArray(stored.sims) && stored.sims.every((device) => UDID.test(device.udid))) {
        this.listing = { at: stored.listedAt, devices: stored.sims, pool: stored.pool }
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
    const members = this.dependencies.registry.pool.list()
    const poolUdids = new Set(members.map((entry) => entry.udid))
    const pool = { size: members.length, free: Object.entries(parsed.devices).filter(([runtime]) => runtime.includes('.iOS-'))
      .flatMap(([, entries]) => entries).filter((device) => poolUdids.has(device.udid.toUpperCase()) && device.state === 'Shutdown'
        && !this.dependencies.registry.isHeld(device.udid)).length }
    const devices: SimWallDevice[] = []
    for (const [runtimeId, entries] of Object.entries(parsed.devices)) {
      if (!runtimeId.includes('.iOS-')) continue
      for (const device of entries) {
        if (device.state !== 'Booted' || !UDID.test(device.udid)) continue
        const udid = device.udid.toUpperCase()
        const lease = leases.find((entry) => entry.udid === udid)
        const ended = !lease ? this.dependencies.registry.listEnded().find((entry) => entry.udid === udid) : undefined
        devices.push({ udid, name: device.name, ...(poolUdids.has(udid) ? { pool: true, poolProjects: members.find((member) => member.udid === udid)!.projects.map((project) => project.name) } : {}),
          runtime: `iOS ${runtimeId.split('.iOS-')[1].replaceAll('-', '.')}`,
          deviceModel: device.deviceTypeIdentifier?.split('.').at(-1)?.replaceAll('-', ' ') ?? lease?.originalName ?? device.name,
          slim: slimText === null ? 'unknown' : slimStates.get(udid) ?? 'unknown',
          lease: lease ? { sessionName: lease.sessionName, task: lease.task, label: lease.label,
            repo: lease.repo, paneId: lease.paneId, idle: lease.idle } : null,
          endedLease: ended ? { sessionName: ended.sessionName, task: ended.task, label: ended.label,
            repo: ended.repo, endedAt: ended.endedAt, reason: ended.reason } : null,
        })
      }
    }
    this.dependencies.registry.pruneEnded(devices.map((device) => device.udid))
    for (const key of this.images.keys()) if (!devices.some((device) => device.udid === key)) this.images.delete(key)
    const listedAt = this.now()
    this.listing = { at: listedAt, devices, pool }
    await this.persist(async (directory) => {
      await this.atomicWrite(directory, 'listing.json', JSON.stringify({ sims: devices, listedAt, stale: false, pool }))
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

  private async actionCommand(command: string, args: string[], timeout = 10_000, stdin?: string): Promise<string> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        this.runner(command, args, { timeout, ...(stdin !== undefined ? { stdin } : {}) }),
        new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new SimWallError(504, `Simulator command timed out after ${timeout / 1000} seconds`)), timeout) }),
      ])
    } catch (error) {
      if (error instanceof SimWallError) throw error
      const failure = error as { stderr?: string; stdout?: string; message?: string; killed?: boolean; code?: string }
      if (command === 'argent' && failure?.code === 'ENOENT') throw error
      if (failure?.killed || failure?.code === 'ETIMEDOUT') throw new SimWallError(504, `Simulator command timed out after ${timeout / 1000} seconds`)
      const detail = String(failure?.stderr || failure?.stdout || failure?.message || 'Command failed')
        .replace(/[\x00-\x1f\x7f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 500)
      throw new SimWallError(500, `${command} failed: ${detail}`)
    } finally { clearTimeout(timer) }
  }

  private async inspectSource(udid: string, x: number, y: number): Promise<SimSourceResult> {
    const lease = this.dependencies.registry.list(this.dependencies.paneExists).find((entry) => entry.udid === udid)
    const port = lease?.ports.find((entry) => entry.name === 'metro')?.port
    if (!port) return { ok: false, reason: 'no-metro-port' }
    let connecting = true
    try {
      const command = async (tool: string, coordinates: string[] = []) => {
        const raw = await this.actionCommand('argent', ['run', tool, '--device_id', udid, '--port', String(port), ...coordinates, '--json'], 15_000)
        let payload: unknown
        try { payload = inspectorJson(raw) } catch { return raw }
        if (payload && typeof payload === 'object') {
          const result = payload as { ok?: boolean; success?: boolean; isError?: boolean; error?: unknown; message?: unknown }
          if (result.ok === false || result.success === false || result.isError === true || result.error) {
            throw new Error(String(result.message ?? result.error ?? 'Argent command failed').slice(0, 300))
          }
        }
        return raw
      }
      await command('debugger-connect')
      connecting = false
      return { ok: true, ...parseSimComponents(await command('debugger-inspect-element', ['--x', String(x), '--y', String(y)])) }
    } catch (error) {
      if ((error as { code?: string })?.code === 'ENOENT') return { ok: false, reason: 'argent-missing' }
      const message = (error instanceof Error ? error.message : 'Source lookup failed').replace(/\s+/g, ' ').slice(0, 300)
      return { ok: false, reason: connecting || /not.connected|no.*(?:dev build|runtime|metro)|disconnected|connection.*(?:closed|refused)/i.test(message) ? 'not-connected' : 'failed', message, port }
    }
  }

  private async deviceAction(udid: string, body: SimAction): Promise<SimActionResult> {
    await this.booted(udid)
    const device = ['--udid', udid]
    const baguette = (args: string[]) => this.actionCommand('baguette', args)
    switch (body.action) {
      case 'privacy': await this.actionCommand('xcrun', ['simctl', 'privacy', udid, body.operation, body.service,
        ...(body.bundleId === undefined ? [] : [body.bundleId])]); break
      case 'orientation': await baguette(['orientation', ...device, body.value]); break
      case 'appearance': {
        let value = body.value
        if (value === 'toggle') {
          const current = (await baguette(['interface', 'appearance', ...device])).trim().toLowerCase()
          if (current !== 'light' && current !== 'dark') throw new SimWallError(500, 'Unable to read current appearance')
          value = current === 'light' ? 'dark' : 'light'
        }
        await baguette(['interface', 'appearance', ...device, value])
        return { ok: true, value }
      }
      case 'shake': case 'heal': await baguette([body.action, ...device]); break
      case 'status-bar': await baguette(['status-bar', body.mode === 'clean' ? 'override' : 'clear', ...device,
        ...(body.mode === 'clean' ? ['--time', '9:41', '--battery-state', 'charged', '--battery-level', '100',
          '--cellular-mode', 'active', '--cellular-bars', '4', '--wifi-mode', 'active', '--wifi-bars', '3', '--data-network', 'wifi'] : [])]); break
      case 'open-url': await baguette(['openurl', ...device, '--', body.url]); break
      case 'text-size': await baguette(['interface', 'text-size', ...device, body.value ?? (body.step === 1 ? 'increment' : 'decrement')]); break
      case 'contrast': await baguette(['interface', 'contrast', ...device, body.enabled ? 'enabled' : 'disabled']); break
      case 'reduce-motion': await this.actionCommand('xcrun', ['simctl', 'spawn', udid, 'defaults', 'write', 'com.apple.Accessibility', 'ReduceMotionEnabled', '-bool', body.enabled ? 'true' : 'false'])
        // A raw defaults write posts no accessibility notification, so running apps keep their old value.
        return { ok: true, warning: 'Relaunch the app to apply Reduce Motion; running apps keep the previous setting.' }
      case 'network':
        await baguette(['network', body.profile === 'off' ? 'clear' : 'set', ...device,
          ...(body.profile === 'off' ? [] : body.profile === 'offline' ? ['--offline']
            : body.profile === 'lossy' ? ['--latency', '200', '--loss', '10'] : ['--profile', body.profile])])
        return { ok: true, ...(body.profile !== 'off' ? { warning: 'Relaunch the app to apply network conditions; only URLSession traffic is affected.' } : {}) }
    }
    return { ok: true }
  }

  async handle(request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean> {
    if (url.pathname !== '/api/sims' && !url.pathname.startsWith('/api/sims/')) return false
    try {
      if (url.pathname === '/api/sims') {
        if (request.method !== 'GET') throw new SimWallError(405, 'Method not allowed')
        json(response, 200, await this.listPayload())
        return true
      }
      const match = /^\/api\/sims\/([^/]+)\/(snapshot\.jpg|slim|open|action|schemes|apps|inspect(?:\/source)?)$/.exec(url.pathname)
      if (!match) throw new SimWallError(404, 'Not found')
      if (!UDID.test(match[1])) throw new SimWallError(400, 'udid must be a simulator UUID')
      const udid = match[1].toUpperCase()
      const action = match[2]
      if (request.method !== (action === 'snapshot.jpg' || action === 'schemes' || action === 'apps' || action.startsWith('inspect') ? 'GET' : 'POST')) throw new SimWallError(405, 'Method not allowed')
      if (action.startsWith('inspect')) {
        const coordinate = (key: string) => {
          const values = url.searchParams.getAll(key), value = Number(values[0])
          if (values.length !== 1 || !values[0].trim() || !Number.isFinite(value) || value < 0 || value > 10_000) {
            throw new SimWallError(400, 'x and y must be finite device points from 0 to 10000')
          }
          return value
        }
        const x = coordinate('x'), y = coordinate('y')
        if (action === 'inspect/source') json(response, 200, await this.inspectSource(udid, x, y))
        else {
          await this.booted(udid)
          const raw = await this.actionCommand('baguette', ['describe-ui', '--udid', udid, '--x', String(x), '--y', String(y)], 5_000)
          json(response, 200, { ok: true, element: parseSimElement(raw) })
        }
      } else if (action === 'snapshot.jpg') {
        const { data, at } = await this.snapshot(udid)
        response.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store', 'Content-Length': data.length,
          'X-Commando-Snapshot-At': String(at), 'Access-Control-Expose-Headers': 'X-Commando-Snapshot-At' })
        response.end(data)
      } else if (action === 'action') {
        json(response, 200, await this.deviceAction(udid, await readAction(request)))
      } else if (action === 'apps') {
        await this.booted(udid)
        const plist = await this.actionCommand('xcrun', ['simctl', 'listapps', udid])
        const payload: unknown = JSON.parse(await this.actionCommand('plutil', ['-convert', 'json', '-o', '-', '-'], 10_000, plist))
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new SimWallError(500, 'Invalid installed apps response')
        const apps: SimApp[] = []
        for (const [bundleId, value] of Object.entries(payload)) {
          if (!SIM_BUNDLE_ID.test(bundleId) || !value || typeof value !== 'object' || Array.isArray(value)) continue
          const app = value as Record<string, unknown>
          if (app.ApplicationType !== 'User' && app.ApplicationType !== 'System') continue
          const name = [app.CFBundleDisplayName, app.CFBundleName].find((name) => typeof name === 'string' && name.trim())
          apps.push({ bundleId, name: typeof name === 'string' ? name : bundleId, type: app.ApplicationType === 'User' ? 'user' : 'system' })
        }
        apps.sort((a, b) => Number(a.type === 'system') - Number(b.type === 'system') || a.name.localeCompare(b.name) || a.bundleId.localeCompare(b.bundleId))
        json(response, 200, { apps })
      } else if (action === 'schemes') {
        await this.booted(udid)
        const payload: unknown = JSON.parse(await this.actionCommand('baguette', ['schemes', '--udid', udid, '--json']))
        const entries = Array.isArray(payload) ? payload : (payload as { schemes?: unknown } | null)?.schemes
        if (!Array.isArray(entries)) throw new SimWallError(500, 'Invalid URL schemes response from baguette')
        const schemes = entries.map((entry: unknown) => typeof entry === 'string' ? entry : (entry as { scheme?: unknown } | null)?.scheme)
        if (!schemes.every((scheme): scheme is string => typeof scheme === 'string' && scheme.length <= 256 && /^[a-z][a-z\d+.-]*$/i.test(scheme))) {
          throw new SimWallError(500, 'Invalid URL schemes response from baguette')
        }
        json(response, 200, { schemes: [...new Set(schemes)].sort() })
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
