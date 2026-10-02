import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { SimWallDevice } from '../shared/protocol.js'
import type { SimLeaseRegistry } from './sim-leases.js'

export type SimWallRunner = (command: string, args: string[]) => Promise<string>
const execute = promisify(execFile)
const run: SimWallRunner = async (command, args) => (await execute(command, args, {
  timeout: 120_000, maxBuffer: 8 * 1024 * 1024,
})).stdout
const UDID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const CACHE_MS = 2_000

class SimWallError extends Error {
  constructor(readonly status: number, message: string) { super(message) }
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  response.end(JSON.stringify(body))
}

export class SimWallApi {
  private readonly runner: SimWallRunner
  private readonly now: () => number
  private listing?: { at: number; devices: SimWallDevice[] }
  private listingFlight?: Promise<SimWallDevice[]>
  private readonly images = new Map<string, { at: number; data: Buffer }>()
  private readonly captures = new Map<string, Promise<Buffer>>()
  private readonly slimming = new Set<string>()
  private activeCaptures = 0
  private readonly captureQueue: Array<() => void> = []

  constructor(private readonly dependencies: {
    registry: SimLeaseRegistry
    paneExists: (paneId: string) => boolean
    runner?: SimWallRunner
    now?: () => number
  }) {
    this.runner = dependencies.runner ?? run
    this.now = dependencies.now ?? Date.now
  }

  async list(): Promise<SimWallDevice[]> {
    if (this.listing && this.now() - this.listing.at < CACHE_MS) return this.listing.devices
    if (this.listingFlight) return this.listingFlight
    const flight = this.loadListing()
    this.listingFlight = flight
    try { return await flight } finally { this.listingFlight = undefined }
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
    this.listing = { at: this.now(), devices }
    return devices
  }

  private async booted(udid: string): Promise<void> {
    if (!(await this.list()).some((device) => device.udid === udid)) throw new SimWallError(404, 'Simulator is not booted')
  }

  private async capture(udid: string): Promise<Buffer> {
    // A released slot transfers directly to the next waiter, keeping the cap at two.
    if (this.activeCaptures >= 2) await new Promise<void>((resolve) => this.captureQueue.push(resolve))
    else this.activeCaptures++
    let directory: string | undefined
    try {
      await this.booted(udid)
      directory = await mkdtemp(join(tmpdir(), 'commando-sim-wall-'))
      const path = join(directory, 'snapshot.jpg')
      await this.runner('xcrun', ['simctl', 'io', udid, 'screenshot', '--type=jpeg', path])
      const data = await readFile(path)
      this.images.set(udid, { at: this.now(), data })
      return data
    } finally {
      try { if (directory) await rm(directory, { recursive: true, force: true }) }
      finally {
        const next = this.captureQueue.shift()
        if (next) next()
        else this.activeCaptures--
      }
    }
  }

  private async snapshot(udid: string): Promise<Buffer> {
    await this.booted(udid)
    const cached = this.images.get(udid)
    if (cached && this.now() - cached.at < CACHE_MS) return cached.data
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
        json(response, 200, { sims: await this.list() })
        return true
      }
      const match = /^\/api\/sims\/([^/]+)\/(snapshot\.jpg|slim|open)$/.exec(url.pathname)
      if (!match) throw new SimWallError(404, 'Not found')
      if (!UDID.test(match[1])) throw new SimWallError(400, 'udid must be a simulator UUID')
      const udid = match[1].toUpperCase()
      const action = match[2]
      if (request.method !== (action === 'snapshot.jpg' ? 'GET' : 'POST')) throw new SimWallError(405, 'Method not allowed')
      if (action === 'snapshot.jpg') {
        const data = await this.snapshot(udid)
        response.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store', 'Content-Length': data.length })
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
        }
      } else {
        await this.booted(udid)
        await this.runner('open', ['-a', 'Simulator', '--args', '-CurrentDeviceUDID', udid])
        json(response, 200, { ok: true })
      }
    } catch (error) {
      json(response, error instanceof SimWallError ? error.status : 500, {
        error: error instanceof Error ? error.message : 'Simulator request failed',
      })
    }
    return true
  }
}
