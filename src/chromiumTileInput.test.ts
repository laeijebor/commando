import { describe, expect, it } from 'vitest'
import {
  cdpModifiers,
  cdpMouseButton,
  tileKeyMessages,
  tileMouseMessage,
  tileWheelMessage,
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
      tileMouseMessage({ ...noModifiers, type: 'mousedown', offsetX: 10.6, offsetY: 4.2, button: 0, detail: 2 }),
    ).toMatchObject({ type: 'mousePressed', x: 11, y: 4, button: 'left', clickCount: 2 })
    expect(
      tileMouseMessage({ ...noModifiers, type: 'mousemove', offsetX: 5, offsetY: 6, button: 0, detail: 0 }),
    ).toMatchObject({ type: 'mouseMoved', button: 'none', clickCount: 0 })
    expect(
      tileMouseMessage({ ...noModifiers, type: 'dblclick', offsetX: 1, offsetY: 1, button: 0, detail: 2 }),
    ).toBeNull()
  })

  it('negates DOM wheel deltas for CDP', () => {
    expect(
      tileWheelMessage({ ...noModifiers, offsetX: 3, offsetY: 4, deltaX: 0, deltaY: 120 }),
    ).toMatchObject({ deltaX: -0, deltaY: -120 })
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
})
