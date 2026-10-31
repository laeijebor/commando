import { randomBytes } from 'node:crypto'
import { closeSync, fchmodSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { isIP } from 'node:net'
import type { AddHostRequest, HostErrorCode, UpdateHostRequest } from '../shared/hosts.js'
import { isLoopbackAddress, isTailscaleAddress } from './network-access.js'

export type StoredHost = AddHostRequest & { id: string; addedAt: number }
export type HostSummary = Omit<StoredHost, 'token'>
export const HOST_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export class HostError extends Error {
  constructor(readonly status: number, readonly code: HostErrorCode, message: string) { super(message) }
}

function invalid(message: string): never { throw new HostError(400, 'invalid_host', message) }

export function validateHostName(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 100 || /[\x00-\x1f\x7f]/.test(value)) invalid('Name must contain 1–100 printable characters')
  return value.trim()
}

export function validateHostToken(value: unknown): string {
  if (typeof value !== 'string' || !/^[\x21-\x7e]{1,1024}$/.test(value)) invalid('Token must contain 1–1024 non-whitespace ASCII characters')
  return value
}

export function validateHostBaseUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2048 || !/^https?:\/\/[^/?#\s\\]+\/?$/i.test(value)) invalid('baseUrl must be an HTTP(S) origin without credentials, path, query or fragment')
  let url: URL
  try { url = new URL(value) } catch { return invalid('Invalid baseUrl') }
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) invalid('baseUrl must be an origin without credentials, path, query or fragment')
  const hostname = url.hostname.replace(/^\[|\]$/g, '')
  const magicDns = hostname.endsWith('.ts.net') && hostname.length <= 253 && hostname.split('.').every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
  if (hostname !== 'localhost' && !(isIP(hostname) && (isLoopbackAddress(hostname) || isTailscaleAddress(hostname))) && !magicDns) invalid('Host must be loopback, a Tailscale address or a .ts.net MagicDNS name')
  return url.origin
}

export function publicHost({ id, name, baseUrl, addedAt }: StoredHost): HostSummary { return { id, name, baseUrl, addedAt } }

/** Reload before every operation, and latch corruption rather than overwriting it.
 * Mutations are synchronous, including atomic replacement, so concurrent API probes
 * cannot interleave a read/modify/write within this daemon. */
export class HostRegistry {
  private corrupt = false
  constructor(readonly path = process.env.COMMANDO_HOSTS_PATH ?? join(homedir(), '.commando', 'hosts.json')) {}

  private read(): StoredHost[] {
    if (this.corrupt) throw new HostError(503, 'hosts_corrupt', 'Host registry is corrupt; repair the file and restart the daemon')
    let raw: string
    try { raw = readFileSync(this.path, 'utf8') } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw new HostError(503, 'hosts_storage_error', 'Cannot read host registry')
    }
    try {
      const data = JSON.parse(raw)
      if (data?.version !== 1 || !Array.isArray(data.hosts)) throw new Error()
      const ids = new Set<string>()
      return data.hosts.map((host: StoredHost) => {
        if (!host || typeof host.id !== 'string' || host.id.length > 48 || !HOST_ID.test(host.id) || ids.has(host.id) || !Number.isSafeInteger(host.addedAt) || host.addedAt < 0) throw new Error()
        ids.add(host.id)
        return { id: host.id, name: validateHostName(host.name), baseUrl: validateHostBaseUrl(host.baseUrl), token: validateHostToken(host.token), addedAt: host.addedAt }
      })
    } catch {
      this.corrupt = true
      throw new HostError(503, 'hosts_corrupt', 'Host registry is corrupt; repair the file and restart the daemon')
    }
  }

  private write(hosts: StoredHost[]): void {
    const temporary = `${this.path}.${randomBytes(8).toString('hex')}.tmp`
    let fd: number | undefined
    try {
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
      fd = openSync(temporary, 'wx', 0o600)
      fchmodSync(fd, 0o600)
      writeFileSync(fd, `${JSON.stringify({ version: 1, hosts }, null, 2)}\n`)
      fsyncSync(fd)
      closeSync(fd); fd = undefined
      renameSync(temporary, this.path)
    } catch {
      throw new HostError(503, 'hosts_storage_error', 'Cannot save host registry')
    } finally {
      if (fd !== undefined) closeSync(fd)
      try { unlinkSync(temporary) } catch { /* renamed or not created */ }
    }
  }

  list(): HostSummary[] { return this.read().map(publicHost) }
  /** Credentials are for daemon transports only. */
  get(id: string): StoredHost {
    const host = this.read().find((entry) => entry.id === id)
    if (!host) throw new HostError(404, 'not_found', 'Host does not exist')
    return host
  }
  add(input: AddHostRequest): StoredHost {
    const hosts = this.read()
    const host = { id: randomBytes(6).toString('hex'), name: validateHostName(input.name), baseUrl: validateHostBaseUrl(input.baseUrl), token: validateHostToken(input.token), addedAt: Date.now() }
    hosts.push(host); this.write(hosts)
    return host
  }
  update(id: string, input: UpdateHostRequest, expected?: StoredHost): StoredHost {
    const hosts = this.read()
    const index = hosts.findIndex((host) => host.id === id)
    if (index < 0) throw new HostError(404, 'not_found', 'Host does not exist')
    if (expected && hosts[index].token !== expected.token) throw new HostError(409, 'host_conflict', 'Host changed during probe; retry')
    const host = { ...hosts[index], ...(input.name === undefined ? {} : { name: validateHostName(input.name) }), ...(input.token === undefined ? {} : { token: validateHostToken(input.token) }) }
    hosts[index] = host; this.write(hosts)
    return host
  }
  delete(id: string): void {
    const hosts = this.read()
    if (!hosts.some((host) => host.id === id)) throw new HostError(404, 'not_found', 'Host does not exist')
    this.write(hosts.filter((host) => host.id !== id))
  }
}
