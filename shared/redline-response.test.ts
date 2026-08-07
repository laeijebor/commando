import { describe, expect, it } from 'vitest'
import {
  MAX_RESPONSE_ANSWER,
  MAX_RESPONSE_DATA_JSON,
  MAX_RESPONSE_QUESTION,
  MAX_RESPONSE_QUEUE_KEY,
  REDLINE_BINDING_NAME,
  parseRedlinePageResponse,
} from './redline-response.js'

describe('parseRedlinePageResponse', () => {
  const valid = { question: 'Which plan?', answer: 'Pro' }

  it('accepts a minimal response', () => {
    expect(parseRedlinePageResponse(valid)).toEqual({ question: 'Which plan?', answer: 'Pro' })
  })

  it('accepts all optional fields', () => {
    const full = {
      ...valid,
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
    expect(
      parseRedlinePageResponse({ ...valid, data: 'd'.repeat(MAX_RESPONSE_DATA_JSON) }),
    ).toBeNull()
  })

  it('rejects unserializable and oversized data', () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect(parseRedlinePageResponse({ ...valid, data: circular })).toBeNull()
  })

  it('drops malformed optional fields rather than the whole response', () => {
    // Optional presentation fields are best-effort: a bad rect must not lose the answer.
    expect(parseRedlinePageResponse({ ...valid, rect: { x: 1 } })).toEqual(valid)
    expect(parseRedlinePageResponse({ ...valid, rect: { x: Infinity, y: 0, width: 1, height: 1 } })).toEqual(valid)
    expect(parseRedlinePageResponse({ ...valid, selector: '' })).toEqual(valid)
    expect(parseRedlinePageResponse({ ...valid, tag: 'x'.repeat(64) })).toEqual(valid)
  })

  it('exports the binding name', () => {
    expect(REDLINE_BINDING_NAME).toBe('__commandoRedlineQueue')
  })
})
