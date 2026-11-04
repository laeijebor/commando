import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DeviceLockApi } from './device-lock-api.js'
import { releasedByUserMessage, removedByUserMessage } from './device-lock-api.js'
import { DeviceLockError, type DeviceLockRegistry, type DeviceResource } from './device-locks.js'

export type DeviceConnection = 'connected' | 'missing' | 'unknown'
type Run = (command: string, args: string[]) => Promise<string>
const run: Run = (command, args) => new Promise((resolve, reject) => {
  execFile(command, args, { timeout: 20_000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => error ? reject(error) : resolve(stdout))
})
const DISCOVERY_TTL_MS = 15_000

/** Which phones and emulators are plugged in, from `adb devices` and `devicectl` (slow, so cached). */
export class DeviceDiscovery {
  private android?: Set<string>
  private ios?: Map<string, boolean>
  private refreshedAt = 0
  private refreshing?: Promise<void>
  constructor(private readonly runner: Run = run, private readonly now: () => number = Date.now) {}

  /** Starts a refresh when the cache is old; never waits for it. */
  poke(): void {
    if (this.refreshing || this.now() - this.refreshedAt < DISCOVERY_TTL_MS) return
    this.refreshing = this.refresh().finally(() => { this.refreshing = undefined })
  }

  async refresh(): Promise<void> {
    const [android, ios] = await Promise.all([this.listAndroid().catch(() => undefined), this.listIos().catch(() => undefined)])
    this.android = android
    this.ios = ios
    this.refreshedAt = this.now()
  }

  connection(resource: DeviceResource): DeviceConnection {
    if (resource.kind === 'host') return 'connected'
    if (resource.kind === 'ios') {
      if (!this.ios || !resource.serial) return 'unknown'
      return this.ios.get(resource.serial.toUpperCase()) ? 'connected' : 'missing'
    }
    if (!this.android) return 'unknown'
    if (resource.kind === 'emulator') return [...this.android].some((serial) => serial.startsWith('emulator-') && (!resource.serial || serial === resource.serial)) ? 'connected' : 'missing'
    return resource.serial ? (this.android.has(resource.serial) ? 'connected' : 'missing') : 'unknown'
  }

  private async listAndroid(): Promise<Set<string>> {
    const output = await this.runner('adb', ['devices'])
    return new Set(output.split('\n').slice(1).map((line) => /^(\S+)\s+device\b/.exec(line)?.[1]).filter((serial): serial is string => Boolean(serial)))
  }

  private async listIos(): Promise<Map<string, boolean>> {
    const directory = await mkdtemp(join(tmpdir(), 'commando-devicectl-'))
    try {
      const path = join(directory, 'devices.json')
      await this.runner('xcrun', ['devicectl', 'list', 'devices', '--quiet', '--json-output', path])
      const parsed = JSON.parse(await readFile(path, 'utf8')) as { result?: { devices?: Array<{ identifier?: string; connectionProperties?: { tunnelState?: string; transportType?: string } }> } }
      return new Map((parsed.result?.devices ?? []).filter((device) => typeof device.identifier === 'string').map((device) => [device.identifier!.toUpperCase(),
        Boolean(device.connectionProperties?.transportType) && device.connectionProperties?.tunnelState !== 'unavailable']))
    } finally { await rm(directory, { recursive: true, force: true }) }
  }
}

function writeJson(response: ServerResponse, status: number, value: unknown): void {
  const body = `${JSON.stringify(value)}\n`
  response.writeHead(status, { 'Cache-Control': 'no-store', 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) })
  response.end(body)
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of request) {
    bytes += (chunk as Buffer).length
    if (bytes > 8 * 1024) throw new DeviceLockError(413, 'Request body is too large')
    chunks.push(Buffer.from(chunk))
  }
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('not an object')
    return value as Record<string, unknown>
  } catch { throw new DeviceLockError(400, 'Request body must be a JSON object') }
}

/**
 * The Devices view's routes under /api/devices. The daemon only reaches these after checking the
 * owner's credentials, so they can act on anyone's locks (reorder, pause, release, remove).
 */
export class DeviceWallApi {
  constructor(private readonly dependencies: {
    registry: DeviceLockRegistry
    locks: DeviceLockApi
    discovery: DeviceDiscovery
    /** When the pane's agent last went idle, or undefined while it works. */
    idleSince: (paneId: string) => number | undefined
    message: (paneId: string, text: string) => Promise<unknown>
  }) {}

  async handle(request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean> {
    const path = url.pathname
    if (path !== '/api/devices' && !path.startsWith('/api/devices/')) return false
    try {
      const { registry, locks } = this.dependencies
      if (path === '/api/devices' && request.method === 'GET') { writeJson(response, 200, this.view()); return true }
      const resourceAction = /^\/api\/devices\/([a-z][a-z0-9-]{0,31})\/(pause|resume|release)$/.exec(path)
      const queueAction = /^\/api\/devices\/queue\/([0-9a-f-]{36})(\/move)?$/.exec(path)
      if (resourceAction && request.method === 'POST') {
        const [, id, action] = resourceAction
        if (action === 'release') {
          const resource = registry.resource(id)
          for (const holder of registry.forceRelease(id, await locks.busyCheck())) this.send(holder.paneId, releasedByUserMessage(holder, resource!))
        } else registry.setPaused(id, action === 'pause', await locks.busyCheck())
      } else if (queueAction && queueAction[2] && request.method === 'POST') {
        const body = await readJson(request)
        registry.reorder(queueAction[1], typeof body.before === 'string' ? body.before : undefined)
      } else if (queueAction && !queueAction[2] && request.method === 'DELETE') {
        const removed = registry.remove(queueAction[1], await locks.busyCheck())
        const resource = registry.resource(removed.offer?.resourceId ?? removed.resourceIds[0])
        if (resource && removed.mode === 'notify') this.send(removed.paneId, removedByUserMessage(removed, resource))
      } else throw new DeviceLockError(404, 'Not found')
      writeJson(response, 200, this.view())
    } catch (error) {
      if (!(error instanceof DeviceLockError)) console.warn('[devices] request failed', error)
      writeJson(response, error instanceof DeviceLockError ? error.status : 500, { error: error instanceof DeviceLockError ? error.message : 'Device request failed' })
    }
    return true
  }

  view() {
    const { discovery, locks, idleSince } = this.dependencies
    discovery.poke()
    const view = locks.view()
    const panes = new Set([...view.holders, ...view.queue].map((entry) => entry.paneId))
    return { ...view, now: Date.now(),
      connections: Object.fromEntries(view.resources.map((resource) => [resource.id, discovery.connection(resource)])),
      idleSince: Object.fromEntries([...panes].map((paneId) => [paneId, idleSince(paneId)]).filter(([, since]) => since !== undefined)) }
  }

  private send(paneId: string, text: string): void {
    void this.dependencies.message(paneId, text).catch((error) => console.warn('[devices] could not message', paneId, error))
  }
}
