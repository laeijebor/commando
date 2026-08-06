import { describe, expect, it } from 'vitest'
import { resolveAutoPlacement } from './web-pane-placement.js'

describe('resolveAutoPlacement', () => {
  it('splits wide anchors to the right', () => {
    expect(resolveAutoPlacement({ cols: 200, rows: 50 })).toBe('right')
    // Terminal cells are ~2x taller than wide: cols === 2·rows is square in
    // pixels, the boundary where a right split stops being the wider edge.
    expect(resolveAutoPlacement({ cols: 100, rows: 50 })).toBe('right')
  })

  it('splits tall anchors below', () => {
    expect(resolveAutoPlacement({ cols: 99, rows: 50 })).toBe('below')
    expect(resolveAutoPlacement({ cols: 80, rows: 60 })).toBe('below')
  })
})
