import { describe, expect, it } from 'vitest'
import { ansi256Color, parseAnsi } from './ansi'

const ESC = String.fromCharCode(27)
const sgr = (codes: string) => `${ESC}[${codes}m`

describe('parseAnsi', () => {
  it('passes through plain text', () => {
    expect(parseAnsi('hello')).toEqual([{ text: 'hello' }])
  })

  it('applies 16-color foregrounds and resets', () => {
    const segments = parseAnsi(`${sgr('31')}removed${sgr('0')} plain ${sgr('92')}added`)
    expect(segments).toEqual([
      { text: 'removed', foreground: 1 },
      { text: ' plain ' },
      { text: 'added', foreground: 10 },
    ])
  })

  it('tracks bold, dim, italic, underline and their resets', () => {
    const segments = parseAnsi(`${sgr('1;4')}strong${sgr('22;24')}normal`)
    expect(segments[0]).toMatchObject({ text: 'strong', bold: true, underline: true })
    expect(segments[1]).toEqual({ text: 'normal' })
  })

  it('supports 256-color and truecolor sequences', () => {
    const segments = parseAnsi(`${sgr('38;5;196')}red256${sgr('0')}${sgr('38;2;1;2;3')}true`)
    expect(segments[0].foreground).toBe(ansi256Color(196))
    expect(segments[1].foreground).toBe('rgb(1,2,3)')
  })

  it('maps low 256-palette indexes to the themable 16-color palette', () => {
    const segments = parseAnsi(`${sgr('38;5;2')}green`)
    expect(segments[0].foreground).toBe(2)
  })

  it('applies attributes that follow a reset in the same sequence', () => {
    const segments = parseAnsi(`${sgr('4')}under${sgr('0;1;31')}boldred`)
    expect(segments[1]).toEqual({ text: 'boldred', bold: true, foreground: 1 })
  })

  it('strips cursor sequences with uppercase M finals', () => {
    expect(parseAnsi(`${ESC}[2Mkept`)).toEqual([{ text: 'kept' }])
  })

  it('treats an empty SGR as reset', () => {
    const segments = parseAnsi(`${sgr('33')}amber${sgr('')}plain`)
    expect(segments[1]).toEqual({ text: 'plain' })
  })

  it('strips non-SGR escape sequences', () => {
    const segments = parseAnsi(`${ESC}[2Jcleared${ESC}]0;title${String.fromCharCode(7)}end`)
    expect(segments).toEqual([{ text: 'clearedend' }])
  })

  it('merges adjacent segments with identical styling', () => {
    const segments = parseAnsi(`${sgr('32')}a${sgr('32')}b`)
    expect(segments).toEqual([{ text: 'ab', foreground: 2 }])
  })
})

describe('ansi256Color', () => {
  it('computes cube and grayscale colors', () => {
    expect(ansi256Color(16)).toBe('rgb(0,0,0)')
    expect(ansi256Color(231)).toBe('rgb(255,255,255)')
    expect(ansi256Color(232)).toBe('rgb(8,8,8)')
    expect(ansi256Color(255)).toBe('rgb(238,238,238)')
  })
})
