import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HostRegistry, validateHostBaseUrl, validateHostName, validateHostToken } from './hosts.js'

let directory: string
let path: string
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'commando-hosts-')); path = join(directory, 'hosts.json') })
afterEach(async () => { vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true }) })
const input = { name: 'Hub', baseUrl: 'http://127.0.0.1:4310', token: 'remote-secret' }

describe('host registry', () => {
  it('writes atomically with private permissions, reloads and never lists tokens', async () => {
    vi.stubEnv('COMMANDO_HOSTS_PATH', path)
    const registry = new HostRegistry()
    expect(registry.list()).toEqual([])
    const host = registry.add(input)
    expect(host.id).toMatch(/^[a-z0-9-]{1,48}$/)
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    expect(await readdir(directory)).toEqual(['hosts.json'])
    expect(JSON.stringify(registry.list())).not.toContain(input.token)
    const restored = new HostRegistry(path)
    expect(restored.get(host.id)).toEqual(host)
    restored.update(host.id, { name: 'Renamed', token: 'new-secret' })
    expect(registry.get(host.id)).toMatchObject({ name: 'Renamed', token: 'new-secret' })
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    registry.delete(host.id)
    expect(registry.list()).toEqual([])
    expect(() => registry.get(host.id)).toThrow('does not exist')
  })

  it.each(['{bad json', '{}', '{"version":1,"hosts":[{}]}', '{"version":2,"hosts":[]}'])('blocks mutations without overwriting corrupt state: %s', async (raw) => {
    await writeFile(path, raw)
    const registry = new HostRegistry(path)
    expect(() => registry.add(input)).toThrow('corrupt')
    expect(() => registry.update('hub', { name: 'New' })).toThrow('corrupt')
    expect(() => registry.delete('hub')).toThrow('corrupt')
    expect(await readFile(path, 'utf8')).toBe(raw)
    await writeFile(path, '{"version":1,"hosts":[]}')
    expect(() => registry.add(input)).toThrow('corrupt')
    expect(new HostRegistry(path).list()).toEqual([])
  })

  it('detects corruption introduced after a successful read and refuses stale token updates', async () => {
    const registry = new HostRegistry(path)
    const host = registry.add(input)
    registry.update(host.id, { token: 'rotated' }, host)
    expect(() => registry.update(host.id, { token: 'stale' }, host)).toThrow('changed during probe')
    await writeFile(path, 'broken')
    expect(() => registry.add(input)).toThrow('corrupt')
    expect(await readFile(path, 'utf8')).toBe('broken')
  })
})

describe('remote host validation', () => {
  it.each(['http://localhost', 'http://127.0.0.2:4310/', 'http://[::1]:4310', 'https://100.64.0.0', 'http://100.127.255.255:4310', 'http://[fd7a:115c:a1e0::1]', 'https://hub.tailnet.ts.net'])('allows %s', (url) => {
    expect(validateHostBaseUrl(url)).toBe(new URL(url).origin)
  })
  it.each(['http://100.63.255.255', 'http://100.128.0.0', 'http://192.168.1.1', 'http://[fd7a:115c:a1e1::1]', 'https://example.com', 'http://hub.ts.net.evil.com', 'http://-hub.ts.net', 'ftp://hub.ts.net', 'http://user:pass@localhost', 'http://localhost/api', 'http://localhost/api/..', 'http://localhost/?', 'http://localhost/#', 'http://localhost?query=1', 'http://localhost/#hash', 'http://localhost\\evil', 'http://localhost\n', null])('rejects %s', (url) => {
    expect(() => validateHostBaseUrl(url)).toThrow()
  })
  it('validates names and prevents bearer header injection', () => {
    expect(validateHostName(' Hub ')).toBe('Hub')
    for (const name of ['', ' '.repeat(2), 'x'.repeat(101), 'a\nb', null]) expect(() => validateHostName(name)).toThrow()
    for (const token of ['', 'a b', 'a\r\nHeader:value', 'x'.repeat(1025), null]) expect(() => validateHostToken(token)).toThrow()
  })
})
