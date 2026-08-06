import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WebPaneFeedbackNote } from '../shared/protocol.js'
import { MAX_QUEUED_FEEDBACK_NOTES, WebPaneFeedbackStore } from './web-pane-feedback.js'
import { WebPaneError } from './web-panes.js'

afterEach(() => {
  vi.useRealTimers()
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
  it('drains queued notes immediately and records the drain', async () => {
    const onDrain = vi.fn()
    const store = new WebPaneFeedbackStore(onDrain, () => 42)
    store.enqueue('w-11111111', [note('a'), note('b')])
    const notes = await store.drain('w-11111111', 0)
    expect(notes.map((entry) => entry.comment)).toEqual(['a', 'b'])
    expect(onDrain).toHaveBeenCalledWith('w-11111111')
    expect(store.info()['w-11111111']).toEqual({ queued: 0, lastDrainCount: 2, lastDrainAt: 42 })
  })

  it('returns empty (and records nothing) when the wait times out', async () => {
    vi.useFakeTimers()
    const onDrain = vi.fn()
    const store = new WebPaneFeedbackStore(onDrain)
    const pending = store.drain('w-11111111', 5_000)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(await pending).toEqual([])
    expect(onDrain).not.toHaveBeenCalled()
    expect(store.info()['w-11111111']).toBeUndefined()
  })

  it('wakes a waiting drain when notes arrive', async () => {
    vi.useFakeTimers()
    const store = new WebPaneFeedbackStore()
    const pending = store.drain('w-11111111', 30_000)
    store.enqueue('w-11111111', [note()])
    expect((await pending).length).toBe(1)
    expect(store.info()['w-11111111']?.queued).toBe(0)
  })

  it('hands a batch to only the first of two concurrent waiters', async () => {
    vi.useFakeTimers()
    const store = new WebPaneFeedbackStore()
    const first = store.drain('w-11111111', 30_000)
    const second = store.drain('w-11111111', 30_000)
    store.enqueue('w-11111111', [note()])
    expect((await first).length).toBe(1)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(await second).toEqual([])
  })

  it('throws 429 past the queue cap', () => {
    const store = new WebPaneFeedbackStore()
    for (let i = 0; i < MAX_QUEUED_FEEDBACK_NOTES; i += 1) store.enqueue('w-11111111', [note()])
    expect(() => store.enqueue('w-11111111', [note()])).toThrowError(WebPaneError)
    try {
      store.enqueue('w-11111111', [note()])
    } catch (error) {
      expect((error as WebPaneError).status).toBe(429)
    }
  })

  it('retain() discards dead panes and rejects their waiters with 404', async () => {
    vi.useFakeTimers()
    const store = new WebPaneFeedbackStore()
    store.enqueue('w-22222222', [note()])
    const waiting = store.drain('w-11111111', 30_000)
    store.retain(new Set(['w-33333333']))
    await expect(waiting).rejects.toMatchObject({ status: 404 })
    expect(store.info()).toEqual({})
  })

  it('an aborted drain resolves empty without recording a drain', async () => {
    vi.useFakeTimers()
    const store = new WebPaneFeedbackStore()
    const controller = new AbortController()
    const pending = store.drain('w-11111111', 30_000, controller.signal)
    controller.abort()
    expect(await pending).toEqual([])
    store.enqueue('w-11111111', [note()])
    expect(store.info()['w-11111111']?.queued).toBe(1)
  })
})
