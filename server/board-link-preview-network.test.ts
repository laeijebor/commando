import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetSocketState, socketState } from './board-pinned-socket-test-fixture.js'
vi.mock('node:http', async () => ({ request: (await import('./board-pinned-socket-test-fixture.js')).stubPinnedRequest }))
vi.mock('node:https', async () => ({ request: (await import('./board-pinned-socket-test-fixture.js')).stubPinnedRequest }))
import { BoardLinkPreviews } from './board-link-previews.js'
import { BoardThumbCache } from './board-thumbs.js'
import { BoardStore } from './boards.js'

const target = '00000000-0000-4000-8000-000000000001'
let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'board-link-pinned-network-')); resetSocketState()
  socketState.response = (url) => url.pathname === '/favicon.ico'
    ? { status: 404, body: Buffer.alloc(0), rawHeaders: ['Content-Type', 'image/png'] }
    : { status: 200, body: Buffer.from('<title>Pinned preview</title>'), rawHeaders: ['Content-Type', 'text/html'] }
})
afterEach(async () => { await rm(root, { recursive: true, force: true }); vi.restoreAllMocks() })

function setup(url: string) {
  let now = 0, approved = '93.184.216.34'
  const store = new BoardStore(), thumbs = new BoardThumbCache({ root: join(root, 'thumbs'), origin: 'http://127.0.0.1:4491', platform: 'linux' })
  vi.spyOn(thumbs, 'page').mockResolvedValue(undefined)
  const previews = new BoardLinkPreviews({ store, thumbs, statePath: join(root, 'previews.json'), now: () => now, resolve: async () => [{ address: approved, family: 4 }] })
  const item = store.upsert(target, { key: `url:${url}`, kind: 'link', title: 'Link', ref: { url }, source: 'user' })
  return { store, item, previews, nextAddress: (address: string) => { approved = address; now += 7 * 86400_000 + 1 } }
}

describe('link preview pinned downloader (stub sockets)', () => {
  it.each(['http:', 'https:'])('does not reuse %s sockets when the same URL resolves to a different approved address', async (protocol) => {
    const s = setup(`${protocol}//public.example/app`)
    await s.previews.refresh(target, s.item)
    expect(s.store.item(target, s.item.key).preview?.title).toBe('Pinned preview')
    const previousCalls = socketState.calls.length
    expect(previousCalls).toBe(2) // HTML and fallback favicon.
    s.nextAddress('142.250.185.78')
    await s.previews.refresh(target, s.item)
    expect(socketState.calls).toHaveLength(4)
    expect(socketState.calls.every((call) => call.options.agent === false)).toBe(true)
    expect(socketState.calls.slice(previousCalls).every((call) => call.lookupAddress === '142.250.185.78' && call.socket?.remoteAddress === '142.250.185.78')).toBe(true)
    expect(new Set(socketState.calls.map((call) => call.socket)).size).toBe(4)
  })
  it.each(['http:', 'https:'])('aborts a mismatched %s peer before sending or accepting preview data', async (protocol) => {
    const s = setup(`${protocol}//public.example/app`)
    socketState.remoteAddress = '10.0.0.8'
    await s.previews.refresh(target, s.item)
    expect(socketState.calls).toHaveLength(1)
    expect(socketState.calls[0].sent).toBe(false)
    expect(socketState.calls[0].socket?.destroyed).toBe(true)
    expect(s.store.item(target, s.item.key).preview).toBeUndefined()
  })
})
