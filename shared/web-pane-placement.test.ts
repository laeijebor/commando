import { describe, expect, it } from 'vitest'
import { isBuiltinPanelKey, isLegacyPrPanelKey, parsePrPanelKey, prPanelKey, resolveAutoPlacement } from './web-pane-placement.js'

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
  it('accepts repository-aware keys, normalizes GitHub casing, and distinguishes equal numbers', () => {
    expect(prPanelKey('Acme/Widgets', 48)).toBe('pr:acme:widgets:48')
    expect(parsePrPanelKey('pr:Acme:Widgets:48')).toEqual({ repo: 'acme/widgets', number: 48 })
    expect(prPanelKey('orgA/x', 12)).not.toBe(prPanelKey('orgB/y', 12))
    for (const key of ['session', 'changes', 'pr:acme:widgets:1', 'pr:some-org:my.repo_name:48']) expect(isBuiltinPanelKey(key)).toBe(true)
  })
  it.each(['pr', 'pr:12', 'pr:', 'pr:acme:widgets:0', 'pr:acme:widgets:-1', 'pr:acme:widgets:01', 'pr:acme:widgets:1.0', 'pr:acme:widgets:1e2', 'pr:acme:widgets:1x', 'pr:acme:widgets: 1', 'pr:acme:widgets:9007199254740992', 'pr:acme::1', 'pr:acme:widgets/other:1', 'pr:bad_owner:widgets:1', 'pr:acme:widgets:1:2', 'w-12345678'])('rejects %s', (key) => {
    expect(parsePrPanelKey(key)).toBeUndefined()
    expect(isBuiltinPanelKey(key)).toBe(false)
  })
  it('recognizes only valid legacy selections for client migration', () => {
    for (const key of ['pr', 'pr:12']) expect(isLegacyPrPanelKey(key)).toBe(true)
    for (const key of ['pr:0', 'pr:01', 'pr:acme:widgets:12', 'pr:9007199254740992']) expect(isLegacyPrPanelKey(key)).toBe(false)
  })
})
