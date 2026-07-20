import { describe, expect, it } from 'vitest'
import { sessionShortcutIndex } from './sessionShortcuts'

describe('sessionShortcutIndex', () => {
  it.each([
    ['1', 0],
    ['5', 4],
    ['9', 8],
  ])('maps Cmd+%s to session index %i', (key, index) => {
    expect(sessionShortcutIndex({ key, metaKey: true, ctrlKey: false, altKey: false, shiftKey: false })).toBe(index)
  })

  it('rejects unsupported keys and modifier combinations', () => {
    expect(sessionShortcutIndex({ key: '0', metaKey: true, ctrlKey: false, altKey: false, shiftKey: false })).toBeNull()
    expect(sessionShortcutIndex({ key: '1', metaKey: false, ctrlKey: true, altKey: false, shiftKey: false })).toBeNull()
    expect(sessionShortcutIndex({ key: '1', metaKey: true, ctrlKey: false, altKey: false, shiftKey: true })).toBeNull()
  })
})
