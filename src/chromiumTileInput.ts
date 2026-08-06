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
    // CDP wheel deltas are "content moves opposite" like DOM, but Chrome
    // expects positive-up: negate the DOM convention.
    deltaX: -event.deltaX,
    deltaY: -event.deltaY,
    modifiers: cdpModifiers(event),
  }
}

type TileKeyboardEvent = ModifierState & {
  type: string
  key: string
  code: string
}

/**
 * Maps one DOM keyboard event to the CDP key messages to send. A printable
 * key press needs a keyDown followed by a char event carrying the text, or
 * typed characters never reach the page.
 */
export function tileKeyMessages(event: TileKeyboardEvent): TileKeyMessage[] {
  const modifiers = cdpModifiers(event)
  if (event.type === 'keyup') {
    return [{ kind: 'key', type: 'keyUp', key: event.key, code: event.code, modifiers }]
  }
  if (event.type !== 'keydown') return []
  const messages: TileKeyMessage[] = [
    { kind: 'key', type: 'keyDown', key: event.key, code: event.code, modifiers },
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
