/**
 * Pure DOM-event → CDP Input.* mappings for chromium tiles. Kept free of
 * React/WebSocket so the translation layer is unit-testable.
 */

export type TileMouseMessage = {
  kind: 'mouse'
  type: 'mousePressed' | 'mouseReleased' | 'mouseMoved'
  x: number
  y: number
  button: 'none' | 'left' | 'middle' | 'right'
  clickCount: number
  modifiers: number
}

export type TileWheelMessage = {
  kind: 'wheel'
  x: number
  y: number
  deltaX: number
  deltaY: number
  modifiers: number
}

export type TileKeyMessage = {
  kind: 'key'
  type: 'keyDown' | 'keyUp' | 'char'
  key?: string
  code?: string
  text?: string
  windowsVirtualKeyCode?: number
  modifiers: number
}

type ModifierState = {
  altKey: boolean
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
}

/** CDP modifier bitmask: Alt=1, Ctrl=2, Meta=4, Shift=8. */
export function cdpModifiers(event: ModifierState): number {
  return (event.altKey ? 1 : 0) | (event.ctrlKey ? 2 : 0) | (event.metaKey ? 4 : 0) | (event.shiftKey ? 8 : 0)
}

export function cdpMouseButton(button: number): 'none' | 'left' | 'middle' | 'right' {
  return button === 0 ? 'left' : button === 1 ? 'middle' : button === 2 ? 'right' : 'none'
}

type TileMouseEvent = ModifierState & {
  type: string
  offsetX: number
  offsetY: number
  button: number
  detail: number
}

export function tileMouseMessage(event: TileMouseEvent): TileMouseMessage | null {
  const type =
    event.type === 'mousedown' ? 'mousePressed'
    : event.type === 'mouseup' ? 'mouseReleased'
    : event.type === 'mousemove' ? 'mouseMoved'
    : null
  if (!type) return null
  return {
    kind: 'mouse',
    type,
    x: Math.max(0, Math.round(event.offsetX)),
    y: Math.max(0, Math.round(event.offsetY)),
    button: type === 'mouseMoved' ? 'none' : cdpMouseButton(event.button),
    clickCount: type === 'mouseMoved' ? 0 : Math.max(1, Math.min(3, event.detail || 1)),
    modifiers: cdpModifiers(event),
  }
}

type TileWheelEvent = ModifierState & {
  offsetX: number
  offsetY: number
  deltaX: number
  deltaY: number
}

export function tileWheelMessage(event: TileWheelEvent): TileWheelMessage {
  return {
    kind: 'wheel',
    x: Math.max(0, Math.round(event.offsetX)),
    y: Math.max(0, Math.round(event.offsetY)),
    // CDP Input.dispatchMouseEvent shares the DOM sign convention
    // (positive deltaY scrolls down), so deltas pass through unchanged.
    deltaX: event.deltaX,
    deltaY: event.deltaY,
    modifiers: cdpModifiers(event),
  }
}

/**
 * React registers its root wheel listeners as passive, so preventDefault from
 * a synthetic onWheel cannot stop the cockpit page scrolling under the tile.
 * The capture must be a native non-passive listener on the tile element.
 */
export function attachTileWheelCapture(
  target: HTMLElement,
  send: (message: TileWheelMessage) => void,
): () => void {
  const onWheel = (event: WheelEvent) => {
    event.preventDefault()
    send(tileWheelMessage(event))
  }
  target.addEventListener('wheel', onWheel, { passive: false })
  return () => target.removeEventListener('wheel', onWheel)
}

type TileKeyboardEvent = ModifierState & {
  type: string
  key: string
  code: string
}

const NAMED_KEY_VK: Record<string, number> = {
  Backspace: 8,
  Tab: 9,
  Enter: 13,
  Shift: 16,
  Control: 17,
  Alt: 18,
  CapsLock: 20,
  Escape: 27,
  PageUp: 33,
  PageDown: 34,
  End: 35,
  Home: 36,
  ArrowLeft: 37,
  ArrowUp: 38,
  ArrowRight: 39,
  ArrowDown: 40,
  Insert: 45,
  Delete: 46,
  Meta: 91,
  ContextMenu: 93,
}

const PUNCTUATION_CODE_VK: Record<string, number> = {
  Space: 32,
  Semicolon: 186,
  Equal: 187,
  Comma: 188,
  Minus: 189,
  Period: 190,
  Slash: 191,
  Backquote: 192,
  BracketLeft: 219,
  Backslash: 220,
  BracketRight: 221,
  Quote: 222,
  IntlBackslash: 226,
}

/**
 * Windows virtual key code for a DOM keyboard event. The renderer only runs
 * editing behavior (backspace deletion, caret movement, selection) for key
 * events that carry one — without it, non-printable keys are inert.
 */
export function windowsVirtualKeyCode(key: string, code: string): number | undefined {
  const named = NAMED_KEY_VK[key]
  if (named !== undefined) return named
  if (/^F([1-9]|1[0-2])$/.test(key)) return 111 + Number(key.slice(1))
  if (/^Key[A-Z]$/.test(code)) return code.charCodeAt(3)
  if (/^Digit[0-9]$/.test(code)) return 48 + Number(code[5])
  if (/^Numpad[0-9]$/.test(code)) return 96 + Number(code[6])
  return PUNCTUATION_CODE_VK[code]
}

/**
 * Maps one DOM keyboard event to the CDP key messages to send. A printable
 * key press needs a keyDown followed by a char event carrying the text, or
 * typed characters never reach the page.
 */
export function tileKeyMessages(event: TileKeyboardEvent): TileKeyMessage[] {
  const modifiers = cdpModifiers(event)
  const vk = windowsVirtualKeyCode(event.key, event.code)
  if (event.type === 'keyup') {
    return [
      {
        kind: 'key',
        type: 'keyUp',
        key: event.key,
        code: event.code,
        windowsVirtualKeyCode: vk,
        modifiers,
      },
    ]
  }
  if (event.type !== 'keydown') return []
  const messages: TileKeyMessage[] = [
    {
      kind: 'key',
      type: 'keyDown',
      key: event.key,
      code: event.code,
      windowsVirtualKeyCode: vk,
      modifiers,
    },
  ]
  const printable = event.key.length === 1 && !event.ctrlKey && !event.metaKey
  if (printable) {
    messages.push({ kind: 'key', type: 'char', text: event.key, key: event.key, modifiers })
  } else if (event.key === 'Enter') {
    messages.push({ kind: 'key', type: 'char', text: '\r', key: 'Enter', modifiers })
  }
  return messages
}

/** Keys the tile consumes: stop the cockpit's own shortcuts and scrolling. */
export function shouldCaptureKey(key: string): boolean {
  return key !== 'Escape'
}
