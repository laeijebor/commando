import { describe, expect, it, vi } from 'vitest'
import { MAX_PASTE_BYTES, type SpecialKey } from '../shared/protocol'
import { dispatchBoundedPaste, semanticKeyForEvent } from './terminalInput'

function keyEvent(
  key: string,
  modifiers: Partial<Pick<KeyboardEvent, 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey'>> = {},
) {
  return {
    key,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    ...modifiers,
  }
}

describe('terminal semantic key mapping', () => {
  it('maps navigation, editing, and function keys to protocol names', () => {
    const mappings: Array<[string, SpecialKey]> = [
      ['Enter', 'Enter'],
      ['Backspace', 'Backspace'],
      ['Tab', 'Tab'],
      ['Escape', 'Escape'],
      ['ArrowUp', 'Up'],
      ['ArrowDown', 'Down'],
      ['ArrowLeft', 'Left'],
      ['ArrowRight', 'Right'],
      ['Home', 'Home'],
      ['End', 'End'],
      ['Insert', 'Insert'],
      ['Delete', 'Delete'],
      ['PageUp', 'PageUp'],
      ['PageDown', 'PageDown'],
      ...Array.from({ length: 12 }, (_, index) => [
        `F${index + 1}`,
        `F${index + 1}` as SpecialKey,
      ] as [string, SpecialKey]),
    ]

    for (const [key, expected] of mappings) {
      expect(semanticKeyForEvent(keyEvent(key))).toBe(expected)
    }
  })

  it('forwards supported control keys semantically without consuming other controls', () => {
    expect(semanticKeyForEvent(keyEvent('c', { ctrlKey: true }))).toBe('C-c')
    expect(semanticKeyForEvent(keyEvent('D', { ctrlKey: true }))).toBe('C-d')
    expect(semanticKeyForEvent(keyEvent('k', { ctrlKey: true }))).toBeNull()
    expect(semanticKeyForEvent(keyEvent('ArrowUp', { altKey: true }))).toBeNull()
    expect(semanticKeyForEvent(keyEvent('Tab', { shiftKey: true }))).toBeNull()
  })
})

describe('terminal paste dispatch', () => {
  it('dispatches a large allowed paste once without input-style chunking', () => {
    const dispatch = vi.fn()
    const data = 'x'.repeat(64 * 1024)

    expect(dispatchBoundedPaste(data, dispatch)).toBe('sent')
    expect(dispatch).toHaveBeenCalledOnce()
    expect(dispatch).toHaveBeenCalledWith(data)
  })

  it('enforces the UTF-8 byte bound before dispatch', () => {
    const dispatch = vi.fn()
    const bounded = 'é'.repeat(MAX_PASTE_BYTES / 2)

    expect(dispatchBoundedPaste(bounded, dispatch)).toBe('sent')
    expect(dispatchBoundedPaste(`${bounded}x`, dispatch)).toBe('too-large')
    expect(dispatchBoundedPaste('', dispatch)).toBe('empty')
    expect(dispatchBoundedPaste('bad\0paste', dispatch)).toBe('invalid')
    expect(dispatch).toHaveBeenCalledOnce()
  })
})
