/** The keyboard's end frame as React Native reports it, in screen points. */
export type KeyboardFrame = { screenY: number; height: number }

/** The body's frame in window points: its top and bottom edges. */
export type BodyFrame = { top: number; bottom: number }

/**
 * Every keyboard event the overlap follows. Third-party keyboards (SwiftKey,
 * Gboard) can post a provisional frame with the will-show and correct it only
 * through a later frame change, sometimes only the did-change, so each one
 * replaces the frame and the latest always wins.
 */
export const KEYBOARD_FRAME_EVENTS = [
  'keyboardWillShow',
  'keyboardDidShow',
  'keyboardWillChangeFrame',
  'keyboardDidChangeFrame',
  'keyboardWillHide',
  'keyboardDidHide',
] as const

export type KeyboardFrameEvent = (typeof KEYBOARD_FRAME_EVENTS)[number]

/** The height the chat body keeps whatever the keyboard reports: the composer at its smallest, plus a sliver. */
export const MIN_CHAT_BODY = 120

/** The keyboard's frame after an event: a hide clears it, and anything else replaces it with the event's end frame. */
export function nextKeyboardFrame(event: KeyboardFrameEvent, end: KeyboardFrame | undefined): KeyboardFrame | null {
  if (event === 'keyboardWillHide' || event === 'keyboardDidHide' || !end) return null
  return { screenY: end.screenY, height: end.height }
}

/**
 * How much of the body the keyboard covers: the body's bottom less the
 * keyboard's top edge. The keyboard's height isn't used, since a provisional
 * frame can carry one that is far taller than the keyboard on screen.
 *
 * A keyboard that is off screen, or floating or undocked on an iPad (it ends
 * above the bottom edge), covers nothing. The result never leaves the body
 * shorter than `minBody`, so a bad frame can't push the composer out of view.
 */
export function keyboardOverlap(
  keyboard: KeyboardFrame | null,
  body: BodyFrame | null,
  windowHeight: number,
  minBody: number = MIN_CHAT_BODY,
): number {
  if (!keyboard || !body || keyboard.height <= 0) return 0
  const { screenY, height } = keyboard
  if (screenY >= windowHeight - 1) return 0
  if (screenY + height < windowHeight - 1) return 0
  const covered = body.bottom - screenY
  const room = body.bottom - body.top - minBody
  return Math.max(0, Math.min(covered, room))
}
