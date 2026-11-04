import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readJson, releasedByUserMessage, removedByUserMessage, writeJson, type DeviceLockApi } from './device-lock-api.js'
import { DeviceLockError, type DeviceLockRegistry, type DeviceResource } from './device-locks.js'

/** `unknown`: the tool isn't available or hasn't answered yet; `no-serial`: the lock has no serial to look for. */
export type DeviceConnection = 'connected' | 'missing' | 'unknown' | 'no-serial'
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
      if (!resource.serial) return 'no-serial'
      if (!this.ios) return 'unknown'
      return this.ios.get(resource.serial.toUpperCase()) ? 'connected' : 'missing'
    }
    if (!this.android) return 'unknown'
    if (resource.kind === 'emulator') return [...this.android].some((serial) => serial.startsWith('emulator-') && (!resource.serial || serial === resource.serial)) ? 'connected' : 'missing'
    return resource.serial ? (this.android.has(resource.serial) ? 'connected' : 'missing') : 'no-serial'
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
      const parsed = JSON.parse(await readFile(path, 'utf8')) as { result?: { devices?: Array<{ identifier?: string; hardwareProperties?: { udid?: string }; connectionProperties?: { tunnelState?: string; transportType?: string } }> } }
      // A lock may name the CoreDevice identifier or the device UDID (what xcodebuild's -destination id= takes).
      return new Map((parsed.result?.devices ?? []).flatMap((device) => {
        const connected = Boolean(device.connectionProperties?.transportType) && device.connectionProperties?.tunnelState !== 'unavailable'
        return [device.identifier, device.hardwareProperties?.udid].filter((id): id is string => typeof id === 'string').map((id) => [id.toUpperCase(), connected] as const)
      }))
    } finally { await rm(directory, { recursive: true, force: true }) }
  }
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
        } else for (const entry of registry.setPaused(id, action === 'pause', await locks.busyCheck())) locks.withdrawOffer(entry)
      } else if (queueAction && queueAction[2] && request.method === 'POST') {
        const body = await readJson(request)
        registry.reorder(queueAction[1], typeof body.before === 'string' ? body.before : undefined)
      } else if (queueAction && !queueAction[2] && request.method === 'DELETE') {
        const removed = registry.remove(queueAction[1], await locks.busyCheck())
        locks.withdrawOffer(removed)
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
