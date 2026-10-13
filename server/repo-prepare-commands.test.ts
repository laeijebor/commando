import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, expect, it, vi } from 'vitest'
import { defaultRepoPrepareCommandsPath, handleRepoPrepareCommands, RepoPrepareCommands } from './repo-prepare-commands.js'

const dirs: string[] = []
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))) })
async function store() {
  const dir = await mkdtemp(join(tmpdir(), 'commando-prepare-'))
  dirs.push(dir)
  return new RepoPrepareCommands(join(dir, 'commands.json'))
}

it('persists commands by normalized main root, serializes updates and deletes empty commands', async () => {
  const s = await store()
  expect(await s.get('/repo')).toBe('')
  await Promise.all([s.set('/repo/', 'npm ci\nnpm run build'), s.set('/other', 'pnpm install')])
  const loaded = new RepoPrepareCommands(s.path)
  expect(await loaded.get('/repo')).toBe('npm ci\nnpm run build')
  expect(await loaded.get('/other')).toBe('pnpm install')
  expect((await stat(s.path)).mode & 0o777).toBe(0o600)
  await loaded.set('/repo', '')
  expect(await loaded.get('/repo')).toBe('')
  expect(JSON.parse(await readFile(s.path, 'utf8'))).toEqual({ '/other': 'pnpm install' })
})

it('rejects unsafe roots and commands without losing existing data; tolerates corrupt persisted JSON', async () => {
  const s = await store()
  expect(() => s.set('relative', 'npm ci')).toThrow('absolute')
  expect(() => s.set('/repo', 'bad\0command')).toThrow('control')
  expect(() => s.set('/repo', 'x'.repeat(8193))).toThrow('8192')
  await writeFile(s.path, 'broken')
  expect(await s.get('/repo')).toBe('')
  await writeFile(s.path, JSON.stringify({ '/repo': 'npm ci', relative: 'bad', '/unsafe': 'bad\0command' }))
  expect(await s.get('/repo')).toBe('npm ci')
  expect(await s.get('/unsafe')).toBe('')
})

it('uses the daemon port and supports an explicit data path', () => {
  vi.stubEnv('COMMANDO_REPO_PREPARE_COMMANDS_PATH', '')
  vi.unstubAllEnvs()
  expect(defaultRepoPrepareCommandsPath(4410)).toMatch(/repo-prepare-commands-4410\.json$/)
  vi.stubEnv('COMMANDO_REPO_PREPARE_COMMANDS_PATH', '/test/commands.json')
  expect(defaultRepoPrepareCommandsPath(4410)).toBe('/test/commands.json')
})

it('handles GET/PUT behind the owner gate with validated JSON', async () => {
  const s = await store()
  const call = async (method: string, query = '', body?: unknown) => {
    const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]) as IncomingMessage
    req.method = method
    req.headers = { 'content-type': 'application/json' }
    const res = new EventEmitter() as ServerResponse
    let code = 0, result: any
    res.setHeader = vi.fn() as never
    res.writeHead = ((status: number) => { code = status; return res }) as never
    res.end = ((value: string) => { result = JSON.parse(value); return res }) as never
    expect(await handleRepoPrepareCommands(req, res, new URL(`http://localhost/api/repo-prepare-commands${query}`), s)).toBe(true)
    return { code, result }
  }
  expect(await call('GET', '?root=/repo')).toEqual({ code: 200, result: { command: '' } })
  expect(await call('PUT', '', { root: '/repo', command: 'npm ci' })).toEqual({ code: 200, result: { command: 'npm ci' } })
  expect(await call('GET', '?root=/repo')).toEqual({ code: 200, result: { command: 'npm ci' } })
  expect((await call('PUT', '', { root: 'relative', command: 'npm ci' })).code).toBe(400)
  expect((await call('PUT', '', null)).code).toBe(400)
  expect((await call('POST')).code).toBe(405)
})
