import { describe, expect, it, vi } from 'vitest'
import {
  MAX_TERMINAL_COLS,
  MAX_TERMINAL_ROWS,
  MIN_TERMINAL_COLS,
  MIN_TERMINAL_ROWS,
} from '../shared/protocol'
import { copyTerminalSelection, terminalDimensionsForViewport } from './XtermPane'

describe('terminal selection clipboard', () => {
  it('copies the exact selected text', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)

    await copyTerminalSelection('  selected\ntext  ', { writeText })

    expect(writeText).toHaveBeenCalledWith('  selected\ntext  ')
  })

  it('ignores empty selections, unavailable clipboards, and denied writes', async () => {
    const writeText = vi.fn().mockRejectedValue(new DOMException('Denied', 'NotAllowedError'))

    await copyTerminalSelection('', { writeText })
    await copyTerminalSelection('selected', undefined)
    await expect(copyTerminalSelection('selected', { writeText })).resolves.toBeUndefined()

    expect(writeText).toHaveBeenCalledOnce()
  })
})

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
