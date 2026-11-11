import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, expect, it, vi } from 'vitest'
import { DiffFiltersStore } from './diff-filters.js'

const dirs: string[] = []
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))) })

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'diff-filters-')); dirs.push(dir)
  const path = join(dir, 'filters.json'), changed = vi.fn()
  const store = new DiffFiltersStore({ path, changed })
  await store.load()
  async function call(method: string, value?: unknown, contentType = 'application/json') {
    const request = Readable.from(value === undefined ? [] : [Buffer.from(typeof value === 'string' ? value : JSON.stringify(value))]) as IncomingMessage
    request.method = method; request.headers = { 'content-type': contentType }
    let status = 0, result: any
    const response = new EventEmitter() as ServerResponse
    response.writeHead = ((code: number) => { status = code; return response }) as never
    response.end = ((raw?: string) => { result = raw ? JSON.parse(raw) : undefined; return response }) as never
    const handled = await store.handle(request, response, new URL('http://localhost/api/diff-filters'))
    return { status, result, handled }
  }
  return { path, changed, store, call }
}

it('saves switches and per-repo patterns, broadcasts each change, and reloads them', async () => {
  const s = await setup()
  expect((await s.call('GET')).result).toEqual({ ok: true, filters: { hideTests: false, hideGenerated: false, generatedByRepo: {} } })
  expect((await s.call('PUT', { hideTests: true })).result.filters.hideTests).toBe(true)
  expect((await s.call('PUT', { repo: { root: '/dev/Save-All', patterns: ['drizzle/', ' ', 'drizzle/'] } })).result.filters.generatedByRepo).toEqual({ '/dev/Save-All': ['drizzle/'] })
  expect(s.changed).toHaveBeenCalledTimes(2)
  expect(s.changed).toHaveBeenLastCalledWith({ hideTests: true, hideGenerated: false, generatedByRepo: { '/dev/Save-All': ['drizzle/'] } })
  const reloaded = new DiffFiltersStore({ path: s.path, changed: vi.fn() }); await reloaded.load()
  expect(reloaded.get()).toEqual(s.store.get())
  await s.call('PUT', { repo: { root: '/dev/Save-All', patterns: null } })
  expect(JSON.parse(await readFile(s.path, 'utf8')).generatedByRepo).toEqual({})
})

it('rejects bad requests without saving or broadcasting', async () => {
  const s = await setup()
  expect((await s.call('PUT', { hideTests: 1 })).status).toBe(400)
  expect((await s.call('PUT', { repo: { root: 'relative', patterns: [] } })).status).toBe(400)
  expect((await s.call('PUT', '{nope')).status).toBe(400)
  expect((await s.call('PUT', { hideTests: true }, 'text/plain')).status).toBe(400)
  expect((await s.call('DELETE')).status).toBe(405)
  expect(s.changed).not.toHaveBeenCalled()
})

it('starts from defaults when the saved file is corrupt', async () => {
  const s = await setup()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  await writeFile(s.path, '{broken')
  const store = new DiffFiltersStore({ path: s.path, changed: vi.fn() }); await store.load()
  expect(store.get()).toEqual({ hideTests: false, hideGenerated: false, generatedByRepo: {} })
})
