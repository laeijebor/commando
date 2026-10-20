import { createHash, timingSafeEqual } from 'node:crypto'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import type { IncomingMessage } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PAIRING_TTL_MS, PairingRegistry, createPairingAddressDiscovery, defaultPairingDevicesPath, pairingSecretMatches, requestMatchesBearer } from './pairing.js'

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>()
  return { ...actual, timingSafeEqual: vi.fn(actual.timingSafeEqual) }
})

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))) })
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'commando-pairing-'))
  directories.push(dir)
  let now = 1000
  const registry = new PairingRegistry(join(dir, 'paired-devices.json'), () => now)
  await registry.load()
  return { registry, advance: (ms: number) => { now += ms } }
}
const input = { deviceName: 'My iPhone', platform: 'ios' as const }
const digest = (value: string) => createHash('sha256').update(value).digest()

describe('pairing', () => {
  it('expires at 120 seconds and gives identical errors for unknown, expired and used codes', async () => {
    const { registry, advance } = await setup()
    const first = registry.createCode()
    expect(Buffer.from(first.code, 'base64url').length).toBeGreaterThanOrEqual(16)
    expect(first.expiresAt).toBe(1000 + PAIRING_TTL_MS)
    advance(PAIRING_TTL_MS)
    for (const code of [first.code, 'wrong']) {
      await expect(registry.claim({ ...input, code }, 'Mac')).rejects.toMatchObject({ status: 401, message: 'Invalid pairing code' })
    }
    const fresh = registry.createCode()
    await registry.claim({ ...input, code: fresh.code }, 'Mac')
    await expect(registry.claim({ ...input, code: fresh.code }, 'Mac')).rejects.toMatchObject({ status: 401, message: 'Invalid pairing code' })
  })

  it('newest code wins and only one concurrent claim succeeds', async () => {
    const { registry } = await setup()
    const old = registry.createCode()
    const current = registry.createCode()
    await expect(registry.claim({ ...input, code: old.code }, 'Mac')).rejects.toMatchObject({ status: 401 })
    const claims = await Promise.allSettled(Array.from({ length: 5 }, () => registry.claim({ ...input, code: current.code }, 'Mac')))
    expect(claims.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(registry.list()).toHaveLength(1)
  })

  it('hashes secrets before fixed-length timingSafeEqual comparisons, including different lengths', () => {
    vi.mocked(timingSafeEqual).mockClear()
    expect(pairingSecretMatches('a', digest('a'))).toBe(true)
    for (const candidate of ['', 'b', 'a'.repeat(1024)]) expect(pairingSecretMatches(candidate, digest('a'))).toBe(false)
    expect(timingSafeEqual).toHaveBeenCalledTimes(4)
    for (const [left, right] of vi.mocked(timingSafeEqual).mock.calls) {
      expect(left.byteLength).toBe(32)
      expect(right.byteLength).toBe(32)
    }
  })

  it('limits claims to ten per address per minute', async () => {
    const { registry, advance } = await setup()
    for (let i = 0; i < 10; i++) expect(registry.allowClaim('100.64.0.1')).toBe(true)
    expect(registry.allowClaim('100.64.0.1')).toBe(false)
    expect(registry.allowClaim('100.64.0.2')).toBe(true)
    advance(60_000)
    expect(registry.allowClaim('100.64.0.1')).toBe(true)
  })

  it('persists only SHA256 at 0600, reloads, throttles last seen, and durably revokes live connections', async () => {
    const { registry, advance } = await setup()
    const { code } = registry.createCode()
    const device = await registry.claim({ ...input, code }, 'Mac')
    expect(Buffer.from(device.token, 'base64url').length).toBeGreaterThanOrEqual(32)
    const raw = await readFile(registry.statePath, 'utf8')
    expect(raw).not.toContain(device.token)
    expect(raw).not.toContain(code)
    expect(raw).toContain(digest(device.token).toString('hex'))
    expect((await stat(registry.statePath)).mode & 0o777).toBe(0o600)
    expect(registry.list()[0]).not.toHaveProperty('tokenHash')
    const reloaded = new PairingRegistry(registry.statePath, () => 1000)
    await reloaded.load()
    expect(reloaded.authenticate(device.token)).toBe(device.deviceId)
    expect(registry.authenticate('wrong')).toBeNull()
    const close = vi.fn()
    const disconnected = vi.fn()
    registry.trackConnection(device.deviceId, close)
    registry.trackConnection(device.deviceId, disconnected)()
    advance(59_999)
    registry.authenticate(device.token)
    expect(registry.list()[0].lastSeenAt).toBe(1000)
    advance(1)
    registry.authenticate(device.token)
    expect(registry.list()[0].lastSeenAt).toBe(61_000)
    expect(await registry.revoke(device.deviceId)).toBe(true)
    expect(close).toHaveBeenCalledOnce()
    expect(disconnected).not.toHaveBeenCalled()
    expect(registry.authenticate(device.token)).toBeNull()
    await reloaded.load()
    expect(reloaded.authenticate(device.token)).toBeNull()
    expect(await registry.revoke(device.deviceId)).toBe(false)
  })

  it.each(['header', 'query', 'subprotocol'])('accepts device tokens through existing %s transport and rejects revoked ones', async (transport) => {
    const { registry } = await setup()
    const { code } = registry.createCode()
    const device = await registry.claim({ ...input, code }, 'Mac')
    const url = new URL('http://localhost/api/health')
    const headers: Record<string, string> = {}
    if (transport === 'query') url.searchParams.set('token', device.token)
    if (transport === 'header') headers.authorization = `Bearer ${device.token}`
    if (transport === 'subprotocol') headers['sec-websocket-protocol'] = `commando, commando-auth.${encodeURIComponent(device.token)}`
    const request = { headers } as IncomingMessage
    const accepted = () => requestMatchesBearer(request, url, (candidate) => registry.authenticate(candidate) !== null)
    expect(accepted()).toBe(true)
    await registry.revoke(device.deviceId)
    expect(accepted()).toBe(false)
  })
})

describe('pairing address discovery and instance isolation', () => {
  it('scopes default token state to the daemon port', () => {
    expect(defaultPairingDevicesPath(4310)).toMatch(/paired-devices-4310.json$/)
    expect(defaultPairingDevicesPath(4411)).not.toBe(defaultPairingDevicesPath(4310))
  })
  it('tries the app-bundled CLI and caches MagicDNS before IP', async () => {
    const cli = vi.fn().mockRejectedValueOnce(new Error('ENOENT')).mockResolvedValue(JSON.stringify({ Self: { DNSName: 'studio.tail.ts.net.', TailscaleIPs: ['100.72.39.66'] } }))
    const reverse = vi.fn()
    const discover = createPairingAddressDiscovery({ cli, reverse })
    expect((await discover(4411, ['127.0.0.1', '100.72.39.66'])).urls).toEqual(['http://studio.tail.ts.net:4411', 'http://100.72.39.66:4411'])
    await discover(4411, ['127.0.0.1', '100.72.39.66'])
    expect(cli.mock.calls.map(([path]) => path)).toEqual(['tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale'])
    expect(reverse).not.toHaveBeenCalled()
  })
  it('uses reverse DNS when no CLI works, filtering names to ts.net', async () => {
    const reverse = vi.fn().mockResolvedValue(['studio.tail.ts.net.', 'evil.example'])
    const discover = createPairingAddressDiscovery({ cli: vi.fn().mockRejectedValue(new Error('no CLI')), reverse })
    expect((await discover(4411, ['100.72.39.66'])).urls).toEqual(['http://studio.tail.ts.net:4411', 'http://100.72.39.66:4411'])
    expect(reverse).toHaveBeenCalledWith('100.72.39.66')
  })
  it('bounds even a hung discovery and caches the fallback', async () => {
    vi.useFakeTimers()
    try {
      const cli = vi.fn(() => new Promise<string>(() => undefined))
      const discover = createPairingAddressDiscovery({ cli, timeoutMs: 1000 })
      const pending = discover(4411, ['100.72.39.66'])
      await vi.advanceTimersByTimeAsync(1000)
      expect((await pending).urls).toEqual(['http://100.72.39.66:4411'])
      await discover(4411, ['100.72.39.66'])
      expect(cli).toHaveBeenCalledOnce()
    } finally { vi.useRealTimers() }
  })
})
