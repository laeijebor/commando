import { describe, expect, it } from 'vitest'
import {
  clampOuterGroupSize,
  MIN_OUTER_GROUP_SIZE,
} from './ResizablePaneGroup'

describe('outer pane-group resizing', () => {
  it('clamps live drag dimensions to the group and canvas limits', () => {
    expect(clampOuterGroupSize(100, 1_000)).toBe(MIN_OUTER_GROUP_SIZE)
    expect(clampOuterGroupSize(720.4, 1_000)).toBe(720)
    expect(clampOuterGroupSize(1_200, 1_000)).toBe(1_000)
  })
})
