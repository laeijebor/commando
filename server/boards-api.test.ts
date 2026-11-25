import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BoardsApi } from './boards-api.js'
import { BoardStore } from './boards.js'
import { RedlineArtifactRegistry } from './redline-artifacts.js'
import { WebPaneService } from './web-panes.js'
import type { BoardItemKind } from '../shared/board.js'
const target = '00000000-0000-4000-8000-000000000001'
const other = '00000000-0000-4000-8000-000000000002'
const agentToken = 'a'.repeat(64)
const anchor = { id: '%1', targetId: target, sessionId: '$1', windowId: '@1' }
let api: BoardsApi, root: string, store: BoardStore, panes: WebPaneService
let artifacts: RedlineArtifactRegistry
let revealed: ReturnType<typeof vi.fn<(path: string) => Promise<void>>>
const base = 'http://localhost'
let changed: ReturnType<typeof vi.fn<(targetId: string, rev: number) => void>>, revived: ReturnType<typeof vi.fn<() => void>>
beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'board-api-test-')))
  changed = vi.fn(); revived = vi.fn()
  artifacts = new RedlineArtifactRegistry()
  revealed = vi.fn(async () => {})
  panes = new WebPaneService(join(root, 'web.json'))
  store = new BoardStore({ root: join(root, 'boards'), snapshotRoot: join(root, 'snapshots'), artifacts, webPanes: panes, onChange: changed })
  api = makeApi(revealed)

})
function makeApi(revealInFinder?: (path: string) => Promise<void>) {
  return new BoardsApi({ store, artifacts, agentToken, ownerAuthorized: async (r) => r.headers.authorization === 'Bearer owner', paneForId: (id) => id === '%1' ? anchor : undefined, paneForTarget: (t) => t === target ? anchor : undefined, agentSession: () => ({ provider: 'codex', id: 'session-one' }), onRevive: revived, revealInFinder })
}
afterEach(async () => { store.flush(); await panes.flush(); rmSync(root, { recursive: true, force: true }) })
async function http(url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) {
  const request = Readable.from(init.body === undefined ? [] : [Buffer.from(init.body)]) as IncomingMessage
  request.method = init.method ?? 'GET'
  request.headers = Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]))
  let status = 200, output = ''
  const response = { setHeader: () => undefined, writeHead: (code: number) => { status = code }, end: (b: string) => { output = b } } as unknown as ServerResponse
  const handled = await api.handle(request, response, new URL(url))
  return { status: handled ? status : 404, json: async () => output ? JSON.parse(output) : null }
}
async function request(path = '', method = 'GET', data?: unknown, auth = 'owner', byPane = false) {
  const res = await http(`${base}/api/boards/${byPane ? 'by-pane/%251' : target}${path}`, { method, headers: { ...(auth ? { Authorization: `Bearer ${auth}` } : {}), ...(data !== undefined ? { 'Content-Type': 'application/json' } : {}) }, body: data === undefined ? undefined : JSON.stringify(data) })
  return { status: res.status, data: await res.json() }
}

describe('BoardsApi', () => {
  it('requires owner or hook auth, scopes hook requests to a pane and accepts owner detached reads', async () => {
    expect((await request('', 'GET', undefined, '')).status).toBe(401)
    expect((await request('', 'GET', undefined, agentToken)).status).toBe(403)
    expect((await request('', 'GET', undefined, agentToken, true)).data).toMatchObject({ targetId: target, rev: 0, items: [] })
    const detached = await http(`${base}/api/boards/${other}`, { headers: { Authorization: 'Bearer owner' } })
    expect(detached.status).toBe(200)
    const mismatched = await http(`${base}/api/boards/${other}`, { headers: { Authorization: `Bearer ${agentToken}`, 'X-Commando-Pane': '%1' } })
    expect(mismatched.status).toBe(403)
  })
  it('adds, patches, reads and deletes encoded canonical keys, notifying each mutation', async () => {
    const added = await request('/items', 'POST', { url: 'https://EXAMPLE.com/a/?utm_source=x', title: 'Example', pinned: true })
    expect(added.status).toBe(201); expect(added.data).toMatchObject({ key: 'url:https://example.com/a', source: 'user', origin: { agentSession: { id: 'session-one' } } })
    const key = encodeURIComponent(added.data.key)
    expect((await request(`/items/${key}`, 'PATCH', { title: 'New', caption: 'Caption', pinned: false })).status).toBe(200)
    expect((await request()).data.items[0]).toMatchObject({ title: 'New', caption: 'Caption', pinned: false, state: 'open' })
    expect((await request(`/items/${key}`, 'DELETE')).status).toBe(200)
    expect((await request()).data).toMatchObject({ rev: 3, items: [] }); expect(changed).toHaveBeenCalledTimes(3)
  })
  it('lets agents create groups, clips, relationships and placements, but protects user drags', async () => {
    const group = await request('/groups', 'POST', { id: 'evidence', title: 'Evidence', tone: 'green' }, agentToken, true)
    expect(group.status).toBe(201)
    const clip = await request('/items', 'POST', { text: 'Keep this decision', tone: 'decision', group: 'evidence' }, agentToken, true)
    expect(clip.data).toMatchObject({ kind: 'clip', source: 'agent', caption: 'Keep this decision' })
    expect((await request('/groups', 'POST', { id: 'next', title: 'Next', near: 'evidence' }, agentToken, true)).status).toBe(201)
    const link = await request('/links', 'POST', { from: 'evidence', to: 'next', label: 'Then' }, agentToken, true)
    expect(link.status).toBe(201)
    const drag = await request('/place', 'POST', { key: clip.data.key, group: 'evidence', x: 50, y: 60 })
    expect(drag.data.placements[clip.data.key]).toMatchObject({ x: 50, y: 60, fixed: true })
    expect((await request('/place', 'POST', { key: clip.data.key, group: 'next' }, agentToken, true)).status).toBe(409)
    expect((await request('/groups/evidence', 'PATCH', { x: 20 }, agentToken, true)).status).toBe(400)
    expect((await request('/groups/evidence', 'PATCH', { title: 'Findings' }, agentToken, true)).status).toBe(200)
    expect((await request(`/links/${link.data.id}`, 'DELETE')).status).toBe(200)
    expect((await request('/groups/evidence', 'DELETE')).status).toBe(200)
    expect((await request()).data.placements).toEqual({ [clip.data.key]: { x: 50, y: 60, fixed: true } })
  })
  it('creates narrow agent groups below existing ones unless near is explicit', async () => {
    const first = await request('/groups', 'POST', { id: 'first', title: 'First' }, agentToken, true)
    expect(first.data).toMatchObject({ w: 464, x: 0, y: 0 })
    const second = await request('/groups', 'POST', { id: 'second', title: 'Second' }, agentToken, true)
    expect(second.data).toMatchObject({ w: 464, x: 0, y: first.data.h + 32 })
    const near = await request('/groups', 'POST', { id: 'near', title: 'Near', near: 'first' }, agentToken, true)
    expect(near.data).toMatchObject({ w: 464, x: 496, y: 0 })
    const custom = await request('/groups', 'POST', { id: 'custom', title: 'Custom', w: 1000 })
    expect(custom.data.w).toBe(1000)
  })
  it('returns available links, clips and PRs while an untabbed page stays closed', async () => {
    await request('/items', 'POST', { url: 'https://example.com' })
    await request('/items', 'POST', { text: 'A decision' })
    await request('/items', 'POST', { url: 'https://github.com/owner/repo/pull/12', kind: 'pr' })
    await request('/items', 'POST', { url: 'https://example.com/page', kind: 'page' })
    expect((await request()).data.items.map((i: { kind: string; state: string }) => [i.kind, i.state])).toEqual([['link', 'open'], ['clip', 'open'], ['pr', 'open'], ['page', 'closed']])
  })
  it.each(['screenshot', 'video', 'file', 'diagram'] as const)('reads %s availability and keeps file revival returning its path', async (kind) => {
    const path = join(root, `${kind}.dat`); writeFileSync(path, 'file')
    const added = await request('/items', 'POST', { path, kind })
    expect(added.status).toBe(201)
    expect((await request()).data.items[0]).toMatchObject({ kind, state: 'open' })
    const endpoint = `/items/${encodeURIComponent(added.data.key)}/revive`
    expect((await request(endpoint, 'POST', { anchorPaneId: '%1' })).data).toEqual({ path })
    expect(panes.list()).toEqual([])
    rmSync(path)
    expect((await request()).data.items[0].state).toBe('missing')
    expect((await request(endpoint, 'POST', { anchorPaneId: '%1' })).status).toBe(409)
  })
  it('revives URL with confirmation and returns a file path without opening it', async () => {
    const link = await request('/items', 'POST', { url: 'https://example.com' })
    const result = await request(`/items/${encodeURIComponent(link.data.key)}/revive`, 'POST', { anchorPaneId: '%1' })
    expect(result.status).toBe(200); expect(panes.get(result.data.webPaneId)?.status).toBe('pending'); expect(revived).toHaveBeenCalled()
    const path = join(root, 'image.png'); writeFileSync(path, 'image')
    const image = await request('/items', 'POST', { path })
    const endpoint = `/items/${encodeURIComponent(image.data.key)}/revive`
    expect((await request(endpoint, 'POST', { anchorPaneId: '%1' })).data).toEqual({ path })
    expect((await request(endpoint, 'POST', { anchorPaneId: '%999' })).status).toBe(400)
    rmSync(path)
    const missing = await request(endpoint, 'POST', { anchorPaneId: '%1' })
    expect(missing.status).toBe(409); expect(missing.data.error).toContain('missing')
  })
  describe('reveal', () => {
    const endpoint = (key: string) => `/items/${encodeURIComponent(key)}/reveal`
    it.each(['file', 'screenshot', 'video'] as const)('reveals a %s without a body or board mutation', async (kind) => {
      const path = join(root, 'local file.png'); writeFileSync(path, 'file')
      const item = store.upsert(target, { key: `file:${path}`, kind, title: 'File', ref: { path }, source: 'user' })
      const board = store.get(target)
      const result = await request(endpoint(item.key), 'POST')
      expect(result).toEqual({ status: 204, data: null })
      expect(revealed).toHaveBeenCalledExactlyOnceWith(path)
      expect(store.get(target)).toEqual(board)
    })
    it.each(['canvas', 'slides', 'guide', 'redline'] as const)('reveals the registered artifact directory for %s', async (kind) => {
      const dir = join(root, 'artifact'); mkdirSync(dir)
      const artifactId = artifacts.register(dir).id
      const item = store.upsert(target, { key: `canvas:${kind}`, kind, title: 'Artifact', source: 'user', ref: { artifactId, path: join(root, 'stale-path') } })
      expect((await request(endpoint(item.key), 'POST')).status).toBe(204)
      expect(revealed).toHaveBeenCalledExactlyOnceWith(dir)
    })
    it.each(['canvas', 'slides', 'guide', 'redline'] as const)('reveals the snapshot folder for a %s snapshot', async (kind) => {
      const source = join(root, 'removed-artifact'); mkdirSync(source)
      const artifactId = artifacts.register(source).id
      const snapshotId = '00000000-0000-4000-8000-000000000003', snapshot = join(root, 'snapshots', snapshotId)
      mkdirSync(snapshot, { recursive: true }); writeFileSync(join(snapshot, 'index.html'), 'snapshot')
      rmSync(source, { recursive: true })
      const item = store.upsert(target, { key: `canvas:${kind}`, kind, title: 'Snapshot', source: 'user', ref: { path: source, artifactId, file: 'index.html', snapshotId } })
      expect(store.state(item, target)).toBe('snapshot')
      expect((await request(endpoint(item.key), 'POST')).status).toBe(204)
      expect(revealed).toHaveBeenCalledExactlyOnceWith(snapshot)
      rmSync(snapshot, { recursive: true })
      expect((await request(endpoint(item.key), 'POST')).status).toBe(404)
      expect(revealed).toHaveBeenCalledTimes(1)
    })
    it('supports the by-pane alias and rejects agents and unauthenticated callers', async () => {
      const path = join(root, 'file'); writeFileSync(path, 'file')
      const item = store.upsert(target, { key: `file:${path}`, kind: 'file', title: 'File', ref: { path }, source: 'user' })
      expect((await request(endpoint(item.key), 'POST', undefined, '', true)).status).toBe(401)
      expect((await request(endpoint(item.key), 'POST', undefined, agentToken, true)).status).toBe(403)
      const directAgent = await http(`${base}/api/boards/${target}${endpoint(item.key)}`, { method: 'POST', headers: { Authorization: `Bearer ${agentToken}`, 'X-Commando-Pane': '%1' } })
      expect(directAgent.status).toBe(403); expect(revealed).not.toHaveBeenCalled()
      expect((await request(endpoint(item.key), 'POST', undefined, 'owner', true)).status).toBe(204)
      expect(revealed).toHaveBeenCalledExactlyOnceWith(path)
    })
    it('returns 404 for absent items and files that disappeared', async () => {
      expect((await request(endpoint('file:/absent'), 'POST')).status).toBe(404)
      const path = join(root, 'removed.png'); writeFileSync(path, 'file')
      const item = store.upsert(target, { key: `file:${path}`, kind: 'screenshot', title: 'Missing', ref: { path }, source: 'user' })
      rmSync(path)
      expect((await request(endpoint(item.key), 'POST')).status).toBe(404)
      expect(revealed).not.toHaveBeenCalled()
    })
    it('returns 404 for missing and unregistered artifact directories', async () => {
      const dir = join(root, 'artifact'); mkdirSync(dir)
      const artifactId = artifacts.register(dir).id
      const item = store.upsert(target, { key: 'canvas:missing', kind: 'canvas', title: 'Missing', source: 'user', ref: { artifactId, path: dir } })
      artifacts.unregister(artifactId)
      expect((await request(endpoint(item.key), 'POST')).status).toBe(404)
      const otherId = artifacts.register(dir).id
      store.upsert(target, { ...item, ref: { artifactId: otherId, path: dir } })
      rmSync(dir, { recursive: true })
      expect((await request(endpoint(item.key), 'POST')).status).toBe(404)
      expect(revealed).not.toHaveBeenCalled()
    })
    it.each(['pr', 'link', 'clip', 'page', 'diagram'] satisfies BoardItemKind[])('returns 404 for a %s without a revealable path', async (kind) => {
      const item = store.upsert(target, { key: 'clip:no-path', kind, title: 'No path', source: 'user', ref: { path: root } })
      expect((await request(endpoint(item.key), 'POST')).status).toBe(404)
      expect(revealed).not.toHaveBeenCalled()
    })
    it('returns 501 when the host does not provide Finder reveal', async () => {
      const path = join(root, 'file'); writeFileSync(path, 'file')
      const item = store.upsert(target, { key: `file:${path}`, kind: 'file', title: 'File', ref: { path }, source: 'user' })
      api = makeApi()
      expect((await request(endpoint(item.key), 'POST')).status).toBe(501)
      expect(revealed).not.toHaveBeenCalled()
    })
    it('rejects non-POST methods and reports Finder failures without a board mutation', async () => {
      const path = join(root, 'file'); writeFileSync(path, 'file')
      const item = store.upsert(target, { key: `file:${path}`, kind: 'file', title: 'File', ref: { path }, source: 'user' }), board = store.get(target)
      expect((await request(endpoint(item.key))).status).toBe(405)
      expect(revealed).not.toHaveBeenCalled()
      revealed.mockRejectedValue(new Error('Finder failed'))
      expect((await request(endpoint(item.key), 'POST')).status).toBe(500)
      expect(store.get(target)).toEqual(board)
    })
  })
  it.each([
    ['/items', { url: 'javascript:alert(1)' }],
    ['/items', { path: 'relative' }],
    ['/items', { path: '/no/such/board-file' }],
    ['/items', { text: 'a', url: 'https://example.com' }],
    ['/items', { text: 'a', tone: 'bad' }],
    ['/items', { text: 'a', pinned: 'yes' }],
    ['/items', { text: 'a', arbitrary: true }],
    ['/groups', { id: '../bad', title: 'Group' }],
    ['/groups', { title: 'Group', w: 1 }],
    ['/links', { from: 'absent', to: 'also-absent' }],
    ['/place', { key: 'url:https://example.com', x: 20 }],
  ])('rejects invalid input on %s', async (path, data) => expect((await request(path, 'POST', data)).status).toBeGreaterThanOrEqual(400))
  it('bounds request size and rejects bad JSON/content type/encoding without mutation', async () => {
    expect((await request('/items', 'POST', { text: 'a'.repeat(25000) })).status).toBe(413)
    const plain = await http(`${base}/api/boards/${target}/items`, { method: 'POST', headers: { Authorization: 'Bearer owner', 'Content-Type': 'text/plain' }, body: '{}' })
    expect(plain.status).toBe(415)
    const bad = await http(`${base}/api/boards/${target}/items`, { method: 'POST', headers: { Authorization: 'Bearer owner', 'Content-Type': 'application/json' }, body: '{bad' })
    expect(bad.status).toBe(400)
    expect((await request('/items/%ZZ')).status).toBe(400)
    expect(store.get(target).rev).toBe(0)
  })
})
