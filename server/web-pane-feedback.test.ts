import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WebPaneFeedbackNote } from '../shared/protocol.js'
import { FeedbackJournal } from './web-pane-feedback-journal.js'
import { MAX_QUEUED_FEEDBACK_NOTES, WebPaneFeedbackStore } from './web-pane-feedback.js'
import { WebPaneError } from './web-panes.js'

const dirs: string[] = []

function makeStore(options: { onDrain?: (id: string) => void; now?: () => number; dir?: string } = {}) {
  const dir = options.dir ?? mkdtempSync(join(tmpdir(), 'commando-feedback-store-'))
  if (!options.dir) dirs.push(dir)
  return {
    dir,
    store: new WebPaneFeedbackStore(new FeedbackJournal({ dir }), options.onDrain, options.now),
  }
}

afterEach(() => {
  vi.useRealTimers()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function note(comment = 'too cramped'): WebPaneFeedbackNote {
  return {
    selector: '#root > button',
    tag: 'button',
    rect: { x: 1, y: 2, width: 30, height: 10 },
    comment,
    pageUrl: 'http://127.0.0.1:5173/',
    capturedAt: 1_000,
  }
}

describe('WebPaneFeedbackStore', () => {
  it('drains queued notes immediately with ids and a cursor, and records the drain', async () => {
    const onDrain = vi.fn()
    const { store } = makeStore({ onDrain, now: () => 42 })
    store.enqueue('w-11111111', [note('a'), note('b')])
    const result = await store.drain('w-11111111', 0)
    expect(result.notes.map((entry) => entry.comment)).toEqual(['a', 'b'])
    expect(result.notes.map((entry) => entry.id)).toEqual([1, 2])
    expect(result.cursor).toBe(2)
    expect(onDrain).toHaveBeenCalledWith('w-11111111')
    expect(store.info()['w-11111111']).toEqual({ queued: 0, lastDrainCount: 2, lastDrainAt: 42 })
  })

  it('redelivers unacked notes to a retry (the lost-response case)', async () => {
    const { store } = makeStore()
    store.enqueue('w-11111111', [note('a')])
    const first = await store.drain('w-11111111', 0)
    // The response never reached the agent; its retry has no new cursor.
    const retry = await store.drain('w-11111111', 0)
    expect(retry.notes.map((entry) => entry.comment)).toEqual(['a'])
    expect(retry.cursor).toBe(first.cursor)
  })

  it('drops notes once the cursor comes back, then waits for new ones', async () => {
    vi.useFakeTimers()
    const { store } = makeStore()
    store.enqueue('w-11111111', [note('a')])
    const { cursor } = await store.drain('w-11111111', 0)
    const pending = store.drain('w-11111111', 5_000, { cursor })
    await vi.advanceTimersByTimeAsync(5_000)
    expect((await pending).notes).toEqual([])
  })

  it('clamps acks to what was delivered — a wild cursor cannot discard unseen answers', async () => {
    const { store } = makeStore()
    store.enqueue('w-11111111', [note('a')])
    await store.drain('w-11111111', 0)
    store.enqueue('w-11111111', [note('b')])
    const result = await store.drain('w-11111111', 0, { cursor: 999 })
    expect(result.notes.map((entry) => entry.comment)).toEqual(['b'])
  })

  it('survives a restart: a fresh store over the same journal re-offers the backlog', async () => {
    const { store, dir } = makeStore()
    store.enqueue('w-11111111', [note('kept')])
    await store.drain('w-11111111', 0)
    const { store: reborn } = makeStore({ dir })
    const result = await reborn.drain('w-11111111', 0)
    expect(result.notes.map((entry) => entry.comment)).toEqual(['kept'])
    expect(result.notes[0]?.id).toBe(1)
  })

  it('keeps answers for closed tiles: retain() drops memory, not the journal', async () => {
    const { store } = makeStore()
    store.enqueue('w-22222222', [note('after close')])
    store.retain(new Set(['w-33333333']))
    expect(store.info()).toEqual({})
    expect(store.hasUnacked('w-22222222')).toBe(true)
    const result = await store.drain('w-22222222', 0)
    expect(result.notes.map((entry) => entry.comment)).toEqual(['after close'])
    await store.drain('w-22222222', 0, { cursor: result.cursor })
    expect(store.hasUnacked('w-22222222')).toBe(false)
  })

  it('returns empty (and records nothing) when the wait times out', async () => {
    vi.useFakeTimers()
    const onDrain = vi.fn()
    const { store } = makeStore({ onDrain })
    const pending = store.drain('w-11111111', 5_000)
    await vi.advanceTimersByTimeAsync(5_000)
    expect((await pending).notes).toEqual([])
    expect(onDrain).not.toHaveBeenCalled()
    expect(store.info()['w-11111111']).toBeUndefined()
  })

  it('wakes a waiting drain when notes arrive', async () => {
    vi.useFakeTimers()
    const { store } = makeStore()
    const pending = store.drain('w-11111111', 30_000)
    store.enqueue('w-11111111', [note()])
    expect((await pending).notes.length).toBe(1)
    expect(store.info()['w-11111111']?.queued).toBe(0)
  })

  it('hands a batch to only the first of two concurrent waiters', async () => {
    vi.useFakeTimers()
    const { store } = makeStore()
    const first = store.drain('w-11111111', 30_000)
    const second = store.drain('w-11111111', 30_000)
    store.enqueue('w-11111111', [note()])
    expect((await first).notes.length).toBe(1)
    await vi.advanceTimersByTimeAsync(30_000)
    expect((await second).notes).toEqual([])
  })

  it('throws 429 when undelivered notes pass the cap, but delivered-unacked notes do not count', async () => {
    const { store } = makeStore()
    for (let i = 0; i < MAX_QUEUED_FEEDBACK_NOTES; i += 1) store.enqueue('w-11111111', [note()])
    expect(() => store.enqueue('w-11111111', [note()])).toThrowError(WebPaneError)
    try {
      store.enqueue('w-11111111', [note()])
    } catch (error) {
      expect((error as WebPaneError).status).toBe(429)
    }
    // Delivery clears the undelivered window even though nothing is acked yet.
    await store.drain('w-11111111', 0)
    expect(() => store.enqueue('w-11111111', [note('post-drain')])).not.toThrow()
  })

  it('retain() rejects waiters for dead panes with 404', async () => {
    vi.useFakeTimers()
    const { store } = makeStore()
    const waiting = store.drain('w-11111111', 30_000)
    store.retain(new Set(['w-33333333']))
    await expect(waiting).rejects.toMatchObject({ status: 404 })
  })

  it('an aborted drain resolves empty without recording a drain', async () => {
    vi.useFakeTimers()
    const { store } = makeStore()
    const controller = new AbortController()
    const pending = store.drain('w-11111111', 30_000, { signal: controller.signal })
    controller.abort()
    expect((await pending).notes).toEqual([])
    store.enqueue('w-11111111', [note()])
    expect(store.info()['w-11111111']?.queued).toBe(1)
  })
})
