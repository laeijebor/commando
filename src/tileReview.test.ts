import { afterEach, describe, expect, it, vi } from 'vitest'
import { MAX_FEEDBACK_NOTES_PER_POST } from '../shared/protocol'
import {
  chunkNotes,
  createInspectThrottle,
  MAX_QUEUED_PILLS,
  queueNote,
  queuePageResponse,
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

describe('chunkNotes', () => {
  it('returns an empty array for an empty queue', () => {
    expect(chunkNotes([])).toEqual([])
  })

  it('keeps a queue at or under the chunk size in a single chunk', () => {
    let list = queueNote([], inspect, 'a', 1)
    list = queueNote(list, inspect, 'b', 2)
    expect(chunkNotes(list)).toEqual([list])
  })

  it('splits into groups no larger than MAX_FEEDBACK_NOTES_PER_POST by default', () => {
    let list: ReturnType<typeof queueNote> = []
    for (let index = 0; index < MAX_FEEDBACK_NOTES_PER_POST * 2 + 3; index += 1) {
      list = queueNote(list, inspect, `note ${index}`, index)
    }
    const chunks = chunkNotes(list)
    expect(chunks).toHaveLength(3)
    expect(chunks[0]).toHaveLength(MAX_FEEDBACK_NOTES_PER_POST)
    expect(chunks[1]).toHaveLength(MAX_FEEDBACK_NOTES_PER_POST)
    expect(chunks[2]).toHaveLength(3)
    // Order is preserved across chunk boundaries.
    expect(chunks.flat()).toEqual(list)
  })

  it('honors a custom chunk size', () => {
    let list = queueNote([], inspect, 'a', 1)
    list = queueNote(list, inspect, 'b', 2)
    list = queueNote(list, inspect, 'c', 3)
    expect(chunkNotes(list, 2)).toEqual([
      [list[0], list[1]],
      [list[2]],
    ])
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

describe('queuePageResponse', () => {
  const response = { question: 'Which plan?', answer: 'Pro', queueKey: 'plan' }

  it('appends a pill note with a readable comment', () => {
    const list = queuePageResponse([], response, 1)
    expect(list).toHaveLength(1)
    expect(list[0].comment).toBe('Which plan?: Pro')
    expect(list[0].response).toEqual({ question: 'Which plan?', answer: 'Pro' })
    expect(list[0].queueKey).toBe('plan')
    expect(list[0].selector).toBe('redline:plan')
    expect(list[0].tag).toBe('redline')
  })

  it('uses page-provided selector/tag/rect when present', () => {
    const list = queuePageResponse(
      [],
      { ...response, selector: '#picker', tag: 'redline-choice', rect: { x: 1, y: 2, width: 3, height: 4 } },
      1,
    )
    expect(list[0].selector).toBe('#picker')
    expect(list[0].tag).toBe('redline-choice')
    expect(list[0].rect).toEqual({ x: 1, y: 2, width: 3, height: 4 })
  })

  it('replaces an unsent answer with the same queueKey', () => {
    const first = queuePageResponse([], response, 1)
    const second = queuePageResponse(first, { ...response, answer: 'Starter' }, 2)
    expect(second).toHaveLength(1)
    expect(second[0].id).toBe(2)
    expect(second[0].comment).toBe('Which plan?: Starter')
  })

  it('keeps distinct queueKeys and keyless answers separate', () => {
    const first = queuePageResponse([], response, 1)
    const second = queuePageResponse(first, { question: 'q2', answer: 'a2' }, 2)
    const third = queuePageResponse(second, { question: 'q3', answer: 'a3' }, 3)
    expect(third).toHaveLength(3)
  })

  it('carries data through to feedback notes', () => {
    const list = queuePageResponse([], { ...response, data: { choice: 'Pro' } }, 1)
    const notes = toFeedbackNotes(list, 'http://x/', 42)
    expect(notes[0].response).toEqual({ question: 'Which plan?', answer: 'Pro', data: { choice: 'Pro' } })
    expect(notes[0]).not.toHaveProperty('queueKey')
    expect(notes[0]).not.toHaveProperty('id')
  })

  it('caps the queue at MAX_QUEUED_PILLS dropping the oldest', () => {
    let list: ReturnType<typeof queuePageResponse> = []
    for (let index = 0; index < MAX_QUEUED_PILLS + 5; index += 1) {
      list = queuePageResponse(list, { question: `q${index}`, answer: 'a' }, index)
    }
    expect(list).toHaveLength(MAX_QUEUED_PILLS)
    expect(list[0].comment).toBe('q5: a')
  })
})
