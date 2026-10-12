import { describe, expect, it } from 'vitest'
import { parseCanvasNoteContext } from './canvas-feedback.js'

const context = { frameId: 'settings', point: { x: 10.5, y: 20 }, label: 'Row', labelId: 'row', frameTitle: 'Settings', section: 'Accounts', ticket: 'APP-1', status: 'ready-for-dev', focus: 1, interactive: false }
describe('canvas note context', () => {
  it('keeps only bounded context fields', () => {
    expect(parseCanvasNoteContext({ ...context, other: 'ignored', point: { ...context.point, ignored: 1 } })).toEqual(context)
  })
  it('validates thread identity', () => {
    expect(parseCanvasNoteContext({ ...context, threadId: 'ct-' + 'a'.repeat(24) })?.threadId).toBe('ct-' + 'a'.repeat(24))
    for (const threadId of ['bad', '', false, 'ct-' + 'a'.repeat(25)]) expect(parseCanvasNoteContext({ ...context, threadId })).toBeNull()
  })
  it.each([null, [], {}, { frameId: 'bad/id' }, { point: { x: Infinity, y: 0 } }, { point: { x: 1_000_001, y: 0 } },
    { label: 'x'.repeat(257) }, { labelId: 2 }, { frameTitle: 'x'.repeat(1025) }, { section: '' }, { ticket: false },
    { focus: 0 }, { focus: 1.5 }, { focus: 1_000_001 }, { interactive: 1 }, { status: 'unknown' }])('rejects malformed fields %j', (change) => {
    expect(parseCanvasNoteContext(change === null || Array.isArray(change) || Object.keys(change).length === 0 ? change : { ...context, ...change })).toBeNull()
  })
})
