import {
  cdpModifiers,
  tileKeyMessages,
  tileLongPressMessages,
  tilePanMessage,
  tileTapMessages,
  tileTypingMessages,
  toViewportDelta,
  toViewportPoint,
  toViewRect,
  windowsVirtualKeyCode,
} from './input'

/** The phone measured 390×640 but told the daemon to lay out at 780×1280. */
const SCALED = { view: { width: 390, height: 640 }, viewport: { width: 780, height: 1280 } }
const ONE_TO_ONE = { view: { width: 390, height: 640 }, viewport: { width: 390, height: 640 } }

describe('view to viewport coordinates', () => {
  it('scales a touch into the viewport the daemon was told about', () => {
    expect(toViewportPoint({ x: 100, y: 200 }, SCALED)).toEqual({ x: 200, y: 400 })
  })

  it('passes a touch through when the view and the viewport match', () => {
    expect(toViewportPoint({ x: 37, y: 512 }, ONE_TO_ONE)).toEqual({ x: 37, y: 512 })
  })

  it('clamps to the viewport, because the daemon rejects out-of-range points', () => {
    expect(toViewportPoint({ x: -12, y: 9_999 }, ONE_TO_ONE)).toEqual({ x: 0, y: 640 })
  })

  it('scales distances as well as positions', () => {
    expect(toViewportDelta({ x: -5, y: 12 }, SCALED)).toEqual({ x: -10, y: 24 })
  })
})

describe('tap', () => {
  it('is a press and a release with clickCount 1, like a mouse click', () => {
    expect(tileTapMessages({ x: 10, y: 20 }, ONE_TO_ONE)).toEqual([
      { kind: 'mouse', type: 'mousePressed', x: 10, y: 20, button: 'left', buttons: 1, clickCount: 1, modifiers: 0 },
      { kind: 'mouse', type: 'mouseReleased', x: 10, y: 20, button: 'left', buttons: 0, clickCount: 1, modifiers: 0 },
    ])
  })

  it('lands on the scaled point, not the touch point', () => {
    const [pressed] = tileTapMessages({ x: 10, y: 20 }, SCALED)
    expect(pressed).toMatchObject({ x: 20, y: 40 })
  })
})

describe('long press', () => {
  it('is a right click', () => {
    expect(tileLongPressMessages({ x: 4, y: 8 }, ONE_TO_ONE)).toEqual([
      { kind: 'mouse', type: 'mousePressed', x: 4, y: 8, button: 'right', buttons: 2, clickCount: 1, modifiers: 0 },
      { kind: 'mouse', type: 'mouseReleased', x: 4, y: 8, button: 'right', buttons: 0, clickCount: 1, modifiers: 0 },
    ])
  })
})

describe('pan', () => {
  it('scrolls the page the way the finger dragged it', () => {
    // A finger moving up (negative dy) scrolls the page down: positive deltaY.
    expect(tilePanMessage({ x: 100, y: 300 }, { x: 0, y: -40 }, ONE_TO_ONE)).toEqual({
      kind: 'wheel',
      x: 100,
      y: 300,
      deltaX: 0,
      deltaY: 40,
      modifiers: 0,
    })
  })

  it('scales the wheel delta with the viewport', () => {
    expect(tilePanMessage({ x: 0, y: 0 }, { x: 0, y: -40 }, SCALED)).toMatchObject({ deltaY: 80 })
  })
})

describe('modifiers', () => {
  it('uses the CDP bitmask', () => {
    expect(cdpModifiers({})).toBe(0)
    expect(cdpModifiers({ altKey: true })).toBe(1)
    expect(cdpModifiers({ ctrlKey: true })).toBe(2)
    expect(cdpModifiers({ metaKey: true })).toBe(4)
    expect(cdpModifiers({ shiftKey: true })).toBe(8)
    expect(cdpModifiers({ ctrlKey: true, shiftKey: true })).toBe(10)
  })
})

describe('typing', () => {
  it('sends keyDown, char and keyUp for a printable key', () => {
    expect(tileKeyMessages('a')).toEqual([
      { kind: 'key', type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 0 },
      { kind: 'key', type: 'char', text: 'a', key: 'a', modifiers: 0 },
      { kind: 'key', type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 0 },
    ])
  })

  it('gives Enter a carriage return, the way a browser does', () => {
    const [, char] = tileKeyMessages('Enter')
    expect(char).toEqual({ kind: 'key', type: 'char', text: '\r', key: 'Enter', modifiers: 0 })
  })

  it('sends no char for a key that types nothing', () => {
    expect(tileKeyMessages('Backspace')).toEqual([
      { kind: 'key', type: 'keyDown', key: 'Backspace', windowsVirtualKeyCode: 8, modifiers: 0 },
      { kind: 'key', type: 'keyUp', key: 'Backspace', windowsVirtualKeyCode: 8, modifiers: 0 },
    ])
  })

  it('resolves virtual key codes the renderer needs for editing', () => {
    expect(windowsVirtualKeyCode('ArrowLeft')).toBe(37)
    expect(windowsVirtualKeyCode('7')).toBe(55)
    expect(windowsVirtualKeyCode(' ')).toBe(32)
    expect(windowsVirtualKeyCode('F5')).toBe(116)
  })

  it('types a string one character at a time, turning newlines into Enter', () => {
    const messages = tileTypingMessages('hi\n')
    expect(messages).toHaveLength(9)
    expect(messages.filter((message) => message.type === 'char').map((message) => message.text))
      .toEqual(['h', 'i', '\r'])
  })
})

describe('viewport to view rectangles', () => {
  it('scales a highlight back onto the frame the phone is showing', () => {
    expect(toViewRect({ x: 20, y: 40, width: 100, height: 60 }, SCALED)).toEqual({
      x: 10,
      y: 20,
      width: 50,
      height: 30,
    })
  })
})
