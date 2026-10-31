import type { HostHealth } from '../shared/hosts.js'
import { HostRegistry, type StoredHost } from './hosts.js'
import { remoteRequest } from './hosts-transport.js'

export type HostProbe = (host: StoredHost, signal?: AbortSignal) => Promise<HostHealth>

function probeEndpoint(host: StoredHost, path: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const request = remoteRequest(new URL(path, host.baseUrl), { method: 'GET', headers: { Authorization: `Bearer ${host.token}` }, signal })
    const deadline = setTimeout(() => request.destroy(new Error('Probe timeout')), 5_000)
    deadline.unref()
    request.once('close', () => clearTimeout(deadline))
    request.once('error', reject)
    request.once('response', (response) => {
      const status = response.statusCode ?? 502
      if (status < 200 || status >= 300) {
        response.destroy()
        reject(new Error(status === 401 || status === 403 ? 'unauthorized' : 'offline'))
        return
      }
      // /api/snapshot is owner/device protected on older daemons as well. Its
      // potentially large body is unnecessary: only the authorization matters.
      if (path === '/api/snapshot') { response.destroy(); resolve({}); return }
      const chunks: Buffer[] = []
      let size = 0
      response.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > 64 * 1024) { response.destroy(); reject(new Error('Health response too large')) }
        else chunks.push(chunk)
      })
      response.once('error', reject)
      response.once('aborted', () => reject(new Error('Incomplete health response')))
      response.once('end', () => {
        try {
          const value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
          if (!value || value.ok !== true) throw new Error('Invalid health response')
          resolve(value)
        } catch { reject(new Error('Invalid health response')) }
      })
    })
    request.end()
  })
}

export const probeHost: HostProbe = async (host, signal) => {
  const start = Date.now()
  try {
    const health = await probeEndpoint(host, '/api/health', signal)
    await probeEndpoint(host, '/api/snapshot', signal)
    return { state: 'online', checkedAt: Date.now(), latencyMs: Date.now() - start,
      ...(typeof health.version === 'string' && health.version.length <= 100 ? { version: health.version } : {}) }
  } catch (error) {
    return { state: error instanceof Error && error.message === 'unauthorized' ? 'unauthorized' : 'offline', checkedAt: Date.now() }
  }
}

type Check = { health: HostHealth; failures: number; next: number }
export class HostsHealthMonitor {
  private readonly checks = new Map<string, Check>()
  private readonly controllers = new Set<AbortController>()
  private readonly pending = new Set<string>()
  private timer?: NodeJS.Timeout
  private stopped = false
  constructor(private readonly registry: HostRegistry, private readonly probe: HostProbe = probeHost, private readonly now = Date.now) {}

  health(id: string): HostHealth { return this.checks.get(id)?.health ?? { state: 'unknown', checkedAt: null } }
  record(host: StoredHost, health: HostHealth): void {
    const failures = health.state === 'online' ? 0 : (this.checks.get(host.id)?.failures ?? 0) + 1
    this.checks.set(host.id, { health, failures, next: this.now() + Math.min(30_000 * 2 ** Math.min(Math.max(0, failures - 1), 4), 300_000) })
  }
  remove(id: string): void { this.checks.delete(id) }
  async check(host: StoredHost): Promise<HostHealth> {
    const controller = new AbortController()
    if (this.stopped) controller.abort()
    this.controllers.add(controller)
    try { return await this.probe(host, controller.signal) }
    finally { this.controllers.delete(controller) }
  }
  async tick(): Promise<void> {
    if (this.stopped) return
    let hosts
    try { hosts = this.registry.list() } catch { return } // API exposes the storage error; keep daemon available.
    const ids = new Set(hosts.map((host) => host.id))
    for (const id of this.checks.keys()) if (!ids.has(id)) this.remove(id)
    await Promise.all(hosts.map(async ({ id }) => {
      if (this.pending.has(id) || (this.checks.get(id)?.next ?? 0) > this.now()) return
      this.pending.add(id)
      try {
        const host = this.registry.get(id)
        const health = await this.check(host)
        if (!this.stopped && this.registry.get(id).token === host.token) this.record(host, health)
      } catch { /* deleted, corrupt, or shutting down */ }
      finally { this.pending.delete(id) }
    }))
  }
  start(): void {
    if (this.timer || this.stopped) return
    void this.tick()
    this.timer = setInterval(() => { void this.tick() }, 5_000)
    this.timer.unref()
  }
  stop(): void {
    this.stopped = true
    clearInterval(this.timer)
    for (const controller of this.controllers) controller.abort()
    this.controllers.clear()
  }
}
