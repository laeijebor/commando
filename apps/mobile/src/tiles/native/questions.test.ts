import type { WebPanePendingNote, WebPanePendingSnapshot } from '@commando/protocol'
import type { RedlinePageQuestion } from '@commando/redline-response'

import { mergePendingSnapshot } from './usePendingQueue'
import {
  EMPTY_DRAFT,
  canvasQuestion,
  canvasQuestionsPage,
  draftFromNote,
  pendingForQuestion,
  pickOption,
  questionOptions,
  responseForQuestion,
  sentAgo,
  sentForQuestion,
} from './questions'

const choice: RedlinePageQuestion = {
  question: 'Which plan?',
  kind: 'choice',
  options: ['Starter', 'Pro', 'Enterprise'],
  multiple: false,
  selector: '#plan',
  queueKey: 'plan',
}
const PAGE = 'http://127.0.0.1:4310/redline/artifacts/0123456789abcdef/plan.html'

describe('responseForQuestion', () => {
  it('builds the same single-choice response as the desktop', () => {
    expect(responseForQuestion(choice, pickOption(choice, EMPTY_DRAFT, 'Pro'))).toEqual({
      question: 'Which plan?',
      answer: 'Pro',
      data: { choice: 'Pro', options: ['Starter', 'Pro', 'Enterprise'], multiple: false },
      queueKey: 'plan',
      selector: '#plan',
      tag: 'redline',
      text: 'Which plan?',
      shape: { question: 'Which plan?', kind: 'choice', options: ['Starter', 'Pro', 'Enterprise'], multiple: false },
    })
  })

  it('keeps multi-choice answers in option order and drops a cleared choice', () => {
    const multi = { ...choice, multiple: true }
    let draft = pickOption(multi, EMPTY_DRAFT, 'Enterprise')
    draft = pickOption(multi, draft, 'Starter')
    expect(draft).toMatchObject({ answer: 'Starter, Enterprise', choices: ['Starter', 'Enterprise'] })
    expect(responseForQuestion(multi, draft).data).toEqual({ choice: ['Starter', 'Enterprise'], options: multi.options, multiple: true })
    expect(pickOption(multi, pickOption(multi, EMPTY_DRAFT, 'Pro'), 'Pro').choices).toEqual([])
  })

  it('answers ratings as n/max with the number in data, like the SDK', () => {
    const rating: RedlinePageQuestion = { question: 'How close?', kind: 'rating', max: 5, selector: '#r' }
    expect(questionOptions(rating)).toEqual(['1', '2', '3', '4', '5'])
    const response = responseForQuestion(rating, pickOption(rating, EMPTY_DRAFT, '4'))
    expect(response).toMatchObject({ answer: '4/5', data: { rating: 4, max: 5 } })
  })

  it('carries a trimmed note and the approve verdict', () => {
    const approve: RedlinePageQuestion = { question: 'Ship it?', kind: 'approve', options: ['approve', 'reject'], selector: '#a' }
    expect(responseForQuestion(approve, { answer: 'approve', note: '  with tweaks ', choices: ['approve'] }))
      .toMatchObject({ answer: 'approve', note: 'with tweaks', data: { verdict: 'approve' } })
  })
})

describe('pending and sent answers', () => {
  const pending = (extra: Partial<WebPanePendingNote>): WebPanePendingNote => ({
    id: 1,
    selector: '#plan',
    tag: 'redline',
    rect: { x: 0, y: 0, width: 0, height: 0 },
    comment: '',
    response: { question: 'Which plan?', answer: 'Pro', data: { choice: 'Pro' } },
    queueKey: 'plan',
    pageUrl: `${PAGE}?v=2`,
    ...extra,
  })

  it('matches by queue key on the same page and reads the draft back', () => {
    const note = pending({})
    expect(pendingForQuestion(choice, [note], PAGE)).toBe(note)
    expect(draftFromNote(note, choice)).toEqual({ answer: 'Pro', note: '', choices: ['Pro'] })
    expect(pendingForQuestion(choice, [pending({ pageUrl: 'http://127.0.0.1:4310/other.html' })], PAGE)).toBeUndefined()
  })

  it('ignores an answer queued for an earlier version of the question', () => {
    const stale = pending({ questionShape: { question: 'Which plan?', kind: 'choice', options: ['A', 'B'], multiple: false } })
    expect(pendingForQuestion(choice, [stale], PAGE)).toBeUndefined()
  })

  it('finds the sent answer only for its own page', () => {
    const sent: WebPanePendingSnapshot['sent'] = {
      page: PAGE,
      answers: [{ queueKey: 'plan', shape: { question: 'Which plan?', kind: 'choice', options: ['Starter', 'Pro', 'Enterprise'], multiple: false }, response: { question: 'Which plan?', answer: 'Pro' }, sentAt: 1 }],
    }
    expect(sentForQuestion(choice, sent, `${PAGE}#x`)?.response.answer).toBe('Pro')
    expect(sentForQuestion(choice, sent, 'http://127.0.0.1:4310/other.html')).toBeUndefined()
  })

  it('says how long ago an answer was sent', () => {
    expect(sentAgo(0, 30_000)).toBe('Sent · just now')
    expect(sentAgo(0, 5 * 60_000)).toBe('Sent · 5m ago')
    expect(sentAgo(0, 3 * 3_600_000)).toBe('Sent · 3h ago')
  })
})

describe('canvas questions', () => {
  it('asks a question note as a choice or as text, keyed by key or id', () => {
    expect(canvasQuestion({ id: 'q1', kind: 'question', text: 'Fail the save?', options: ['Yes', 'No'], x: 0, y: 0 })).toEqual({
      question: 'Fail the save?', kind: 'choice', options: ['Yes', 'No'], multiple: false, selector: '[data-canvas-note="q1"]', queueKey: 'q1',
    })
    expect(canvasQuestion({ id: 'q2', kind: 'question', title: 'Name?', key: 'naming', x: 0, y: 0 }))
      .toMatchObject({ kind: 'text', queueKey: 'naming', question: 'Name?' })
    expect(canvasQuestion({ id: 'n', kind: 'design', text: 'x', x: 0, y: 0 })).toBeNull()
    expect(canvasQuestion({ id: 'q3', kind: 'question', text: 'x'.repeat(300), x: 0, y: 0 })).toBeNull()
  })

  it('keys canvas answers under the manifest URL on the canonical origin', () => {
    expect(canvasQuestionsPage('http://127.0.0.1:4310/redline/artifacts/0123456789abcdef/', 'boards/main board.json'))
      .toBe('http://127.0.0.1:4310/redline/artifacts/0123456789abcdef/boards/main%20board.json')
  })
})

describe('mergePendingSnapshot', () => {
  const sent = { page: PAGE, answers: [] }
  it('ignores an older revision and keeps sent answers from the page read when asked', () => {
    const current: WebPanePendingSnapshot = { revision: 5, notes: [], knownUpTo: 0, dropped: 0, sent }
    expect(mergePendingSnapshot(current, { revision: 4, notes: [], knownUpTo: 0, dropped: 0 }, { keepSent: false })).toBe(current)
    const next = mergePendingSnapshot(current, { revision: 6, notes: [], knownUpTo: 0, dropped: 1, sent: { page: 'other', answers: [] } }, { keepSent: true })
    expect(next).toEqual({ revision: 6, notes: [], knownUpTo: 0, dropped: 1, sent })
  })
})
