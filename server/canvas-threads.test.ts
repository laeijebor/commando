import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WebPaneFeedbackNote } from '../shared/protocol.js'
import { CanvasThreadsStore, defaultCanvasThreadsPath } from './canvas-threads.js'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'canvas-threads-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })
const note: WebPaneFeedbackNote = { selector: '#row', tag: 'button', rect: { x: 2, y: 3, width: 10, height: 20 }, comment: 'Fix row', pageUrl: 'http://localhost/Settings.html', capturedAt: 100,
  deliveryKey: 'delivery', reviewKey: 'pending:w-12345678:1', canvas: { frameId: 'settings', point: { x: 5, y: 7 }, label: 'Row', labelId: 'row' } }
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
