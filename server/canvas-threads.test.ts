import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WebPaneFeedbackNote } from '../shared/protocol.js'
import { CanvasThreadsStore, defaultCanvasThreadsPath } from './canvas-threads.js'
import { WebPaneService } from './web-panes.js'

let dir: string
const paneServices: WebPaneService[] = []
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'canvas-threads-')) })
afterEach(async () => {
  await Promise.all(paneServices.splice(0).map((service) => service.flush()))
  rmSync(dir, { recursive: true, force: true })
})
const note: WebPaneFeedbackNote = { selector: '#row', tag: 'button', rect: { x: 2, y: 3, width: 10, height: 20 }, comment: 'Fix row', pageUrl: 'http://localhost/Settings.html', capturedAt: 100,
  deliveryKey: 'delivery', reviewKey: 'pending:w-12345678:1', canvas: { frameId: 'settings', point: { x: 5, y: 7 }, label: 'Row', labelId: 'row' } }

describe('canvas threads for conversation-owned tabs', () => {
  const anchor = { anchorPaneId: '%12', sessionId: '$1', windowId: '@3', openedBy: 'agent' as const }
  const destination = { anchorPaneId: '%40', sessionId: '$2', windowId: '@9' }
  const survivingWindow = [{ id: '@3', sessionId: '$1', paneIds: ['%13'] }]
  const content = { kind: 'canvas' as const, artifactId: '0123456789abcdef', manifest: 'canvas.json' }
  const resolve = () => ({ provider: 'claude' as const, id: 'conversation-123' })
  const serviceAt = (now: () => number) => {
    const service = new WebPaneService(join(dir, 'panes.json'), now, undefined, 'owner', resolve)
    paneServices.push(service)
    return service
  }
  // The daemon uses this union both when publishing changes and on startup.
  const retain = (store: CanvasThreadsStore, service: WebPaneService) =>
    store.retain(new Set([...service.list().map((pane) => pane.id), ...service.parkedIds()]))

  it('keeps discussions through park, restart and restore, then releases them at the parked TTL', async () => {
    let now = 1_000
    const service = serviceAt(() => now)
    const path = join(dir, 'threads.json')
    const store = new CanvasThreadsStore(path)
    const tab = service.open({ ...anchor, url: 'http://localhost/canvas', content })
    store.record(tab.id, [note])
    store.reply(tab.id, store.list(tab.id)[0].id, 'Kept reply', true)
    const discussion = store.list(tab.id)
    service.prune(survivingWindow)
    expect(service.list()).toEqual([])
    expect(service.parkedIds()).toEqual([tab.id])
    retain(store, service)
    expect(store.list(tab.id)).toEqual(discussion)
    await service.flush()
    const loaded = serviceAt(() => now)
    await loaded.load()
    const restoredStore = new CanvasThreadsStore(path)
    retain(restoredStore, loaded)
    expect(restoredStore.list(tab.id)).toEqual(discussion)
    expect(loaded.reconcileAgentSession(destination)).toBe(true)
    expect(loaded.parkedIds()).toEqual([])
    retain(restoredStore, loaded)
    expect(loaded.get(tab.id)?.anchorPaneId).toBe(destination.anchorPaneId)
    expect(restoredStore.list(tab.id)).toEqual(discussion)
    loaded.prune(survivingWindow)
    now += 30 * 24 * 60 * 60 * 1_000
    expect(loaded.prune(survivingWindow)).toBe(true)
    expect(loaded.parkedIds()).toEqual([])
    retain(restoredStore, loaded)
    expect(new CanvasThreadsStore(path).list(tab.id)).toEqual([])
  })

  it('releases only the oldest discussion when parking exceeds the cap', async () => {
    let now = 1_000
    const service = serviceAt(() => now)
    const tab = service.open({ ...anchor, url: 'http://localhost/canvas', content })
    service.prune(survivingWindow)
    await service.flush()
    const state = JSON.parse(readFileSync(service.statePath, 'utf8'))
    const oldest = state.parkedPanes[0]
    oldest.parkedAt = 1
    state.parkedPanes.push(...Array.from({ length: 299 }, (_, index) => ({
      pane: { ...oldest.pane, id: `w-${index.toString(16).padStart(8, '0')}` }, parkedAt: index + 2,
    })))
    writeFileSync(service.statePath, JSON.stringify(state))
    const loaded = serviceAt(() => now)
    await loaded.load()
    const path = join(dir, 'threads.json'), store = new CanvasThreadsStore(path)
    const keptId = state.parkedPanes[299].pane.id
    store.record(tab.id, [note])
    store.record(keptId, [note])
    retain(store, loaded)
    expect(store.list(tab.id)).toHaveLength(1)
    now++
    const newest = loaded.open({ ...anchor, url: 'http://localhost/new', content })
    store.record(newest.id, [note])
    loaded.prune(survivingWindow)
    expect(loaded.parkedIds()).toHaveLength(300)
    expect(loaded.parkedIds()).not.toContain(tab.id)
    retain(store, loaded)
    const restoredStore = new CanvasThreadsStore(path)
    expect(restoredStore.list(tab.id)).toEqual([])
    expect(restoredStore.list(keptId)).toHaveLength(1)
    expect(restoredStore.list(newest.id)).toHaveLength(1)
  })
})

describe('CanvasThreadsStore', () => {
  it('persists sent pins, deduplicates retries across restart and preserves them after feedback acknowledgement', () => {
    const path = join(dir, 'threads.json'), changed = vi.fn(), store = new CanvasThreadsStore(path, changed)
    store.record('w-12345678', [note, { ...note, canvas: undefined }])
    const threads = store.list('w-12345678')
    expect(threads).toHaveLength(1)
    expect(threads[0]).toMatchObject({ webPaneId: 'w-12345678', frameId: 'settings', point: { x: 5, y: 7 }, label: 'Row', labelId: 'row', selector: '#row', status: 'open', createdAt: 100, messages: [{ author: 'user', text: 'Fix row', at: 100 }] })
    threads[0].messages[0].text = 'Mutation'
    expect(store.list('w-12345678')[0].messages[0].text).toBe('Fix row')
    const restored = new CanvasThreadsStore(path, changed)
    restored.record('w-12345678', [{ ...note, deliveryKey: 'new-intent' }])
    expect(restored.list('w-12345678')).toHaveLength(1)
    expect(changed).toHaveBeenCalledOnce()
  })
  it('persists two authors, resolved status and reply delivery dedupe across restart', () => {
    const path = join(dir, 'threads.json'), store = new CanvasThreadsStore(path)
    const prepared = store.prepare('w-12345678', [note])
    store.record('w-12345678', prepared)
    const id = prepared[0].canvas!.threadId!
    store.reply('w-12345678', id, 'Fixed', true)
    const restored = new CanvasThreadsStore(path)
    expect(restored.get('w-12345678', id)).toMatchObject({ status: 'resolved', canvas: { threadId: id }, messages: [{ author: 'user' }, { author: 'agent', text: 'Fixed' }] })
    const followup = { ...note, comment: 'More', reviewKey: 'reply', deliveryKey: 'reply-delivery', canvas: { ...note.canvas!, threadId: id } }
    restored.record('w-12345678', restored.prepare('w-12345678', [followup]))
    restored.record('w-12345678', [followup])
    expect(restored.get('w-12345678', id).messages).toHaveLength(3)
    expect(restored.get('w-12345678', id).status).toBe('open')
    expect(() => restored.get('w-other', id)).toThrow('Thread does not exist')
    restored.status('w-12345678', id, 'resolved')
    expect(new CanvasThreadsStore(path).get('w-12345678', id).status).toBe('resolved')
    // Pin retries with a different delivery intent do not add a conversation message.
    restored.record('w-12345678', restored.prepare('w-12345678', [{ ...note, deliveryKey: 'new-intent' }]))
    expect(restored.get('w-12345678', id).messages).toHaveLength(3)
  })
  it('preserves legacy whitespace-only pin comments while rejecting empty agent replies', () => {
    const path = join(dir, 'threads.json'), store = new CanvasThreadsStore(path)
    store.record('w-12345678', [{ ...note, comment: ' ' }])
    const restored = new CanvasThreadsStore(path), thread = restored.list('w-12345678')[0]
    expect(thread.messages[0].text).toBe(' ')
    expect(() => restored.reply('w-12345678', thread.id, ' ')).toThrow('4096')
  })
  it('preflights the batch message cap and deduplicates reply keys', () => {
    const path = join(dir, 'threads.json'), store = new CanvasThreadsStore(path)
    store.record('w-12345678', [note])
    const thread = store.list('w-12345678')[0]
    writeFileSync(path, JSON.stringify([{ ...thread, messages: Array(199).fill(thread.messages[0]) }]))
    const full = new CanvasThreadsStore(path)
    const reply = { ...note, reviewKey: 'reply', deliveryKey: 'reply-delivery', canvas: { ...note.canvas!, threadId: thread.id } }
    expect(() => full.prepare('w-12345678', [reply, { ...reply, deliveryKey: 'other' }])).toThrow('200 message limit')
    expect(full.prepare('w-12345678', [reply, reply])).toHaveLength(2)
    full.record('w-12345678', [reply, reply])
    expect(full.get('w-12345678', thread.id).messages).toHaveLength(200)
    expect(() => full.reply('w-12345678', thread.id, 'Another')).toThrow('200 message limit')
    expect(() => full.reply('w-12345678', thread.id, 'x'.repeat(4097))).toThrow('4096')
  })
  it('rejects malformed persisted authors/statuses and message overflow', () => {
    const path = join(dir, 'threads.json'), store = new CanvasThreadsStore(path)
    store.record('w-12345678', [note])
    const valid = store.list('w-12345678')[0]
    for (const change of [{ status: 'replied' }, { messages: [{ author: 'system', text: 'Bad', at: 1 }] },
      { messages: [{ author: 'agent', text: 'x'.repeat(4097), at: 1 }] }, { messages: Array(201).fill(valid.messages[0]) }]) {
      writeFileSync(path, JSON.stringify([{ ...valid, ...change }]))
      expect(new CanvasThreadsStore(path).list('w-12345678')).toEqual([])
    }
    writeFileSync(path, JSON.stringify([{ ...valid, status: 'resolved', messages: Array(200).fill(valid.messages[0]) }]))
    expect(new CanvasThreadsStore(path).list('w-12345678')[0].messages).toHaveLength(200)
  })
  it('prunes closed panes durably and broadcasts only changes', () => {
    const path = join(dir, 'threads.json'), changed = vi.fn(), store = new CanvasThreadsStore(path, changed)
    store.record('w-12345678', [note]); store.record('w-87654321', [note])
    changed.mockClear()
    store.retain(new Set(['w-12345678']))
    store.retain(new Set(['w-12345678']))
    expect(changed).toHaveBeenCalledExactlyOnceWith('w-87654321')
    expect(new CanvasThreadsStore(path).list('w-87654321')).toEqual([])
    expect(new CanvasThreadsStore(path).list('w-12345678')).toHaveLength(1)
  })
  it('handles missing/corrupt JSON and skips malformed persisted entries', () => {
    const path = join(dir, 'threads.json')
    expect(new CanvasThreadsStore(path).list('w-12345678')).toEqual([])
    writeFileSync(path, '{')
    expect(new CanvasThreadsStore(path).list('w-12345678')).toEqual([])
    writeFileSync(path, JSON.stringify([null, {}, { id: 'bad' }]))
    expect(new CanvasThreadsStore(path).list('w-12345678')).toEqual([])
    expect(defaultCanvasThreadsPath(4410)).toMatch(/canvas-threads-4410\.json$/)
    expect(defaultCanvasThreadsPath(4410)).not.toBe(defaultCanvasThreadsPath(4310))
  })
})

it('caps each pane at 500 threads, evicting oldest resolved before oldest open', () => {
  const store = new CanvasThreadsStore(join(dir, 'bounded.json'))
  const notes = Array.from({ length: 500 }, (_, i) => ({ ...note, deliveryKey: String(i), reviewKey: String(i), capturedAt: i }))
  store.record('w-1', store.prepare('w-1', notes))
  const resolved = store.list('w-1')[100]; store.status('w-1', resolved.id, 'resolved')
  store.record('w-1', store.prepare('w-1', [{ ...note, deliveryKey: 'next', reviewKey: 'next', capturedAt: 501 }]))
  expect(store.list('w-1')).toHaveLength(500)
  expect(store.list('w-1').some((t) => t.id === resolved.id)).toBe(false)
  store.record('w-1', store.prepare('w-1', [{ ...note, deliveryKey: 'last', reviewKey: 'last', capturedAt: 502 }]))
  expect(store.list('w-1').some((t) => t.createdAt === 0)).toBe(false)
})
it('bounds total serialized state on write and load', () => {
  const path = join(dir, 'bytes.json'), store = new CanvasThreadsStore(path)
  const notes = Array.from({ length: 30 }, (_, i) => ({ ...note, reviewKey: String(i), deliveryKey: String(i), text: 'x'.repeat(800000), capturedAt: i }))
  store.record('w-1', store.prepare('w-1', notes))
  expect(store.list('w-1').length).toBeLessThan(30)
  expect(new CanvasThreadsStore(path).list('w-1').length).toBe(store.list('w-1').length)
  writeFileSync(path, ' '.repeat(17 * 1024 * 1024))
  expect(new CanvasThreadsStore(path).list('w-1')).toEqual([])
})
