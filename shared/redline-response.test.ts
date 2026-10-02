import { describe, expect, it } from 'vitest'
import {
  MAX_RESPONSE_ANSWER,
  MAX_RESPONSE_DATA_JSON,
  MAX_RESPONSE_NOTE,
  MAX_RESPONSE_QUESTION,
  MAX_RESPONSE_QUEUE_KEY,
  MAX_PENDING_SNAPSHOT_BYTES,
  REDLINE_BINDING_NAME,
  pageSentAnswers,
  parseRedlinePageQuestionSnapshot,
  parseRedlinePageResponse,
  redlinePageKey,
  redlinePendingSnapshotForPage,
  sameQuestionShape,
  sentAnswerForQuestion,
  type RedlinePageQuestion,
} from './redline-response.js'
import type { WebPaneSentAnswer } from './protocol.js'

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

describe('parseRedlinePageQuestionSnapshot', () => {
  it('accepts a bounded inventory with editor metadata', () => {
    const snapshot = {
      type: 'questions',
      version: 1,
      questions: [
        {
          question: 'Which plan?',
          queueKey: 'plan',
          selector: '#plan',
          kind: 'choice',
          options: ['Starter', 'Pro'],
          multiple: false,
        },
        { question: 'Rate it', selector: '#rating', kind: 'rating', max: 5 },
      ],
    } as const
    expect(parseRedlinePageQuestionSnapshot(snapshot)).toEqual(snapshot)
  })

  it('rejects duplicate identities and malformed editor metadata', () => {
    expect(parseRedlinePageQuestionSnapshot({
      type: 'questions',
      version: 1,
      questions: [
        { question: 'One?', queueKey: 'same', selector: '#one', kind: 'text' },
        { question: 'Two?', queueKey: 'same', selector: '#two', kind: 'text' },
      ],
    })).toBeNull()
    expect(parseRedlinePageQuestionSnapshot({
      type: 'questions',
      version: 1,
      questions: [{ question: 'Which?', selector: '#one', kind: 'choice' }],
    })).toBeNull()
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

  it('compacts optional data instead of rejecting an oversized pending snapshot', () => {
    const largeData = { choice: 'x'.repeat(MAX_RESPONSE_DATA_JSON - 1_024) }
    const snapshot = redlinePendingSnapshotForPage({
      notes: [1, 2].map((id) => ({
        id,
        selector: `#choice-${id}`,
        tag: 'redline-choice',
        rect: { x: 0, y: 0, width: 0, height: 0 },
        comment: `Choice ${id}: selected`,
        pageUrl: 'https://example.com/review',
        response: { question: `Choice ${id}?`, answer: 'selected', data: largeData },
      })),
      knownUpTo: 2,
      dropped: 0,
    }, 'https://example.com/review')

    expect(snapshot.controls).toHaveLength(2)
    expect(snapshot.controls[0]?.response.data).toEqual(largeData)
    expect(snapshot.controls[1]?.response).not.toHaveProperty('data')
    expect(new TextEncoder().encode(JSON.stringify(snapshot)).byteLength)
      .toBeLessThanOrEqual(MAX_PENDING_SNAPSHOT_BYTES)
  })
})

describe('sent answers', () => {
  const plan: RedlinePageQuestion = {
    question: 'Which plan?',
    selector: '#plan',
    queueKey: 'plan',
    kind: 'choice',
    options: ['Free', 'Pro'],
    multiple: false,
  }
  const sentPlan: WebPaneSentAnswer = {
    queueKey: 'plan',
    selector: '#plan',
    shape: { question: 'Which plan?', kind: 'choice', options: ['Free', 'Pro'], multiple: false },
    response: { question: 'Which plan?', answer: 'Pro', data: { choice: 'Pro' } },
    sentAt: 10,
  }

  it('keeps a validated shape on page responses and drops a malformed one', () => {
    expect(parseRedlinePageResponse({
      question: 'Which plan?',
      answer: 'Pro',
      shape: { question: 'Which plan?', kind: 'choice', options: ['Free', 'Pro'], multiple: false },
    })?.shape).toEqual({ question: 'Which plan?', kind: 'choice', options: ['Free', 'Pro'], multiple: false })
    const malformed = parseRedlinePageResponse({
      question: 'Which plan?',
      answer: 'Pro',
      shape: { question: 'Which plan?', kind: 'choice', options: [] },
    })
    expect(malformed).not.toBeNull()
    expect(malformed?.shape).toBeUndefined()
  })

  it('keys pages by origin and path, ignoring query and hash', () => {
    expect(redlinePageKey('http://127.0.0.1:4000/plan.html?v=3#top')).toBe('http://127.0.0.1:4000/plan.html')
    expect(redlinePageKey('http://127.0.0.1:4000/plan.html?v=2')).toBe(redlinePageKey('http://127.0.0.1:4000/plan.html'))
    expect(redlinePageKey('file:///tmp/plan.html?v=1')).toBe('file:///tmp/plan.html')
  })

  it('treats rewording, new options, or a different kind as a re-ask', () => {
    expect(sameQuestionShape(sentPlan.shape, plan)).toBe(true)
    expect(sameQuestionShape(sentPlan.shape, { ...plan, question: 'Which plan now?' })).toBe(false)
    expect(sameQuestionShape(sentPlan.shape, { ...plan, options: ['Free', 'Pro', 'Team'] })).toBe(false)
    expect(sameQuestionShape(sentPlan.shape, { ...plan, multiple: true })).toBe(false)
    expect(sameQuestionShape(
      { question: 'Rate it', kind: 'rating', max: 5 },
      { question: 'Rate it', kind: 'rating', max: 10 },
    )).toBe(false)
  })

  it('matches a sent answer by identity and shape', () => {
    expect(sentAnswerForQuestion(plan, [sentPlan])).toBe(sentPlan)
    expect(sentAnswerForQuestion({ ...plan, queueKey: 'other' }, [sentPlan])).toBeUndefined()
    expect(sentAnswerForQuestion({ ...plan, question: 'Reworded?' }, [sentPlan])).toBeUndefined()
    const keyless = { ...sentPlan, queueKey: undefined }
    expect(sentAnswerForQuestion({ ...plan, queueKey: undefined }, [keyless])).toBe(keyless)
  })

  it('hands the page only the sent answers for its own page key', () => {
    const snapshot = {
      notes: [],
      knownUpTo: 0,
      dropped: 0,
      sent: { page: 'https://example.com/review', answers: [sentPlan] },
    }
    expect(redlinePendingSnapshotForPage(snapshot, 'https://example.com/review?v=4')).toEqual({
      version: 1,
      controls: [],
      sent: [sentPlan],
    })
    expect(redlinePendingSnapshotForPage(snapshot, 'https://example.com/other')).toEqual({
      version: 1,
      controls: [],
    })
  })

  it('bounds page sent answers newest first, dropping data before the answer', () => {
    const older = { ...sentPlan, queueKey: 'older', sentAt: 1 }
    const big = { ...sentPlan, queueKey: 'big', sentAt: 20, response: { ...sentPlan.response, data: { blob: 'x'.repeat(2_000) } } }
    const bounded = pageSentAnswers([older, big], 800)
    expect(bounded.map((answer) => answer.queueKey)).toEqual(['big', 'older'])
    expect(bounded[0].response.data).toBeUndefined()
    expect(pageSentAnswers([{ ...sentPlan, shape: { question: '', kind: 'text' } }], 10_000)).toEqual([])
  })
})

describe('redlinePendingSnapshotForPage page identity', () => {
  it('shows controls queued under another hash of the same page', () => {
    const snapshot = {
      notes: [{
        id: 1,
        selector: '#plan',
        tag: 'redline-choice',
        rect: { x: 0, y: 0, width: 0, height: 0 },
        comment: 'Which plan?: Pro',
        pageUrl: 'https://example.com/review#reach',
        queueKey: 'plan',
        response: { question: 'Which plan?', answer: 'Pro' },
      }],
      knownUpTo: 1,
      dropped: 0,
    }
    expect(redlinePendingSnapshotForPage(snapshot, 'https://example.com/review#composer').controls).toHaveLength(1)
    expect(redlinePendingSnapshotForPage(snapshot, 'https://example.com/other').controls).toHaveLength(0)
  })
})
