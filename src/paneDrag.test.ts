import { describe, expect, it } from 'vitest'
import { dropPlacementFor } from './paneDrag'

const rect = { left: 100, top: 200, width: 400, height: 300 }

describe('dropPlacementFor', () => {
  it('previews a right anchor in the right half', () => {
    expect(dropPlacementFor(rect, 100 + 360, 200 + 150)).toBe('right')
  })

  it('previews a below anchor in the bottom half', () => {
    expect(dropPlacementFor(rect, 100 + 120, 200 + 270)).toBe('below')
  })

  it('breaks the bottom-right corner tie toward the larger fraction', () => {
    // x-fraction 0.9 > y-fraction 0.8 → right
    expect(dropPlacementFor(rect, 100 + 360, 200 + 240)).toBe('right')
    // x-fraction 0.6 < y-fraction 0.8 → below
    expect(dropPlacementFor(rect, 100 + 240, 200 + 240)).toBe('below')
  })

  it('defaults to right for a degenerate rect', () => {
    expect(dropPlacementFor({ left: 0, top: 0, width: 0, height: 0 }, 0, 0)).toBe('right')
  })
})
