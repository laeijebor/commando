import { describe, expect, it } from 'vitest'
import { MAX_RESPONSE_PAYLOAD_BYTES } from '../shared/redline-response'
import { canvasNoteContext, canvasRedlineResponse, readCanvasHit } from './canvasComments'

describe('canvas comment helpers', () => {
  const hit = { selector: '#row', tag: 'button', text: 'Row', rect: { x: 10, y: 20, w: 100, h: 40 }, label: 'Row', labelId: 'row' }
  it('keeps a bounded hit and discards unsupported presentation extras', () => {
    expect(readCanvasHit({ ...hit, ignored: 'extra' })).toEqual(hit)
    expect(readCanvasHit({ ...hit, tag: 'x'.repeat(1000), text: 'x'.repeat(1000) })).toEqual({ selector: '#row', tag: 'element', rect: hit.rect, label: 'Row', labelId: 'row' })
  })
  it.each([null, {}, { selector: '' }, { selector: 'x'.repeat(10000) }, { rect: { x: Infinity, y: 0, w: 1, h: 1 } },
    { rect: { x: 1e7, y: 0, w: 1, h: 1 } }, { rect: { x: 1, y: 2, w: -1, h: 10 } }, { label: 1 }, { labelId: 'x'.repeat(257) }])('rejects malformed hit replies %j', (change) => {
    expect(readCanvasHit(change === null || Object.keys(change).length === 0 ? change : { ...hit, ...change })).toBeNull()
  })
  it('uses the first section and marks static frames explicitly', () => {
    const frame = { id: 'settings', title: 'Settings', src: 'Settings.html', x: 0, y: 0, w: 390, h: 844 }
    expect(canvasNoteContext(frame, [{ id: 'first', title: 'First', frames: ['settings'], status: 'idea' },
      { id: 'second', title: 'Second', frames: ['settings'], status: 'shipped' }], { x: 3, y: 7 })).toEqual({ frameId: 'settings', frameTitle: 'Settings', point: { x: 3, y: 7 }, section: 'First', status: 'idea', interactive: false })
  })
  it('uses shared response validation, respects UTF-8 envelope bounds and ignores questions', () => {
    expect(canvasRedlineResponse(JSON.stringify({ question: 'Ship?', answer: 'Yes', selector: '#row' }))).toEqual({ question: 'Ship?', answer: 'Yes', selector: '#row' })
    for (const value of ['{', '{}', null, JSON.stringify({ question: 'Ship?', answer: '' }), JSON.stringify({ type: 'questions', version: 1, questions: [] }), '€'.repeat(MAX_RESPONSE_PAYLOAD_BYTES / 2)]) expect(canvasRedlineResponse(value)).toBeNull()
  })
})
