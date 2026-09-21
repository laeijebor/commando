/**
 * Touch → CDP `Input.*` mapping for chromium tiles, ported from the cockpit's
 * `src/chromiumTileInput.ts`. The message shapes are the daemon's contract
 * (`parseTileInputEvent` in `server/chromium-engine.ts`), so they are copied
 * exactly; only the *source* events differ — a phone has taps, pans and long
 * presses instead of a mouse and a wheel.
 *
 * Everything here is pure so the translation is unit-testable without a
 * socket or a gesture recogniser.
 */

export type TileMouseMessage = {
  kind: 'mouse'
  type: 'mousePressed' | 'mouseReleased' | 'mouseMoved'
  x: number
  y: number
  button: 'none' | 'left' | 'middle' | 'right'
  buttons: number
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

export type TileInputMessage = TileMouseMessage | TileWheelMessage | TileKeyMessage

export type ModifierState = {
  altKey?: boolean
  ctrlKey?: boolean
  metaKey?: boolean
  shiftKey?: boolean
}

/** CDP modifier bitmask: Alt=1, Ctrl=2, Meta=4, Shift=8. */
export function cdpModifiers(event: ModifierState = {}): number {
  return (event.altKey ? 1 : 0) | (event.ctrlKey ? 2 : 0) | (event.metaKey ? 4 : 0) | (event.shiftKey ? 8 : 0)
}

/** CDP `buttons` bitmask for a held button; left=1, right=2, middle=4. */
export function cdpHeldButtons(button: 'none' | 'left' | 'middle' | 'right'): number {
  return button === 'left' ? 1 : button === 'right' ? 2 : button === 'middle' ? 4 : 0
}

/**
 * The tile's on-screen box and the viewport the daemon was told to lay the
 * page out at. They are normally the same number of CSS pixels (the phone
 * sends its measured size), but a frame drawn letterboxed or a viewport that
 * has not caught up with a rotation must still land input on the right
 * element, so every touch goes through the scale explicitly.
 */
export type TileGeometry = {
  /** Measured size of the rendered frame, in the view's own units. */
  view: { width: number; height: number }
  /** CSS-pixel viewport the daemon last acknowledged for this tile. */
  viewport: { width: number; height: number }
}

export type TilePoint = { x: number; y: number }

/** Largest viewport dimension the daemon will accept (`MAX_VIEWPORT_DIMENSION`). */
export const MAX_VIEWPORT_DIMENSION = 8_192

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.max(min, Math.min(max, value))
}

/**
 * View coordinates → page coordinates. Points outside the frame are clamped
 * into it rather than dropped: a touch that starts on the edge still has to
 * produce a legal CDP coordinate, and the daemon rejects out-of-range ones.
 */
export function toViewportPoint(point: TilePoint, geometry: TileGeometry): TilePoint {
  const scaleX = geometry.view.width > 0 ? geometry.viewport.width / geometry.view.width : 1
  const scaleY = geometry.view.height > 0 ? geometry.viewport.height / geometry.view.height : 1
  const maxX = Math.max(0, Math.min(MAX_VIEWPORT_DIMENSION, Math.round(geometry.viewport.width)))
  const maxY = Math.max(0, Math.min(MAX_VIEWPORT_DIMENSION, Math.round(geometry.viewport.height)))
  return {
    x: clamp(Math.round(point.x * scaleX), 0, maxX),
    y: clamp(Math.round(point.y * scaleY), 0, maxY),
  }
}

/**
 * Page coordinates → view coordinates: the inverse of `toViewportPoint`, used
 * to draw the element highlight and the pending pins on top of the frame.
 */
export function toViewRect(
  rect: { x: number; y: number; width: number; height: number },
  geometry: TileGeometry,
): { x: number; y: number; width: number; height: number } {
  const scaleX = geometry.viewport.width > 0 ? geometry.view.width / geometry.viewport.width : 1
  const scaleY = geometry.viewport.height > 0 ? geometry.view.height / geometry.viewport.height : 1
  return {
    x: rect.x * scaleX,
    y: rect.y * scaleY,
    width: rect.width * scaleX,
    height: rect.height * scaleY,
  }
}

/** Scales a distance (not a position), so pans move the page by what the finger moved. */
export function toViewportDelta(delta: TilePoint, geometry: TileGeometry): TilePoint {
  const scaleX = geometry.view.width > 0 ? geometry.viewport.width / geometry.view.width : 1
  const scaleY = geometry.view.height > 0 ? geometry.viewport.height / geometry.view.height : 1
  return {
    x: clamp(Math.round(delta.x * scaleX), -10_000, 10_000),
    y: clamp(Math.round(delta.y * scaleY), -10_000, 10_000),
  }
}

function mouse(
  type: TileMouseMessage['type'],
  point: TilePoint,
  button: TileMouseMessage['button'],
  clickCount: number,
  modifiers: number,
  held: boolean,
): TileMouseMessage {
  return {
    kind: 'mouse',
    type,
    x: point.x,
    y: point.y,
    button,
    buttons: held ? cdpHeldButtons(button) : 0,
    clickCount,
    modifiers,
  }
}

/**
 * A tap is a press and a release at the same point with `clickCount: 1` —
 * exactly what a mouse click sends, which is what the page's click handlers
 * are listening for.
 */
export function tileTapMessages(
  point: TilePoint,
  geometry: TileGeometry,
  modifiers: ModifierState = {},
): TileMouseMessage[] {
  const at = toViewportPoint(point, geometry)
  const bits = cdpModifiers(modifiers)
  return [
    mouse('mousePressed', at, 'left', 1, bits, true),
    mouse('mouseReleased', at, 'left', 1, bits, false),
  ]
}

/**
 * A long press is the phone's right click: the same press/release pair with
 * the right button, which opens context menus and custom `contextmenu`
 * handlers in the page.
 */
export function tileLongPressMessages(
  point: TilePoint,
  geometry: TileGeometry,
  modifiers: ModifierState = {},
): TileMouseMessage[] {
  const at = toViewportPoint(point, geometry)
  const bits = cdpModifiers(modifiers)
  return [
    mouse('mousePressed', at, 'right', 1, bits, true),
    mouse('mouseReleased', at, 'right', 1, bits, false),
  ]
}

/**
 * A pan scrolls rather than drags: the finger moving up pulls the content up,
 * which is a positive `deltaY` in the DOM (and CDP) sign convention, so the
 * movement is negated. Wheels are what every page already handles; synthesising
 * touch events would need a whole second CDP surface.
 */
export function tilePanMessage(
  point: TilePoint,
  movement: TilePoint,
  geometry: TileGeometry,
  modifiers: ModifierState = {},
): TileWheelMessage {
  const at = toViewportPoint(point, geometry)
  const delta = toViewportDelta(movement, geometry)
  return {
    kind: 'wheel',
    x: at.x,
    y: at.y,
    // `-0` is a legal number that reads badly in a log; normalise it away.
    deltaX: delta.x === 0 ? 0 : -delta.x,
    deltaY: delta.y === 0 ? 0 : -delta.y,
    modifiers: cdpModifiers(modifiers),
  }
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

/** The `code` a printable character would arrive with on a US keyboard. */
export function domCodeForCharacter(character: string): string | undefined {
  if (character === ' ') return 'Space'
  if (/^[a-zA-Z]$/.test(character)) return `Key${character.toUpperCase()}`
  if (/^[0-9]$/.test(character)) return `Digit${character}`
  return undefined
}

/**
 * Windows virtual key code for a key. The renderer only runs editing
 * behaviour (backspace deletion, caret movement, selection) for key events
 * that carry one — without it, non-printable keys are inert.
 */
export function windowsVirtualKeyCode(key: string, code?: string): number | undefined {
  const named = NAMED_KEY_VK[key]
  if (named !== undefined) return named
  if (/^F([1-9]|1[0-2])$/.test(key)) return 111 + Number(key.slice(1))
  const resolved = code ?? domCodeForCharacter(key)
  if (resolved === undefined) return undefined
  if (/^Key[A-Z]$/.test(resolved)) return resolved.charCodeAt(3)
  if (/^Digit[0-9]$/.test(resolved)) return 48 + Number(resolved[5])
  if (/^Numpad[0-9]$/.test(resolved)) return 96 + Number(resolved[6])
  return PUNCTUATION_CODE_VK[resolved]
}

/**
 * One key press → the CDP messages the page needs. A printable key needs a
 * `keyDown`, then a `char` carrying the text, then a `keyUp`, or the typed
 * character never reaches the field. Enter carries a carriage return as its
 * text, the way a browser does.
 */
export function tileKeyMessages(key: string, modifiers: ModifierState = {}): TileKeyMessage[] {
  const bits = cdpModifiers(modifiers)
  const code = domCodeForCharacter(key)
  const virtualKey = windowsVirtualKeyCode(key, code)
  const down: TileKeyMessage = {
    kind: 'key',
    type: 'keyDown',
    key,
    ...(code !== undefined ? { code } : {}),
    ...(virtualKey !== undefined ? { windowsVirtualKeyCode: virtualKey } : {}),
    modifiers: bits,
  }
  const up: TileKeyMessage = {
    kind: 'key',
    type: 'keyUp',
    key,
    ...(code !== undefined ? { code } : {}),
    ...(virtualKey !== undefined ? { windowsVirtualKeyCode: virtualKey } : {}),
    modifiers: bits,
  }
  const printable = key.length === 1 && !modifiers.ctrlKey && !modifiers.metaKey
  if (printable) {
    return [down, { kind: 'key', type: 'char', text: key, key, modifiers: bits }, up]
  }
  if (key === 'Enter') {
    return [down, { kind: 'key', type: 'char', text: '\r', key: 'Enter', modifiers: bits }, up]
  }
  return [down, up]
}

/**
 * Types a whole string one character at a time. The phone's text field hands
 * over finished text rather than keystrokes, so the page is fed the same
 * per-character sequence a keyboard would have produced — pages that validate
 * on `input` or `keydown` behave as if someone typed it.
 */
export function tileTypingMessages(text: string, modifiers: ModifierState = {}): TileKeyMessage[] {
  const messages: TileKeyMessage[] = []
  for (const character of [...text]) {
    messages.push(...tileKeyMessages(character === '\n' ? 'Enter' : character, modifiers))
  }
  return messages
}
