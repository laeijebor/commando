import { mkdtemp, readFile, readdir, rm, symlink, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { canvasContentHash, writeCanvas } from './canvas-write.js'
import { RedlineArtifactRegistry } from './redline-artifacts.js'
import { RedlineApi } from './redline-api.js'

const token = 'test-agent-hook-token-at-least-32-characters'
const board = { unknownFirst: { nested: ['keep'] }, title: 'Board', frames: [
  { id: 'a', title: 'A', src: 'a.html', unknown: { zoom: 2 }, y: 2, x: 1, interactive: true },
  { id: 'b', title: 'B', src: 'b.html', x: 3, y: 4 }],
  sections: [{ id: 's', title: 'Section', ticket: 'APP-1', status: 'idea', frames: ['a'], extra: true }], tail: 'kept' }
let dir: string, outside: string, artifacts: RedlineArtifactRegistry, id: string, api: RedlineApi
const original = JSON.stringify(board, null, 2) + '\n'
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'canvas-write-')); outside = await mkdtemp(join(tmpdir(), 'canvas-outside-'))
  artifacts = new RedlineArtifactRegistry(); id = artifacts.register(dir).id
  await writeFile(join(dir, 'canvas.json'), original)
  api = new RedlineApi({ artifacts, baseUrl: 'http://localhost', agentToken: token, ownerAuthorized: async (req) => req.headers['x-owner'] === 'yes' })
})
afterEach(async () => { await rm(dir, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }) })
async function request(path: string, body?: unknown, auth: 'agent' | 'owner' | 'none' = 'owner', method = 'PATCH') {
  const req = Readable.from(body ? [JSON.stringify(body)] : []) as unknown as IncomingMessage
  req.method = method; req.headers = { 'content-type': 'application/json', ...(auth === 'owner' ? { 'x-owner': 'yes' } : auth === 'agent' ? { authorization: `Bearer ${token}` } : {}) }
  const writeHead = vi.fn(), end = vi.fn(), setHeader = vi.fn()
  await api.handle(req, { writeHead, end, setHeader } as unknown as ServerResponse, new URL(path, 'http://localhost'))
  return { status: writeHead.mock.calls[0][0], headers: writeHead.mock.calls[0][1], body: end.mock.calls[0][0], setHeader }
}
const move = () => ({ manifest: 'canvas.json', expectedHash: canvasContentHash(original), moves: [{ id: 'a', x: 30, y: -20 }] })
describe('canvas writer and owner-only API without sockets', () => {
  it('retains numeric key order, precise unknown numbers and escaped strings during reformatting', async () => {
    const text = original.replace('"unknownFirst": {', '"unknownFirst": {\n    "20": 90071992547409931234,\n    "3": "escape \\"quote\\"",')
    await writeFile(join(dir, 'canvas.json'), text)
    writeCanvas(artifacts, id, { ...move(), expectedHash: canvasContentHash(text) }, 'frames')
    expect(await readFile(join(dir, 'canvas.json'), 'utf8')).toBe(text.replace('"y": 2,', '"y": -20,').replace('"x": 1,', '"x": 30,'))
  })
  it('preserves unknown fields, array/key order and two-space indentation and returns the new hash', async () => {
    const result = writeCanvas(artifacts, id, move(), 'frames')
    const text = await readFile(join(dir, 'canvas.json'), 'utf8')
    expect(text).toBe(original.replace('"y": 2,', '"y": -20,').replace('"x": 1,', '"x": 30,'))
    expect(result.contentHash).toBe(canvasContentHash(text))
    expect(result.manifest.frames[0]).toMatchObject({ x: 30, y: -20 })
    expect(await readdir(dir)).toEqual(['canvas.json'])
    writeCanvas(artifacts, id, { manifest: 'canvas.json', expectedHash: result.contentHash, statuses: [{ id: 's', status: 'shipped' }] }, 'sections')
    expect(await readFile(join(dir, 'canvas.json'), 'utf8')).toBe(text.replace('"status": "idea"', '"status": "shipped"'))
  })
  it('rejects stale content with 409 without modifying the latest file', async () => {
    const changed = original.replace('Board', 'Agent edit')
    await writeFile(join(dir, 'canvas.json'), changed)
    const result = await request(`/api/redline/artifacts/${id}/canvas/frames`, move())
    expect(result.status).toBe(409)
    expect(await readFile(join(dir, 'canvas.json'), 'utf8')).toBe(changed)
    expect(await readdir(dir)).toEqual(['canvas.json'])
  })
  it('rejects agent-token and unauthenticated writes; accepts the owner and enforces PATCH', async () => {
    const path = `/api/redline/artifacts/${id}/canvas/frames`
    expect((await request(path, move(), 'agent')).status).toBe(401)
    expect((await request(path, move(), 'none')).status).toBe(401)
    const wrongMethod = await request(path, move(), 'owner', 'POST')
    expect(wrongMethod.status).toBe(405); expect(wrongMethod.setHeader).toHaveBeenCalledWith('Allow', 'PATCH')
    expect((await request(path, move())).status).toBe(200)
    const result = await request(`/api/redline/artifacts/${id}/canvas/sections`, { manifest: 'canvas.json', expectedHash: canvasContentHash(await readFile(join(dir, 'canvas.json'))), statuses: [{ id: 's', status: 'in-progress' }] })
    expect(result.status).toBe(200)
    expect(JSON.parse(result.body).manifest.sections[0].status).toBe('in-progress')
  })
  it('exposes the exact static-file content hash and the authenticated manifest hash', async () => {
    const staticFile = await request(`/redline/artifacts/${id}/canvas.json`, undefined, 'none', 'GET')
    expect(staticFile.headers.ETag).toBe(`"${canvasContentHash(original)}"`)
    expect(staticFile.headers['Access-Control-Expose-Headers']).toBe('ETag')
    const read = await request(`/api/redline/artifacts/${id}/canvas`, undefined, 'agent', 'GET')
    expect(JSON.parse(read.body).contentHash).toBe(canvasContentHash(original))
  })
  it('confines writes to registered artifact paths, including file and directory symlinks', async () => {
    await writeFile(join(outside, 'escape.json'), original)
    await symlink(join(outside, 'escape.json'), join(dir, 'link.json'))
    await symlink(outside, join(dir, 'nested'))
    for (const manifest of ['../escape.json', '/etc/passwd', 'nested/escape.json', 'link.json', 'file%2fescape.json']) {
      const result = await request(`/api/redline/artifacts/${id}/canvas/frames`, { ...move(), manifest })
      expect([400, 404]).toContain(result.status)
    }
    expect((await request('/api/redline/artifacts/0000000000000000/canvas/frames', move())).status).toBe(404)
    expect(await readFile(join(outside, 'escape.json'), 'utf8')).toBe(original)
    await mkdir(join(dir, 'inside')); await writeFile(join(dir, 'inside', 'board.json'), original)
    expect((await request(`/api/redline/artifacts/${id}/canvas/frames`, { ...move(), manifest: 'inside/board.json' })).status).toBe(200)
  })
  it.each([
    { expectedHash: '' }, { moves: [] }, { moves: [{ id: 'missing', x: 0, y: 0 }] },
    { moves: [{ id: 'a', x: '1', y: 0 }] }, { moves: [{ id: 'a', x: 1e10, y: 0 }] },
    { moves: [{ id: 'a', x: 0, y: 0 }, { id: 'a', x: 1, y: 1 }] },
  ])('rejects invalid requests atomically: %j', async (change) => {
    expect((await request(`/api/redline/artifacts/${id}/canvas/frames`, { ...move(), ...change })).status).toBe(400)
    expect(await readFile(join(dir, 'canvas.json'), 'utf8')).toBe(original)
  })
  it('rejects invalid statuses and invalid JSON without writing', async () => {
    expect((await request(`/api/redline/artifacts/${id}/canvas/sections`, { manifest: 'canvas.json', expectedHash: canvasContentHash(original), statuses: [{ id: 's', status: 'bad' }] })).status).toBe(400)
    await writeFile(join(dir, 'canvas.json'), '{')
    expect(() => writeCanvas(artifacts, id, { ...move(), expectedHash: canvasContentHash('{') }, 'frames')).toThrow('Fix manifest errors')
  })
})
