// @vitest-environment jsdom
/// <reference lib="dom" />
import { afterEach, describe, expect, it } from 'vitest'
import {
  MAX_TILE_SELECTION_TEXT,
  parseTileSelectionResult,
  readPageSelection,
  selectionExpression,
} from './tile-selection.js'

afterEach(() => {
  document.getSelection()?.removeAllRanges()
  document.body.innerHTML = ''
})

describe('readPageSelection', () => {
  it('returns the exact DOM selection', () => {
    document.body.innerHTML = '<p>alpha beta gamma</p>'
    const text = document.querySelector('p')?.firstChild
    const range = document.createRange()
    range.setStart(text!, 6)
    range.setEnd(text!, 10)
    document.getSelection()?.addRange(range)

    expect(readPageSelection(document)).toEqual({ ok: true, source: 'dom', text: 'beta' })
  })

  it('prefers focused input and textarea selections', () => {
    document.body.innerHTML = '<input value="alpha beta"><textarea>line one\nline two</textarea>'
    const input = document.querySelector('input')!
    input.focus()
    input.setSelectionRange(6, 10)
    expect(readPageSelection(document)).toEqual({ ok: true, source: 'input', text: 'beta' })

    const textarea = document.querySelector('textarea')!
    textarea.focus()
    textarea.setSelectionRange(5, 13)
    expect(readPageSelection(document)).toEqual({ ok: true, source: 'textarea', text: 'one\nline' })
  })

  it('follows focus into open shadow roots', () => {
    const host = document.createElement('div')
    const input = document.createElement('input')
    input.value = 'inside shadow'
    host.attachShadow({ mode: 'open' }).append(input)
    document.body.append(host)
    input.focus()
    input.setSelectionRange(7, 13)

    expect(readPageSelection(document)).toEqual({ ok: true, source: 'input', text: 'shadow' })
  })

  it('follows focus into same-origin frames', () => {
    const frame = document.createElement('iframe')
    document.body.append(frame)
    const frameDocument = frame.contentDocument!
    frameDocument.body.innerHTML = '<p>inside frame</p>'
    const text = frameDocument.querySelector('p')!.firstChild!
    const range = frameDocument.createRange()
    range.setStart(text, 7)
    range.setEnd(text, 12)
    frame.contentWindow!.getSelection()?.addRange(range)
    frame.focus()

    expect(readPageSelection(document)).toEqual({ ok: true, source: 'dom', text: 'frame' })
  })

  it('does not expose password selections', () => {
    document.body.innerHTML = '<input type="password" value="secret">'
    const input = document.querySelector('input')!
    input.focus()
    input.setSelectionRange(0, 6)

    expect(readPageSelection(document)).toEqual({
      ok: false,
      error: 'Copying password selections is not supported',
    })
  })

  it('rejects oversized selections instead of silently truncating them', () => {
    const input = document.createElement('textarea')
    input.value = 'x'.repeat(MAX_TILE_SELECTION_TEXT + 1)
    document.body.append(input)
    input.focus()
    input.setSelectionRange(0, input.value.length)

    expect(readPageSelection(document)).toEqual({ ok: false, error: 'Selection is too large to copy' })
  })
})

describe('selectionExpression', () => {
  it('emits a self-contained probe', () => {
    document.body.innerHTML = '<input value="copy me">'
    const input = document.querySelector('input')!
    input.focus()
    input.setSelectionRange(0, 7)
    // eslint-disable-next-line no-eval
    expect((0, eval)(selectionExpression())).toEqual({ ok: true, source: 'input', text: 'copy me' })
    expect(selectionExpression()).toContain('var __name')
  })
})

describe('parseTileSelectionResult', () => {
  it('accepts valid results without changing whitespace', () => {
    expect(parseTileSelectionResult({ ok: true, source: 'dom', text: ' a\n b ' })).toEqual({
      ok: true,
      source: 'dom',
      text: ' a\n b ',
    })
  })

  it('rejects malformed and oversized page results', () => {
    expect(parseTileSelectionResult({ ok: true, source: 'dom', text: 42 })).toBeNull()
    expect(parseTileSelectionResult({ ok: true, source: 'none', text: 'stale' })).toBeNull()
    expect(parseTileSelectionResult({
      ok: true,
      source: 'dom',
      text: 'x'.repeat(MAX_TILE_SELECTION_TEXT + 1),
    })).toBeNull()
  })
})
