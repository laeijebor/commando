import type { AgentQuestion } from '@commando/protocol'

import {
  answersAreComplete,
  buildAnswerGroups,
  buildPermissionAnswer,
  buildQuestionAnswer,
  buildRejectAnswer,
  emptySelections,
  MAX_ANSWER_LENGTH,
  selectedAnswers,
  toggleOption,
} from './payload'

const SINGLE: AgentQuestion = {
  header: 'Auth',
  question: 'Which auth flow should the companion use?',
  options: [
    { label: 'Owner email + password', description: 'Reuse the Better Auth cookie' },
    { label: 'Pairing QR' },
    { label: 'Automation token only' },
  ],
  multiple: false,
  custom: true,
}

const MULTI: AgentQuestion = {
  header: 'Checks',
  question: 'Which checks should run before merge?',
  options: [{ label: 'typecheck' }, { label: 'vitest' }, { label: 'playwright' }],
  multiple: true,
  custom: false,
}

describe('building an answer from question selections', () => {
  it('replaces the choice for a single-select question and clears it on a second tap', () => {
    let selection = toggleOption(SINGLE, { optionIndices: [], custom: '' }, 2)
    expect(selection.optionIndices).toEqual([2])
    selection = toggleOption(SINGLE, selection, 0)
    expect(selection.optionIndices).toEqual([0])
    selection = toggleOption(SINGLE, selection, 0)
    expect(selection.optionIndices).toEqual([])
  })

  it('accumulates and removes choices for a multiple-select question', () => {
    let selection = toggleOption(MULTI, { optionIndices: [], custom: '' }, 1)
    selection = toggleOption(MULTI, selection, 0)
    expect(selectedAnswers(MULTI, selection)).toEqual(['typecheck', 'vitest'])
    selection = toggleOption(MULTI, selection, 1)
    expect(selectedAnswers(MULTI, selection)).toEqual(['typecheck'])
  })

  it('sends one group per question, in the protocol order', () => {
    const questions = [SINGLE, MULTI]
    const selections = [
      { optionIndices: [1], custom: '' },
      { optionIndices: [0, 2], custom: '' },
    ]
    expect(buildQuestionAnswer(questions, selections)).toEqual({
      action: 'answer',
      answers: [['Pairing QR'], ['typecheck', 'playwright']],
    })
  })

  it('appends the custom answer after the picked labels, and only when allowed', () => {
    expect(selectedAnswers(SINGLE, { optionIndices: [0], custom: '  or a device token  ' }))
      .toEqual(['Owner email + password', 'or a device token'])
    expect(selectedAnswers(MULTI, { optionIndices: [0], custom: 'and a lint pass' }))
      .toEqual(['typecheck'])
  })

  it('treats a custom answer alone as a complete answer', () => {
    expect(answersAreComplete([SINGLE], [{ optionIndices: [], custom: 'something else' }])).toBe(true)
    expect(answersAreComplete([SINGLE], emptySelections([SINGLE]))).toBe(false)
    expect(answersAreComplete([SINGLE, MULTI], [{ optionIndices: [0], custom: '' }, { optionIndices: [], custom: '' }]))
      .toBe(false)
  })

  it('appends a note to the last chosen answer, since the protocol has no note field', () => {
    const groups = buildAnswerGroups(
      [SINGLE, MULTI],
      [{ optionIndices: [0], custom: '' }, { optionIndices: [1], custom: '' }],
      '  Keep the token path as a fallback.  ',
    )
    expect(groups).toEqual([
      ['Owner email + password'],
      ['vitest\n\nKeep the token path as a fallback.'],
    ])
  })

  it('leaves the answers untouched when no note was typed', () => {
    expect(buildAnswerGroups([SINGLE], [{ optionIndices: [0], custom: '' }], '   '))
      .toEqual([['Owner email + password']])
  })

  it('clips an answer to the 300 characters the broker accepts', () => {
    const groups = buildAnswerGroups([SINGLE], [{ optionIndices: [], custom: 'x'.repeat(400) }])
    expect(groups[0]?.[0]).toHaveLength(MAX_ANSWER_LENGTH)
  })

  it('keeps reject and the permission decisions to their bare protocol shape', () => {
    expect(buildRejectAnswer()).toEqual({ action: 'reject' })
    expect(buildPermissionAnswer('allow_once')).toEqual({ action: 'allow_once' })
    expect(buildPermissionAnswer('allow_always')).toEqual({ action: 'allow_always' })
    expect(buildPermissionAnswer('deny')).toEqual({ action: 'deny' })
  })
})
