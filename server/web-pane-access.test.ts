import { EventEmitter } from 'node:events'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WebPane } from '../shared/protocol.js'
import { ChromiumEngine } from './chromium-engine.js'
import type { WebPaneService } from './web-panes.js'
import type { WebSocket } from 'ws'
import { RedlineArtifactRegistry } from './redline-artifacts.js'
import { PendingNotesJournal, WebPanePendingStore } from './web-pane-pending.js'
import { createPageResponseHandler, invalidateRestoredWebPane, isReadOnlyArtifactPane, isReadOnlyArtifactUrl } from './web-pane-access.js'
import { WebTileRelay } from './web-tile-relay.js'

const dirs: string[] = []
function temp() { const dir = mkdtempSync(join(tmpdir(), 'board-access-')); dirs.push(dir); return dir }
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
function pane(url: string): WebPane { return { id: 'w-12345678', url, engine: 'chromium', status: 'open', anchorPaneId: '%1', sessionId: '$1', windowId: '@1', placement: 'right', openedBy: 'user', createdAt: 1 } }
const answer = { question: 'Ship?', answer: 'Yes', queueKey: 'ship' }

it.each(['pane', 'registry', 'page-url'] as const)('rejects SDK answers protected by %s before journaling, including without a viewer', (protection) => {
  const registry = new RedlineArtifactRegistry(), id = registry.register(temp(), true).id
  const savedUrl = `http://localhost/redline/artifacts/${id}/index.html`
  const tab = pane(protection === 'registry' ? savedUrl : 'http://localhost/live')
  if (protection === 'pane') tab.readOnly = true
  const journalDir = temp(), pending = new WebPanePendingStore(new PendingNotesJournal({ dir: journalDir })), publish = vi.fn()
  const receive = createPageResponseHandler({ pane: () => tab, readOnlyArtifact: (id) => registry.isReadOnly(id), pending, publish })
  receive(tab.id, answer, protection === 'page-url' ? savedUrl : tab.url)
  expect(pending.list(tab.id)).toEqual([])
  expect(readdirSync(journalDir)).toEqual([])
  expect(publish).not.toHaveBeenCalled()
})

it('queues and publishes SDK answers again on the restored editable page', () => {
  const tab = pane('http://localhost/restored')
  const pending = new WebPanePendingStore(new PendingNotesJournal({ dir: temp() })), publish = vi.fn()
  const receive = createPageResponseHandler({ pane: () => tab, readOnlyArtifact: () => false, pending, publish })
  receive(tab.id, answer, tab.url)
  expect(pending.list(tab.id)[0]).toMatchObject({ pageUrl: tab.url, response: { question: 'Ship?', answer: 'Yes' } })
  expect(publish).toHaveBeenCalledOnce()
})

it('protects the pending journal itself for snapshot aliases and tabs whose flags were lost', () => {
  const registry = new RedlineArtifactRegistry(), id = registry.register(temp(), true).id
  const url = `http://localhost/redline/artifacts/${id}/index.html`, dir = temp()
  const pending = new WebPanePendingStore(new PendingNotesJournal({ dir }), undefined, undefined, (_id, url) => !isReadOnlyArtifactUrl(url, (id) => registry.isReadOnly(id)))
  expect(() => pending.addResponse('w-12345678', url, answer)).toThrow('read-only')
  expect(() => pending.addNote('w-12345678', 'http://localhost/live', { selector: 'html', tag: 'main', rect: { x: 0, y: 0, width: 1, height: 1 }, comment: 'Restored answer', response: answer, pageUrl: url })).toThrow('read-only')
  expect(() => pending.setPage('w-12345678', url)).toThrow('read-only')
  expect(() => pending.adopt('w-12345678', url, new Set())).toThrow('read-only')
  expect(pending.list('w-12345678')).toEqual([])
  expect(readdirSync(dir)).toEqual([])
})

it('does not update or send answers after an artifact becomes read-only', () => {
  let readOnly = false
  const pending = new WebPanePendingStore(new PendingNotesJournal({ dir: temp() }), undefined, undefined, () => !readOnly)
  pending.addResponse('w-12345678', 'http://localhost/page', answer)
  const before = pending.snapshot('w-12345678'), enqueue = vi.fn()
  readOnly = true
  expect(() => pending.update('w-12345678', before.notes[0].id, before.notes[0].revision!, { answer: 'No' })).toThrow('read-only')
  expect(() => pending.send('w-12345678', 'http://localhost/page', 1, enqueue)).toThrow('read-only')
  expect(pending.snapshot('w-12345678')).toEqual(before)
  expect(enqueue).not.toHaveBeenCalled()
})

it('invalidates the old engine target, pending hydration and tile streams on restore', () => {
  const engine = { clearPendingSnapshot: vi.fn(), closeTile: vi.fn() }, relay = { dropTile: vi.fn() }
  const restored = pane('http://localhost/restored/index.html')
  invalidateRestoredWebPane(engine, relay, restored)
  expect(engine.closeTile).toHaveBeenCalledWith(restored.id)
  expect(engine.clearPendingSnapshot).toHaveBeenCalledWith(restored.id)
  expect(relay.dropTile).toHaveBeenCalledWith(restored.id)
})

describe('saved tile streams without opening sockets', () => {
  it.each(['pane', 'registry'] as const)('blocks stream/review connect and every input ingress using %s protection', (protection) => {
    const registry = new RedlineArtifactRegistry(), artifactId = registry.register(temp(), true).id
    const tab = pane(`http://localhost/redline/artifacts/${artifactId}/index.html`)
    if (protection === 'pane') tab.readOnly = true
    const readOnlyArtifact = protection === 'registry' ? (id: string) => registry.isReadOnly(id) : () => false
    expect(isReadOnlyArtifactPane(tab, readOnlyArtifact)).toBe(true)
    const engine = { subscribeScreencast: vi.fn(), updatePendingSnapshot: vi.fn(), dispatchInput: vi.fn(), reload: vi.fn(), setViewport: vi.fn(), inspectAt: vi.fn(), resolveSelectors: vi.fn(), readSelection: vi.fn() }
    const relay = new WebTileRelay({ engine: engine as unknown as ChromiumEngine, service: { get: () => tab } as unknown as WebPaneService, readOnlyArtifact, pendingNotes: () => ({ notes: [], knownUpTo: 0, dropped: 0 }) })
    const internal = relay as unknown as { connect: (socket: WebSocket, id: string, review: boolean) => void; receive: (socket: WebSocket, id: string, data: Buffer) => void }
    try {
      for (const review of [false, true]) {
        const socket = Object.assign(new EventEmitter(), { close: vi.fn(), send: vi.fn(), readyState: 1 })
        internal.connect(socket as unknown as WebSocket, tab.id, review)
        expect(socket.close).toHaveBeenCalledOnce()
        for (const type of ['input', 'viewport', 'reload', 'inspect', 'selection']) internal.receive(socket as unknown as WebSocket, tab.id, Buffer.from(JSON.stringify({ type, event: { type: 'keyDown', key: 'Enter' }, width: 800, height: 600, deviceScaleFactor: 1 })))
      }
      for (const method of Object.values(engine)) expect(method).not.toHaveBeenCalled()
    } finally { relay.close() }
  })
})

it('recreates an actual ChromiumEngine cached target at the restored URL without launching a browser', async () => {
  const engine = new ChromiumEngine({ classify: (url) => ({ kind: 'open', url, origin: new URL(url).origin }), onExternalNavigation: () => {} })
  type Cached = { webPaneId: string; currentUrl: string; wsUrl: string; devtoolsFrontendUrl: string; lastUsed: number; cdp: { close: ReturnType<typeof vi.fn>; sendAndForget: ReturnType<typeof vi.fn> } }
  const state = engine as unknown as { tiles: Map<string, Cached>; createTarget: (id: string, url: string, frame: unknown) => Promise<Cached> }
  const makeTarget = (id: string, url: string): Cached => ({ webPaneId: id, currentUrl: url, wsUrl: `ws://${new URL(url).host}`, devtoolsFrontendUrl: url, lastUsed: 0, cdp: { close: vi.fn(), sendAndForget: vi.fn() } })
  const old = makeTarget('w-12345678', 'http://snapshot.local/index.html')
  state.tiles.set(old.webPaneId, old)
  const create = vi.spyOn(state, 'createTarget').mockImplementation(async (id, url) => { const target = makeTarget(id, url); state.tiles.set(id, target); return target })
  const restored = pane('http://restored.local/index.html'), relay = { dropTile: vi.fn() }
  try {
    // An unchanged id would otherwise return the old cached target regardless of the URL argument.
    expect((await engine.cdpInfo(restored.id, restored.url)).devtoolsFrontendUrl).toBe(old.currentUrl)
    invalidateRestoredWebPane(engine, relay, restored)
    expect(old.cdp.close).toHaveBeenCalledOnce()
    expect((await engine.cdpInfo(restored.id, restored.url)).devtoolsFrontendUrl).toBe(restored.url)
    expect(create).toHaveBeenCalledWith(restored.id, restored.url, null)
  } finally { engine.dispose() }
})
