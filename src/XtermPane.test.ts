import { describe, expect, it } from 'vitest'
import {
  MAX_TERMINAL_COLS,
  MAX_TERMINAL_ROWS,
  MIN_TERMINAL_COLS,
  MIN_TERMINAL_ROWS,
} from '../shared/protocol'
import { terminalDimensionsForViewport } from './XtermPane'

describe('focused terminal viewport measurement', () => {
  it('converts available pixels into complete terminal cells', () => {
    expect(terminalDimensionsForViewport(803, 407, 8, 10)).toEqual({
      cols: 100,
      rows: 40,
    })
  })

  it('rejects unmeasurable cells and clamps protocol dimensions', () => {
    expect(terminalDimensionsForViewport(800, 400, 0, 10)).toBeNull()
    expect(terminalDimensionsForViewport(1, 1, 8, 10)).toEqual({
      cols: MIN_TERMINAL_COLS,
      rows: MIN_TERMINAL_ROWS,
    })
    expect(terminalDimensionsForViewport(100_000, 100_000, 8, 10)).toEqual({
      cols: MAX_TERMINAL_COLS,
      rows: MAX_TERMINAL_ROWS,
    })
  })
})
