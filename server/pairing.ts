import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { execFile } from 'node:child_process'
import { Resolver } from 'node:dns/promises'
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import type { IncomingMessage } from 'node:http'
import { homedir, hostname } from 'node:os'
import { dirname, join } from 'node:path'
import type { PairedDevice, PairingClaimRequest, PairingClaimResponse } from '../shared/pairing.js'

export const PAIRING_TTL_MS = 120_000
const LAST_SEEN_INTERVAL_MS = 60_000
const MAX_DEVICES = 64
const hash = (value: string): Buffer => createHash('sha256').update(value).digest()

/** Hash first so timingSafeEqual always compares fixed-size values, even for malformed input. */
export function pairingSecretMatches(candidate: string, digest: Buffer): boolean {
  return timingSafeEqual(hash(candidate), digest)
}

/** The daemon's existing bearer transports, shared by owner and device auth. */
export function requestMatchesBearer(request: IncomingMessage, url: URL, matches: (token: string) => boolean): boolean {
  const check = (candidate: string | null): boolean => candidate !== null && candidate.length <= 1024 && matches(candidate)
  if (check(url.searchParams.get('token'))) return true
  const protocols = request.headers['sec-websocket-protocol']
  if (typeof protocols === 'string') {
    for (const protocol of protocols.split(',').map((entry) => entry.trim())) {
      if (!protocol.startsWith('commando-auth.')) continue
      try { if (check(decodeURIComponent(protocol.slice(14)))) return true } catch { /* malformed token */ }
    }
  }
  const match = /^Bearer\s+([^\s]+)$/i.exec(request.headers.authorization ?? '')
  return check(match?.[1] ?? null)
}

type StoredDevice = PairedDevice & { tokenHash: string }
export class PairingError extends Error {
  constructor(readonly status: number, message: string) { super(message) }
}

export function defaultPairingDevicesPath(port: number): string {
  return join(homedir(), '.commando', `paired-devices-${port}.json`)
}

export class PairingRegistry {
  private code: { digest: Buffer; expiresAt: number } | null = null
  private devices = new Map<string, StoredDevice>()
  private attempts = new Map<string, { count: number; resetAt: number }>()
  private connections = new Map<string, Set<() => void>>()
  private writes: Promise<unknown> = Promise.resolve()
  private readonly revocationListeners = new Set<(id: string) => Promise<unknown>>()

  constructor(
    readonly statePath = defaultPairingDevicesPath(4310),
    private readonly now: () => number = Date.now,
  ) {}

  async load(): Promise<void> {
    try {
      const state = JSON.parse(await readFile(this.statePath, 'utf8')) as { version: number; devices: StoredDevice[] }
      if (state.version !== 1 || !Array.isArray(state.devices)) throw new Error('Invalid paired device state')
      if (state.devices.length > MAX_DEVICES) throw new Error('Invalid paired device state')
      const devices = new Map<string, StoredDevice>()
      for (const device of state.devices) {
        if (!device || typeof device.id !== 'string' || !/^[a-f0-9]{64}$/.test(device.tokenHash) ||
          typeof device.deviceName !== 'string' || !['ios', 'android'].includes(device.platform) ||
          !Number.isFinite(device.createdAt) || !Number.isFinite(device.lastSeenAt)) throw new Error('Invalid paired device state')
        devices.set(device.id, device)
      }
      this.devices = devices
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Could not load paired devices')
    }
  }

  createCode(): { code: string; expiresAt: number } {
    const code = randomBytes(24).toString('base64url')
    const expiresAt = this.now() + PAIRING_TTL_MS
    this.code = { digest: hash(code), expiresAt }
    return { code, expiresAt }
  }

  allowClaim(address: string): boolean {
    const now = this.now()
    for (const [key, entry] of this.attempts) if (entry.resetAt <= now) this.attempts.delete(key)
    let entry = this.attempts.get(address)
    if (!entry) {
      // Bound memory without evicting active limits (which would permit bypass).
      if (this.attempts.size >= 4096) return false
      entry = { count: 0, resetAt: now + 60_000 }
      this.attempts.set(address, entry)
    }
    return ++entry.count <= 10
  }

  async claim(input: PairingClaimRequest, name: string): Promise<PairingClaimResponse> {
    const active = this.code
    const valid = pairingSecretMatches(input.code, active?.digest ?? Buffer.alloc(32))
    if (!active || !valid || this.now() >= active.expiresAt) throw new PairingError(401, 'Invalid pairing code')
    if (typeof input.deviceName !== 'string' || !input.deviceName.trim() || input.deviceName.length > 80 ||
      /[\u0000-\u001f\u007f]/.test(input.deviceName) || !['ios', 'android'].includes(input.platform)) {
      throw new PairingError(400, 'Invalid device name or platform')
    }
    // Consume synchronously, before any disk I/O: concurrent claims cannot reuse it.
    this.code = null
    const token = randomBytes(32).toString('base64url')
    const id = randomUUID()
    await this.mutate(async () => {
      if (this.devices.size >= MAX_DEVICES) throw new PairingError(409, 'Revoke a device before pairing another')
      const now = this.now()
      const device: StoredDevice = { id, tokenHash: hash(token).toString('hex'), deviceName: input.deviceName.trim(), platform: input.platform, createdAt: now, lastSeenAt: now }
      const next = new Map(this.devices).set(id, device)
      await this.persist(next)
      this.devices = next
    })
    return { deviceId: id, token, name }
  }

  list(): PairedDevice[] {
    return [...this.devices.values()].map(({ id, deviceName, platform, createdAt, lastSeenAt }) => ({ id, deviceName, platform, createdAt, lastSeenAt }))
  }

  authenticate(token: string): string | null {
    if (token.length > 1024) return null
    let found: StoredDevice | undefined
    for (const device of this.devices.values()) {
      if (pairingSecretMatches(token, Buffer.from(device.tokenHash, 'hex'))) found = device
    }
    if (!found) return null
    const id = found.id
    if (this.now() - found.lastSeenAt >= LAST_SEEN_INTERVAL_MS) {
      found.lastSeenAt = this.now()
      void this.mutate(() => this.persist(this.devices)).catch(() => {
        console.error('[commando] Could not update paired device last seen')
      })
    }
    return id
  }

  isActive(id: string): boolean { return this.devices.has(id) }

  onRevoke(listener: (id: string) => Promise<unknown>): void { this.revocationListeners.add(listener) }

  trackConnection(id: string, close: () => void): () => void {
    if (!this.devices.has(id)) { close(); return () => undefined }
    const connections = this.connections.get(id) ?? new Set()
    connections.add(close)
    this.connections.set(id, connections)
    return () => { connections.delete(close); if (!connections.size) this.connections.delete(id) }
  }

  async revoke(id: string): Promise<boolean> {
    return this.mutate(async () => {
      if (!this.devices.has(id)) return false
      const next = new Map(this.devices)
      next.delete(id)
      await this.persist(next)
      this.devices = next
      for (const close of this.connections.get(id) ?? []) close()
      this.connections.delete(id)
      await Promise.all([...this.revocationListeners].map((listener) => listener(id)))
      return true
    })
  }

  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.writes.then(operation)
    this.writes = result.catch(() => undefined)
    return result
  }

  private async persist(devices: Map<string, StoredDevice>): Promise<void> {
    await mkdir(dirname(this.statePath), { recursive: true, mode: 0o700 })
    const temporary = `${this.statePath}.${process.pid}.${randomUUID()}.tmp`
    let handle: Awaited<ReturnType<typeof open>> | undefined
    try {
      handle = await open(temporary, 'wx', 0o600)
      await handle.writeFile(`${JSON.stringify({ version: 1, devices: [...devices.values()] }, null, 2)}\n`)
      await handle.sync()
      await handle.close()
      handle = undefined
      await rename(temporary, this.statePath)
    } finally {
      await handle?.close().catch(() => undefined)
      await rm(temporary, { force: true })
    }
  }
}

const MAGIC_DNS = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+ts\.net$/i

/** Cached discovery is bounded as a whole, including a hung optional CLI. */
export function createPairingAddressDiscovery(dependencies: {
  cli?: (path: string) => Promise<string>
  reverse?: (ip: string) => Promise<string[]>
  now?: () => number
  timeoutMs?: number
} = {}) {
  const cli = dependencies.cli ?? ((path: string) => new Promise<string>((resolve, reject) => {
    execFile(path, ['status', '--json'], { timeout: 300, maxBuffer: 1024 * 1024 }, (error, stdout) => error ? reject(error) : resolve(stdout))
  }))
  const reverse = dependencies.reverse ?? (async (ip: string) => {
    const resolver = new Resolver({ timeout: 300, tries: 1 })
    resolver.setServers(['100.100.100.100'])
    return resolver.reverse(ip)
  })
  const now = dependencies.now ?? Date.now
  const cache = new Map<string, { expiresAt: number; value: Promise<string[]> }>()
  const names = (ips: string[]): Promise<string[]> => {
    const key = ips.join(',')
    const cached = cache.get(key)
    if (cached && cached.expiresAt > now()) return cached.value
    const discover = async (): Promise<string[]> => {
      for (const path of ['tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale']) {
        try {
          const status = JSON.parse(await cli(path)) as { Self?: { DNSName?: string; TailscaleIPs?: string[] } }
          const name = status.Self?.DNSName?.replace(/\.$/, '')
          if (name && MAGIC_DNS.test(name) && (!status.Self?.TailscaleIPs || status.Self.TailscaleIPs.some((ip) => ips.includes(ip)))) return [name]
        } catch { /* Try the app-bundled CLI, then the Tailscale resolver. */ }
      }
      const found = await Promise.all(ips.map(async (ip) => {
        try { return (await reverse(ip)).map((name) => name.replace(/\.$/, '')).filter((name) => MAGIC_DNS.test(name)) } catch { return [] }
      }))
      return [...new Set(found.flat())]
    }
    const value = new Promise<string[]>((resolve) => {
      const timer = setTimeout(() => resolve([]), dependencies.timeoutMs ?? 1000)
      void discover().then((names) => { clearTimeout(timer); resolve(names) }, () => { clearTimeout(timer); resolve([]) })
    })
    cache.set(key, { value, expiresAt: now() + 60_000 })
    return value
  }
  return async (port: number, listeners: string[]) => {
    const ipv4 = listeners.filter((address) => address.startsWith('100.') && !address.includes(':'))
    const dns = ipv4.length ? await names(ipv4) : []
    const urls = [...dns.map((name) => `http://${name}:${port}`), ...ipv4.map((ip) => `http://${ip}:${port}`)]
    if (!urls.length) urls.push(`http://127.0.0.1:${port}`)
    return { urls, name: hostname(), tailscaleEnabled: listeners.some((address) => address !== '127.0.0.1') }
  }
}

/** Discovery never changes listener or Host/Origin policy. */
export const pairingAddresses = createPairingAddressDiscovery()
