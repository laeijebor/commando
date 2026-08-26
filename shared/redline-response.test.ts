import { describe, expect, it } from 'vitest'
import {
  MAX_RESPONSE_ANSWER,
  MAX_RESPONSE_DATA_JSON,
  MAX_RESPONSE_NOTE,
  MAX_RESPONSE_QUESTION,
  MAX_RESPONSE_QUEUE_KEY,
  REDLINE_BINDING_NAME,
  parseRedlinePageResponse,
  redlinePendingSnapshotForPage,
} from './redline-response.js'

describe('parseRedlinePageResponse', () => {
  const valid = { question: 'Which plan?', answer: 'Pro' }

  it('accepts a minimal response', () => {
    expect(parseRedlinePageResponse(valid)).toEqual({ question: 'Which plan?', answer: 'Pro' })
  })

  it('accepts all optional fields', () => {
    const full = {
      ...valid,
      note: 'Prioritize accessibility.',
      data: { choice: 'Pro' },
      queueKey: 'plan',
      selector: '#plan-picker',
      tag: 'redline-choice',
      text: 'Plan picker',
      rect: { x: 1, y: 2, width: 30, height: 40 },
    }
    expect(parseRedlinePageResponse(full)).toEqual(full)
  })

  it('rejects non-objects and missing required fields', () => {
    expect(parseRedlinePageResponse(null)).toBeNull()
    expect(parseRedlinePageResponse('hi')).toBeNull()
    expect(parseRedlinePageResponse({ question: 'q' })).toBeNull()
    expect(parseRedlinePageResponse({ answer: 'a' })).toBeNull()
    expect(parseRedlinePageResponse({ question: '', answer: 'a' })).toBeNull()
  })

  it('rejects oversized fields', () => {
    expect(parseRedlinePageResponse({ question: 'q'.repeat(MAX_RESPONSE_QUESTION + 1), answer: 'a' })).toBeNull()
    expect(parseRedlinePageResponse({ question: 'q', answer: 'a'.repeat(MAX_RESPONSE_ANSWER + 1) })).toBeNull()
    expect(parseRedlinePageResponse({ ...valid, queueKey: 'k'.repeat(MAX_RESPONSE_QUEUE_KEY + 1) })).toBeNull()
    expect(parseRedlinePageResponse({ ...valid, note: 'n'.repeat(MAX_RESPONSE_NOTE + 1) })).toEqual(valid)
  })

  it('drops data, keeps answer', () => {
    // data is best-effort: unserializable or oversized data must not lose the answer.
    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect(parseRedlinePageResponse({ ...valid, data: circular })).toEqual(valid)
    expect(parseRedlinePageResponse({ ...valid, data: 'd'.repeat(MAX_RESPONSE_DATA_JSON) })).toEqual(valid)
  })

  it('drops malformed optional fields rather than the whole response', () => {
    // Optional presentation fields are best-effort: a bad rect must not lose the answer.
    expect(parseRedlinePageResponse({ ...valid, rect: { x: 1 } })).toEqual(valid)
    expect(parseRedlinePageResponse({ ...valid, rect: { x: Infinity, y: 0, width: 1, height: 1 } })).toEqual(valid)
    expect(parseRedlinePageResponse({ ...valid, selector: '' })).toEqual(valid)
    expect(parseRedlinePageResponse({ ...valid, note: '' })).toEqual(valid)
    expect(parseRedlinePageResponse({ ...valid, tag: 'x'.repeat(64) })).toEqual(valid)
  })

  it('exports the binding name', () => {
    expect(REDLINE_BINDING_NAME).toBe('__commandoRedlineQueue')
  })
})

describe('redlinePendingSnapshotForPage', () => {
  it('exposes only sanitized responses for the exact current page', () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect(redlinePendingSnapshotForPage({
      notes: [
        {
          id: 1,
          selector: '#plan',
          tag: 'redline-choice',
          rect: { x: 1, y: 2, width: 3, height: 4 },
          comment: 'Which plan?: Pro',
          pageUrl: 'https://example.com/review',
          queueKey: 'plan',
          response: { question: 'Which plan?', answer: 'Pro', data: { choice: 'Pro' } },
        },
        {
          id: 2,
          selector: '#manual',
          tag: 'button',
          rect: { x: 0, y: 0, width: 1, height: 1 },
          comment: 'Manual annotation stays private',
          pageUrl: 'https://example.com/review',
        },
        {
          id: 3,
          selector: '#other',
          tag: 'redline-choice',
          rect: { x: 0, y: 0, width: 1, height: 1 },
          comment: 'Other page',
          pageUrl: 'https://example.com/other',
          response: { question: 'Other?', answer: 'No' },
        },
        {
          id: 4,
          selector: '#circular',
          tag: 'redline-choice',
          rect: { x: 0, y: 0, width: 1, height: 1 },
          comment: 'Circular data',
          pageUrl: 'https://example.com/review',
          response: { question: 'Keep answer?', answer: 'Yes', data: circular },
        },
      ],
      knownUpTo: 4,
      dropped: 0,
    }, 'https://example.com/review')).toEqual({
      version: 1,
      controls: [
        {
          queueKey: 'plan',
          selector: '#plan',
          response: { question: 'Which plan?', answer: 'Pro', data: { choice: 'Pro' } },
        },
        {
          selector: '#circular',
          response: { question: 'Keep answer?', answer: 'Yes' },
        },
      ],
    })
  })
})
