/**
 * Line editing in the composer, as in a terminal: Home or Ctrl+A goes to the
 * start of the line, End or Ctrl+E to its end, and Ctrl+J starts a new line.
 * A line is a logical one (between newlines), not a wrapped row. Cmd+A still
 * selects everything.
 */

type LineKey = Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>

export type LineEdit =
  | { kind: 'select'; start: number; end: number; direction: 'forward' | 'backward' | 'none' }
  | { kind: 'insert'; text: string }

export function lineStart(value: string, position: number): number {
  return value.lastIndexOf('\n', position - 1) + 1
}

export function lineEnd(value: string, position: number): number {
  const next = value.indexOf('\n', position)
  return next < 0 ? value.length : next
}

function lineMove(key: LineKey): 'start' | 'end' | null {
  if (key.metaKey || key.altKey) return null
  if (!key.ctrlKey && key.key === 'Home') return 'start'
  if (!key.ctrlKey && key.key === 'End') return 'end'
  if (key.ctrlKey && !key.shiftKey) {
    const letter = key.key.toLowerCase()
    if (letter === 'a') return 'start'
    if (letter === 'e') return 'end'
  }
  return null
}

/** What a key does to the textarea, or null when it is not a line-editing key. */
export function lineEditFor(
  key: LineKey,
  field: { value: string; selectionStart: number; selectionEnd: number; selectionDirection?: string | null },
): LineEdit | null {
  if (key.ctrlKey && !key.metaKey && !key.altKey && !key.shiftKey && key.key.toLowerCase() === 'j') return { kind: 'insert', text: '\n' }
  const move = lineMove(key)
  if (!move) return null
  const { value, selectionStart, selectionEnd } = field
  // Shift+Home/End extend the selection from its anchor; the other end moves.
  const backward = field.selectionDirection === 'backward'
  const anchor = backward ? selectionEnd : selectionStart
  const focus = key.shiftKey ? (backward ? selectionStart : selectionEnd) : move === 'start' ? selectionStart : selectionEnd
  const target = move === 'start' ? lineStart(value, focus) : lineEnd(value, focus)
  if (!key.shiftKey) return { kind: 'select', start: target, end: target, direction: 'none' }
  return target < anchor
    ? { kind: 'select', start: target, end: anchor, direction: 'backward' }
    : { kind: 'select', start: anchor, end: target, direction: 'forward' }
}

/**
 * Types text at the caret, replacing the selection. `insertText` keeps the
 * browser's undo history; where it isn't supported the value is set directly
 * and an input event tells React.
 */
export function insertAtCaret(element: HTMLTextAreaElement, text: string): void {
  element.focus()
  if (typeof document.execCommand === 'function' && document.execCommand('insertText', false, text)) return
  element.setRangeText(text, element.selectionStart, element.selectionEnd, 'end')
  element.dispatchEvent(new Event('input', { bubbles: true }))
}

/** Applies a line-editing key to the textarea; true when it handled the key. */
export function handleLineKey(event: LineKey & { preventDefault: () => void }, element: HTMLTextAreaElement): boolean {
  const edit = lineEditFor(event, element)
  if (!edit) return false
  event.preventDefault()
  if (edit.kind === 'insert') insertAtCaret(element, edit.text)
  else element.setSelectionRange(edit.start, edit.end, edit.direction)
  return true
}
