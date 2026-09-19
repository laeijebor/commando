import { keyboardOverlap } from './keyboardInset'

describe('keyboardOverlap', () => {
  it('lifts by the part of the keyboard the tab bar does not already cover', () => {
    // iPhone 17 Pro Max: a 336pt keyboard drawn over an 83pt tab bar.
    expect(keyboardOverlap(336, 83)).toBe(253)
  })

  it('is zero while the keyboard is closed', () => {
    expect(keyboardOverlap(0, 83)).toBe(0)
  })

  it('lifts by the whole keyboard when there is no tab bar', () => {
    expect(keyboardOverlap(336, 0)).toBe(336)
  })

  it('never returns a negative inset', () => {
    // A hardware keyboard leaves only the small accessory bar on screen.
    expect(keyboardOverlap(55, 83)).toBe(0)
  })

  it('ignores measurements that are not usable numbers', () => {
    expect(keyboardOverlap(Number.NaN, 83)).toBe(0)
    expect(keyboardOverlap(336, Number.NaN)).toBe(336)
  })
})
