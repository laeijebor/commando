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
