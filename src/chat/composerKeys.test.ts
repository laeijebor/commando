// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import { handleLineKey, lineEditFor, lineEnd, lineStart } from './composerKeys'

const key = (name: string, modifiers: { ctrl?: boolean; meta?: boolean; alt?: boolean; shift?: boolean } = {}) => ({
  key: name,
  ctrlKey: Boolean(modifiers.ctrl),
  metaKey: Boolean(modifiers.meta),
  altKey: Boolean(modifiers.alt),
  shiftKey: Boolean(modifiers.shift),
})
const caret = (value: string, position: number, end = position, selectionDirection: string = 'none') => ({ value, selectionStart: position, selectionEnd: end, selectionDirection })

const text = 'first line\nsecond line\n\nlast'

describe('line bounds', () => {
  it('finds the logical line around a position', () => {
    expect(lineStart(text, 0)).toBe(0)
    expect(lineStart(text, 5)).toBe(0)
    expect(lineStart(text, 11)).toBe(11)
    expect(lineStart(text, 17)).toBe(11)
    expect(lineEnd(text, 17)).toBe(22)
    // The empty line between `second line` and `last`.
    expect(lineStart(text, 23)).toBe(23)
    expect(lineEnd(text, 23)).toBe(23)
    expect(lineEnd(text, 25)).toBe(text.length)
  })
})

describe('line-editing keys', () => {
  it('moves to the start of the line with Home and Ctrl+A', () => {
    expect(lineEditFor(key('Home'), caret(text, 17))).toEqual({ kind: 'select', start: 11, end: 11, direction: 'none' })
    expect(lineEditFor(key('a', { ctrl: true }), caret(text, 17))).toEqual({ kind: 'select', start: 11, end: 11, direction: 'none' })
    expect(lineEditFor(key('A', { ctrl: true }), caret(text, 3))).toEqual({ kind: 'select', start: 0, end: 0, direction: 'none' })
  })

  it('moves to the end of the line with End and Ctrl+E', () => {
    expect(lineEditFor(key('End'), caret(text, 12))).toEqual({ kind: 'select', start: 22, end: 22, direction: 'none' })
    expect(lineEditFor(key('e', { ctrl: true }), caret(text, 24))).toEqual({ kind: 'select', start: text.length, end: text.length, direction: 'none' })
  })

  it('collapses a selection to the line of its matching end', () => {
    // Selected from `line` on the first line to `sec` on the second.
    expect(lineEditFor(key('Home'), caret(text, 6, 14))).toEqual({ kind: 'select', start: 0, end: 0, direction: 'none' })
    expect(lineEditFor(key('End'), caret(text, 6, 14))).toEqual({ kind: 'select', start: 22, end: 22, direction: 'none' })
  })

  it('extends the selection with Shift+Home and Shift+End', () => {
    expect(lineEditFor(key('Home', { shift: true }), caret(text, 17))).toEqual({ kind: 'select', start: 11, end: 17, direction: 'backward' })
    expect(lineEditFor(key('End', { shift: true }), caret(text, 17))).toEqual({ kind: 'select', start: 17, end: 22, direction: 'forward' })
    // A backward selection keeps its anchor at the end it started from.
    expect(lineEditFor(key('End', { shift: true }), caret(text, 13, 17, 'backward'))).toEqual({ kind: 'select', start: 17, end: 22, direction: 'forward' })
    expect(lineEditFor(key('Home', { shift: true }), caret(text, 13, 17, 'forward'))).toEqual({ kind: 'select', start: 11, end: 13, direction: 'backward' })
  })

  it('inserts a newline with Ctrl+J', () => {
    expect(lineEditFor(key('j', { ctrl: true }), caret(text, 3))).toEqual({ kind: 'insert', text: '\n' })
  })

  it('leaves Cmd+A, Option and other keys to the browser', () => {
    expect(lineEditFor(key('a', { meta: true }), caret(text, 3))).toBeNull()
    expect(lineEditFor(key('a', { ctrl: true, meta: true }), caret(text, 3))).toBeNull()
    expect(lineEditFor(key('Home', { alt: true }), caret(text, 3))).toBeNull()
    expect(lineEditFor(key('Home', { meta: true }), caret(text, 3))).toBeNull()
    expect(lineEditFor(key('a', { ctrl: true, shift: true }), caret(text, 3))).toBeNull()
    expect(lineEditFor(key('j', { ctrl: true, shift: true }), caret(text, 3))).toBeNull()
    expect(lineEditFor(key('a'), caret(text, 3))).toBeNull()
    expect(lineEditFor(key('ArrowLeft', { ctrl: true }), caret(text, 3))).toBeNull()
  })
})

describe('applying a key to a textarea', () => {
  const field = (value: string, start: number, end = start) => {
    const element = document.createElement('textarea')
    document.body.append(element)
    element.value = value
    element.setSelectionRange(start, end)
    return element
  }
  const press = (name: string, modifiers: Parameters<typeof key>[1] = {}) => {
    let prevented = false
    return { ...key(name, modifiers), preventDefault: () => { prevented = true }, get prevented() { return prevented } }
  }

  it('moves the caret and stops the browser default', () => {
    const element = field(text, 17)
    const event = press('a', { ctrl: true })
    expect(handleLineKey(event, element)).toBe(true)
    expect(event.prevented).toBe(true)
    expect([element.selectionStart, element.selectionEnd]).toEqual([11, 11])
  })

  it('replaces the selection with a newline and tells React', () => {
    const element = field('hello world', 5, 6)
    const inputs: string[] = []
    element.addEventListener('input', () => inputs.push(element.value))
    expect(handleLineKey(press('j', { ctrl: true }), element)).toBe(true)
    expect(element.value).toBe('hello\nworld')
    expect(element.selectionStart).toBe(6)
    expect(inputs).toEqual(['hello\nworld'])
  })

  it('ignores keys it does not own', () => {
    const element = field(text, 3)
    const event = press('a', { meta: true })
    expect(handleLineKey(event, element)).toBe(false)
    expect(event.prevented).toBe(false)
  })
})
