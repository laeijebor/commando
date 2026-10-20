// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { canvasChoicesFromAnswer, canvasNoteIdFromSelector, canvasNoteSelector, canvasQuestion, canvasQuestionsPage, openCanvasQuestions } from './canvasQuestions'
import type { CanvasAnnotation } from '../shared/canvas-manifest'

const note = (extra: Partial<CanvasAnnotation>): CanvasAnnotation => ({ id: 'q', kind: 'question', x: 0, y: 0, title: 'Your call', text: 'Ship it?', ...extra })

describe('canvas questions', () => {
  it('asks a choice when options are listed and free text otherwise', () => {
    expect(canvasQuestion(note({ options: ['Yes', 'No'], key: 'ship' }))).toEqual({ question: 'Ship it?', kind: 'choice', options: ['Yes', 'No'], multiple: false,
      selector: '[data-canvas-note="q"]', queueKey: 'ship' })
    expect(canvasQuestion(note({ text: undefined }))).toEqual({ question: 'Your call', kind: 'text', selector: '[data-canvas-note="q"]', queueKey: 'q' })
    expect(canvasQuestion(note({ kind: 'design' }))).toBeNull()
    expect(canvasQuestion(note({ text: 'x'.repeat(257) }))).toBeNull()
    expect(canvasQuestion(note({ text: 'x'.repeat(256) }))?.question).toHaveLength(256)
  })
  it('treats a recorded answer as settled', () => {
    expect(openCanvasQuestions([note({ id: 'a' }), note({ id: 'b', answer: 'Yes' }), note({ id: 'c', kind: 'important' })]).map((q) => q.queueKey)).toEqual(['a'])
  })
  it('round-trips the note selector and builds the manifest page url', () => {
    expect(canvasNoteIdFromSelector(canvasNoteSelector('q-recipe'))).toBe('q-recipe')
    expect(canvasNoteIdFromSelector('#other')).toBeNull()
    expect(canvasQuestionsPage('http://127.0.0.1:4310/redline/artifacts/abc/', 'boards/main board.json')).toBe('http://127.0.0.1:4310/redline/artifacts/abc/boards/main%20board.json')
  })
  it('reads multi-choice answers back as whole options, even when options contain ", "', () => {
    expect(canvasChoicesFromAnswer('No, wait', ['No', 'No, wait', 'Tue'])).toEqual(['No, wait'])
    expect(canvasChoicesFromAnswer('No, Tue', ['No', 'No, wait', 'Tue'])).toEqual(['No', 'Tue'])
    expect(canvasChoicesFromAnswer('No, wait', ['wait', 'No, wait'])).toEqual(['No, wait'])
    expect(canvasChoicesFromAnswer('Mon, No, wait', ['Mon', 'No, wait', 'Tue'])).toEqual(['Mon', 'No, wait'])
    expect(canvasChoicesFromAnswer('A, B', ['A', 'B', 'A, B'])).toEqual(['A, B'])
    expect(canvasChoicesFromAnswer('Something else', ['A', 'B'])).toEqual([])
  })
})
