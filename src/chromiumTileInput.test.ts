import { describe, expect, it } from 'vitest'
import {
  cdpModifiers,
  cdpMouseButton,
  isCopyShortcut,
  tileKeyMessages,
  tileMouseMessage,
  tileWheelMessage,
  windowsVirtualKeyCode,
} from './chromiumTileInput'

const noModifiers = { altKey: false, ctrlKey: false, metaKey: false, shiftKey: false }

describe('chromium tile input mapping', () => {
  it('maps modifier state to the CDP bitmask', () => {
    expect(cdpModifiers(noModifiers)).toBe(0)
    expect(cdpModifiers({ ...noModifiers, altKey: true })).toBe(1)
    expect(cdpModifiers({ ...noModifiers, ctrlKey: true, shiftKey: true })).toBe(10)
    expect(cdpModifiers({ altKey: true, ctrlKey: true, metaKey: true, shiftKey: true })).toBe(15)
  })

  it('maps mouse events with buttons and click counts', () => {
    expect(cdpMouseButton(0)).toBe('left')
    expect(cdpMouseButton(2)).toBe('right')
    expect(
      tileMouseMessage({ ...noModifiers, type: 'pointerdown', offsetX: 10.6, offsetY: 4.2, button: 0, buttons: 1, detail: 2 }),
    ).toMatchObject({ type: 'mousePressed', x: 11, y: 4, button: 'left', buttons: 1, clickCount: 2 })
    expect(
      tileMouseMessage({ ...noModifiers, type: 'pointermove', offsetX: 5, offsetY: 6, button: -1, buttons: 1, detail: 0 }),
    ).toMatchObject({ type: 'mouseMoved', button: 'none', buttons: 1, clickCount: 0 })
    expect(
      tileMouseMessage({ ...noModifiers, type: 'dblclick', offsetX: 1, offsetY: 1, button: 0, buttons: 0, detail: 2 }),
    ).toBeNull()
  })

  it('recognizes only exact browser copy shortcuts', () => {
    expect(isCopyShortcut({ ...noModifiers, metaKey: true, key: 'c' })).toBe(true)
    expect(isCopyShortcut({ ...noModifiers, ctrlKey: true, key: 'C' })).toBe(true)
    expect(isCopyShortcut({ ...noModifiers, metaKey: true, shiftKey: true, key: 'c' })).toBe(false)
    expect(isCopyShortcut({ ...noModifiers, metaKey: true, ctrlKey: true, key: 'c' })).toBe(false)
    expect(isCopyShortcut({ ...noModifiers, key: 'c' })).toBe(false)
  })

  it('passes DOM wheel deltas through unchanged (CDP shares the DOM sign convention)', () => {
    expect(
      tileWheelMessage({ ...noModifiers, offsetX: 3, offsetY: 4, deltaX: 5, deltaY: 120 }),
    ).toMatchObject({ deltaX: 5, deltaY: 120 })
  })

  it('emits keyDown + char for printable keys and Enter', () => {
    expect(tileKeyMessages({ ...noModifiers, type: 'keydown', key: 'a', code: 'KeyA' })).toEqual([
      expect.objectContaining({ type: 'keyDown', key: 'a' }),
      expect.objectContaining({ type: 'char', text: 'a' }),
    ])
    expect(tileKeyMessages({ ...noModifiers, type: 'keydown', key: 'Enter', code: 'Enter' })).toEqual([
      expect.objectContaining({ type: 'keyDown' }),
      expect.objectContaining({ type: 'char', text: '\r' }),
    ])
    // Shortcuts must not type: no char event with ctrl/meta held.
    expect(
      tileKeyMessages({ ...noModifiers, metaKey: true, type: 'keydown', key: 'a', code: 'KeyA' }),
    ).toHaveLength(1)
    expect(tileKeyMessages({ ...noModifiers, type: 'keyup', key: 'a', code: 'KeyA' })).toEqual([
      expect.objectContaining({ type: 'keyUp' }),
    ])
  })

  it('maps keys to Windows virtual key codes', () => {
    expect(windowsVirtualKeyCode('Backspace', 'Backspace')).toBe(8)
    expect(windowsVirtualKeyCode('Tab', 'Tab')).toBe(9)
    expect(windowsVirtualKeyCode('Enter', 'Enter')).toBe(13)
    expect(windowsVirtualKeyCode('Shift', 'ShiftLeft')).toBe(16)
    expect(windowsVirtualKeyCode('ArrowLeft', 'ArrowLeft')).toBe(37)
    expect(windowsVirtualKeyCode('ArrowUp', 'ArrowUp')).toBe(38)
    expect(windowsVirtualKeyCode('ArrowRight', 'ArrowRight')).toBe(39)
    expect(windowsVirtualKeyCode('ArrowDown', 'ArrowDown')).toBe(40)
    expect(windowsVirtualKeyCode('Delete', 'Delete')).toBe(46)
    expect(windowsVirtualKeyCode('Home', 'Home')).toBe(36)
    expect(windowsVirtualKeyCode('End', 'End')).toBe(35)
    expect(windowsVirtualKeyCode('PageUp', 'PageUp')).toBe(33)
    expect(windowsVirtualKeyCode('PageDown', 'PageDown')).toBe(34)
    expect(windowsVirtualKeyCode('a', 'KeyA')).toBe(65)
    expect(windowsVirtualKeyCode('Z', 'KeyZ')).toBe(90)
    expect(windowsVirtualKeyCode('5', 'Digit5')).toBe(53)
    expect(windowsVirtualKeyCode('5', 'Numpad5')).toBe(101)
    expect(windowsVirtualKeyCode(' ', 'Space')).toBe(32)
    expect(windowsVirtualKeyCode('.', 'Period')).toBe(190)
    expect(windowsVirtualKeyCode('F5', 'F5')).toBe(116)
    expect(windowsVirtualKeyCode('µ', 'IntlWeird')).toBeUndefined()
  })

  it('attaches the virtual key code to keyDown and keyUp so editing keys act', () => {
    const [down] = tileKeyMessages({ ...noModifiers, type: 'keydown', key: 'Backspace', code: 'Backspace' })
    expect(down).toMatchObject({ type: 'keyDown', key: 'Backspace', windowsVirtualKeyCode: 8 })
    const [up] = tileKeyMessages({ ...noModifiers, type: 'keyup', key: 'ArrowLeft', code: 'ArrowLeft' })
    expect(up).toMatchObject({ type: 'keyUp', windowsVirtualKeyCode: 37 })
    const shifted = tileKeyMessages({
      ...noModifiers,
      shiftKey: true,
      type: 'keydown',
      key: 'ArrowRight',
      code: 'ArrowRight',
    })
    expect(shifted[0]).toMatchObject({ windowsVirtualKeyCode: 39, modifiers: 8 })
  })
})
