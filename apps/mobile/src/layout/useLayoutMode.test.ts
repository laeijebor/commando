import { layoutModeFor, isCockpitMode } from './useLayoutMode'

describe('the layout breakpoints', () => {
  it('keeps every iPhone on the phone layout, in both orientations', () => {
    // iPhone 15 Pro, iPhone 16 Pro Max, and the Max in landscape — 956pt wide
    // but only 440pt tall, which is why height is part of the rule.
    expect(layoutModeFor({ width: 393, height: 852 })).toBe('phone')
    expect(layoutModeFor({ width: 440, height: 956 })).toBe('phone')
    expect(layoutModeFor({ width: 852, height: 393 })).toBe('phone')
    expect(layoutModeFor({ width: 956, height: 440 })).toBe('phone')
  })

  it('gives landscape iPads three columns', () => {
    expect(layoutModeFor({ width: 1_024, height: 768 })).toBe('wide')
    expect(layoutModeFor({ width: 1_366, height: 1_024 })).toBe('wide')
  })

  it('gives the big iPads three columns in portrait too', () => {
    expect(layoutModeFor({ width: 1_024, height: 1_366 })).toBe('wide')
  })

  it('falls back to two columns between 700 and 900pt', () => {
    // An 11" iPad in portrait, and a 2/3 Split View column on a 12.9".
    expect(layoutModeFor({ width: 834, height: 1_194 })).toBe('tablet')
    expect(layoutModeFor({ width: 704, height: 1_366 })).toBe('tablet')
  })

  it('treats a narrow Split View column as a phone', () => {
    expect(layoutModeFor({ width: 375, height: 1_024 })).toBe('phone')
    expect(layoutModeFor({ width: 699, height: 1_024 })).toBe('phone')
  })

  it('switches exactly on the breakpoints', () => {
    expect(layoutModeFor({ width: 899, height: 1_024 })).toBe('tablet')
    expect(layoutModeFor({ width: 900, height: 1_024 })).toBe('wide')
    expect(layoutModeFor({ width: 700, height: 1_024 })).toBe('tablet')
    expect(layoutModeFor({ width: 1_024, height: 599 })).toBe('phone')
    expect(layoutModeFor({ width: 1_024, height: 600 })).toBe('wide')
  })

  it('knows which modes lay the terminal beside the HUD', () => {
    expect(isCockpitMode('phone')).toBe(false)
    expect(isCockpitMode('tablet')).toBe(true)
    expect(isCockpitMode('wide')).toBe(true)
  })
})
