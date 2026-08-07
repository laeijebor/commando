import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createInspectThrottle,
  queueNote,
  removeNote,
  removeSentNotes,
  toFeedbackNotes,
} from './tileReview'

afterEach(() => {
  vi.useRealTimers()
})

const inspect = {
  ok: true as const,
  selector: '#root > button',
  tag: 'button',
  rect: { x: 1, y: 2, width: 30, height: 10 },
  text: 'Go',
}

describe('review note queue', () => {
  it('queues, removes, and converts to feedback notes', () => {
    let list = queueNote([], inspect, 'too small', 1)
    list = queueNote(list, { ...inspect, selector: '#other' }, 'wrong color', 2)
    expect(list).toHaveLength(2)
    list = removeNote(list, 1)
    expect(list).toEqual([expect.objectContaining({ id: 2, selector: '#other' })])
    expect(toFeedbackNotes(list, 'http://127.0.0.1:5173/', 999)).toEqual([
      {
        selector: '#other',
        tag: 'button',
        text: 'Go',
        rect: { x: 1, y: 2, width: 30, height: 10 },
        comment: 'wrong color',
        pageUrl: 'http://127.0.0.1:5173/',
        capturedAt: 999,
      },
    ])
  })

  it('keeps notes queued during an in-flight send', () => {
    const batch = queueNote([], inspect, 'too small', 1)
    // The user queues another note while the send is still in flight.
    const afterSend = queueNote(batch, { ...inspect, selector: '#late' }, 'added later', 2)
    expect(removeSentNotes(afterSend, batch)).toEqual([
      expect.objectContaining({ id: 2, selector: '#late' }),
    ])
  })

  it('removes every sent note when nothing was queued meanwhile', () => {
    let list = queueNote([], inspect, 'a', 1)
    list = queueNote(list, inspect, 'b', 2)
    expect(removeSentNotes(list, list)).toEqual([])
  })
})

describe('createInspectThrottle', () => {
  it('fires immediately, then collapses to a trailing latest-wins call', () => {
    vi.useFakeTimers()
    const send = vi.fn()
    const throttle = createInspectThrottle(send, 50)
    throttle.schedule(1, 1)
    throttle.schedule(2, 2)
    throttle.schedule(3, 3)
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith(1, 1)
    vi.advanceTimersByTime(50)
    expect(send).toHaveBeenCalledTimes(2)
    expect(send).toHaveBeenLastCalledWith(3, 3)
  })

  it('dispose cancels the trailing call', () => {
    vi.useFakeTimers()
    const send = vi.fn()
    const throttle = createInspectThrottle(send, 50)
    throttle.schedule(1, 1)
    throttle.schedule(2, 2)
    throttle.dispose()
    vi.advanceTimersByTime(100)
    expect(send).toHaveBeenCalledTimes(1)
  })
})
