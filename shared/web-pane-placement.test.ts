import { describe, expect, it } from 'vitest'
import { isBuiltinPanelKey, parsePrPanelKey, prPanelKey, resolveAutoPlacement } from './web-pane-placement.js'

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

describe('PR panel keys', () => {
  it('accepts per-PR keys and the fixed built-ins', () => {
    expect(prPanelKey(48)).toBe('pr:48')
    expect(parsePrPanelKey('pr:48')).toBe(48)
    for (const key of ['session', 'changes', 'pr:1', 'pr:48']) expect(isBuiltinPanelKey(key)).toBe(true)
  })
  it.each(['pr', 'pr:', 'pr:0', 'pr:-1', 'pr:01', 'pr:1.0', 'pr:1e2', 'pr:1x', 'pr: 1', 'pr:9007199254740992', 'w-12345678'])('rejects %s', (key) => {
    expect(parsePrPanelKey(key)).toBeUndefined()
    expect(isBuiltinPanelKey(key)).toBe(false)
  })
})
