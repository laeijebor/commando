/**
 * Minimal ANSI SGR parser for rendering difftastic output as styled spans.
 * Supports 16-color, 256-color, and truecolor foreground/background plus
 * bold/dim/italic/underline. Non-SGR escape sequences are stripped.
 */

export type AnsiSegment = {
  text: string
  /** 0-15 palette index, or a CSS color for 256/truecolor. */
  foreground?: number | string
  background?: number | string
  bold?: boolean
  dim?: boolean
  italic?: boolean
  underline?: boolean
}

type Style = Omit<AnsiSegment, 'text'>

const ESCAPE_SEQUENCE = /\u001b\[([0-9;]*)m|\u001b\[[0-9;?]*[A-Za-z]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?/gu

const CUBE_LEVELS = [0, 95, 135, 175, 215, 255]

/** CSS color for xterm 256-palette indexes 16-255. */
export function ansi256Color(index: number): string {
  if (index >= 232) {
    const gray = 8 + (index - 232) * 10
    return `rgb(${gray},${gray},${gray})`
  }
  const cube = index - 16
  const red = CUBE_LEVELS[Math.floor(cube / 36) % 6]
  const green = CUBE_LEVELS[Math.floor(cube / 6) % 6]
  const blue = CUBE_LEVELS[cube % 6]
  return `rgb(${red},${green},${blue})`
}

function extendedColor(codes: number[], start: number): { color: number | string; consumed: number } | null {
  if (codes[start + 1] === 5 && codes.length > start + 2) {
    const index = codes[start + 2]
    return { color: index < 16 ? index : ansi256Color(index), consumed: 3 }
  }
  if (codes[start + 1] === 2 && codes.length > start + 4) {
    return {
      color: `rgb(${codes[start + 2]},${codes[start + 3]},${codes[start + 4]})`,
      consumed: 5,
    }
  }
  return null
}

function applyCodes(style: Style, codes: number[]): Style {
  let next = { ...style }
  for (let index = 0; index < codes.length; index += 1) {
    const code = codes[index]
    if (code === 0) {
      next = {}
    } else if (code === 1) {
      next.bold = true
    } else if (code === 2) {
      next.dim = true
    } else if (code === 3) {
      next.italic = true
    } else if (code === 4) {
      next.underline = true
    } else if (code === 22) {
      delete next.bold
      delete next.dim
    } else if (code === 23) {
      delete next.italic
    } else if (code === 24) {
      delete next.underline
    } else if (code >= 30 && code <= 37) {
      next.foreground = code - 30
    } else if (code >= 90 && code <= 97) {
      next.foreground = code - 90 + 8
    } else if (code === 39) {
      delete next.foreground
    } else if (code >= 40 && code <= 47) {
      next.background = code - 40
    } else if (code >= 100 && code <= 107) {
      next.background = code - 100 + 8
    } else if (code === 49) {
      delete next.background
    } else if (code === 38 || code === 48) {
      const extended = extendedColor(codes, index)
      if (!extended) break
      if (code === 38) next.foreground = extended.color
      else next.background = extended.color
      index += extended.consumed - 1
    }
  }
  return next
}

export function parseAnsi(input: string): AnsiSegment[] {
  const segments: AnsiSegment[] = []
  let style: Style = {}
  let cursor = 0

  const push = (text: string) => {
    if (!text) return
    const last = segments[segments.length - 1]
    if (
      last &&
      last.foreground === style.foreground &&
      last.background === style.background &&
      last.bold === style.bold &&
      last.dim === style.dim &&
      last.italic === style.italic &&
      last.underline === style.underline
    ) {
      last.text += text
      return
    }
    segments.push({ text, ...style })
  }

  ESCAPE_SEQUENCE.lastIndex = 0
  for (let match = ESCAPE_SEQUENCE.exec(input); match; match = ESCAPE_SEQUENCE.exec(input)) {
    push(input.slice(cursor, match.index))
    cursor = match.index + match[0].length
    if (match[1] !== undefined) {
      const codes = match[1] === '' ? [0] : match[1].split(';').map((part) => Number(part || '0'))
      style = applyCodes(style, codes)
    }
  }
  push(input.slice(cursor))
  return segments
}
