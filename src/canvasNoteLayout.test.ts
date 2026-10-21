import { describe, expect, it } from 'vitest'
import { canvasNoteConnector, layoutCanvasNotes, stack } from './canvasNoteLayout'

const frame = { x: 0, y: 0, w: 390, h: 844 }
const label = (y: number, x = 20) => ({ x, y, w: 100, h: 20 })
const note = (id: string, y: number, extra: Partial<Parameters<typeof layoutCanvasNotes>[0][number]> = {}) =>
  ({ id, x: -400, y, w: 300, h: 100, frame, ...extra })

describe('stack', () => {
  it('keeps notes that already fit where they asked to be', () => {
    expect(stack([{ top: 0, h: 100 }, { top: 200, h: 100 }])).toEqual([0, 200])
  })
  it('spreads a collision evenly around the wanted spot', () => {
    // Both want 100; together they need 216, so they straddle it.
    expect(stack([{ top: 100, h: 100 }, { top: 100, h: 100 }])).toEqual([42, 158])
  })
})

describe('layoutCanvasNotes', () => {
  it('lines notes up with their labels and orders them by label, not authored y', () => {
    const layout = layoutCanvasNotes([
      note('late', 0, { label: label(600) }),
      note('early', 700, { label: label(100) }),
    ], [frame])
    expect(layout.get('early')!.y).toBe(100 + 10 - 50)
    expect(layout.get('late')!.y).toBe(600 + 10 - 50)
  })

  it('never overlaps notes in one column', () => {
    const layout = layoutCanvasNotes([note('a', 0, { label: label(300) }), note('b', 0, { label: label(310) }), note('c', 0, { label: label(320) })], [frame])
    const boxes = [...layout.values()].sort((a, b) => a.y - b.y)
    for (let i = 1; i < boxes.length; i++) expect(boxes[i].y).toBeGreaterThanOrEqual(boxes[i - 1].y + boxes[i - 1].h + 16)
  })

  it('keeps fixed notes in place and steps other notes past them', () => {
    const layout = layoutCanvasNotes([note('pinned', 280, { fixed: true }), note('moving', 0, { label: label(300) })], [frame])
    expect(layout.get('pinned')).toMatchObject({ x: -400, y: 280, side: 'left' })
    expect(layout.get('moving')!.y).toBe(280 + 100 + 16)
  })

  it('moves a note to the side its label is on when that side is clear', () => {
    const layout = layoutCanvasNotes([note('flip', 0, { label: label(300, 300) })], [frame])
    expect(layout.get('flip')).toMatchObject({ x: 490, side: 'right' })
  })

  it('stays put when another frame is in the way on the far side', () => {
    const neighbour = { x: 600, y: 0, w: 390, h: 844 }
    const layout = layoutCanvasNotes([note('stay', 0, { label: label(300, 300) })], [frame, neighbour])
    expect(layout.get('stay')).toMatchObject({ x: -400, side: 'left' })
  })

  it('leaves untargeted notes alone unless they collide', () => {
    const layout = layoutCanvasNotes([{ id: 'loose', x: 50, y: -300, w: 300, h: 120 }], [frame])
    expect(layout.get('loose')).toEqual({ x: 50, y: -300, w: 300, h: 120 })
  })
})

describe('canvasNoteConnector', () => {
  it('runs level from the note to the frame edge, then dashes in to the label', () => {
    const { outer, inner, end } = canvasNoteConnector({ x: -400, y: 260, w: 300, h: 100 }, 'left', frame, label(300, 200))
    expect(outer).toBe('M -100 310 C -50 310, -50 310, 0 310')
    expect(inner).toBe('M 0 310 L 200 310')
    expect(end).toEqual({ x: 200, y: 310 })
  })
  it('has no dashed part when the target starts at the frame edge', () => {
    expect(canvasNoteConnector({ x: 500, y: 0, w: 300, h: 100 }, 'right', frame, frame).inner).toBeNull()
  })
})
