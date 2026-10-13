import { MAX_PASTE_BYTES, type SpecialKey } from '../shared/protocol'

type TerminalKeyEvent = Pick<
  KeyboardEvent,
  'key' | 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey'
>

const SPECIAL_KEYS: Readonly<Partial<Record<string, SpecialKey>>> = {
  Enter: 'Enter',
  Backspace: 'Backspace',
  Tab: 'Tab',
  Escape: 'Escape',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Home: 'Home',
  End: 'End',
  Insert: 'Insert',
  Delete: 'Delete',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  F1: 'F1',
  F2: 'F2',
  F3: 'F3',
  F4: 'F4',
  F5: 'F5',
  F6: 'F6',
  F7: 'F7',
  F8: 'F8',
  F9: 'F9',
  F10: 'F10',
  F11: 'F11',
  F12: 'F12',
}

const CONTROL_KEYS: Readonly<Partial<Record<string, SpecialKey>>> = {
  c: 'C-c',
  d: 'C-d',
  z: 'C-z',
  l: 'C-l',
}

// Legacy terminal input cannot distinguish Ctrl+Shift+S from Ctrl+S. Send the
// modified key in CSI-u form so terminal apps can bind them separately.
export function modifiedControlShiftS(event: TerminalKeyEvent): string | null {
  return event.ctrlKey && event.shiftKey && !event.altKey && !event.metaKey &&
    event.key.toLowerCase() === 's'
    ? '\x1b[115;6u'
    : null
}

export type MacTerminalAction = { input: string } | 'selectAll' | 'cut'

export function macTerminalAction(event: TerminalKeyEvent, isMac: boolean): MacTerminalAction | null {
  if (!isMac || !event.metaKey || event.altKey || event.ctrlKey || event.shiftKey) return null
  switch (event.key.toLowerCase()) {
    case 'arrowleft': return { input: '\x01' }
    case 'arrowright': return { input: '\x05' }
    case 'backspace': return { input: '\x15' }
    case 'delete': return { input: '\x0b' }
    // Ctrl+Z suspends the foreground process; readline undo is Ctrl+_.
    case 'z': return { input: '\x1f' }
    case 'a': return 'selectAll'
    case 'x': return 'cut'
    default: return null
  }
}

export type TerminalInputScreen = {
  rows: string[]
  cols: number
  cursorRow: number
  cursorCol: number
  /** `wrapped[i]` means row i is a soft-wrap continuation of row i - 1. */
  wrapped?: boolean[]
}

export type TerminalInputCut = { text: string; clear: string }

function isInputRule(row: string): boolean {
  const trimmed = row.trim()
  return /^[─━╭╮╰╯│]+$/u.test(trimmed) && [...trimmed].filter((char) => char === '─').length >= 10
}

function withoutSideBorders(row: string): string {
  return row.replace(/^│ ?/u, '').replace(/ *│ *$/u, '')
}

export function extractTerminalInput({ rows, cols, cursorRow, cursorCol, wrapped }: TerminalInputScreen): TerminalInputCut | null {
  if (rows[cursorRow] === undefined || isInputRule(rows[cursorRow])) return null
  for (let start = rows.length - 1; start > 0; start -= 1) {
    if (!/^(?:│ )?[❯>][ \u00a0]/u.test(rows[start]) || !isInputRule(rows[start - 1])) continue
    const end = rows.findIndex((row, index) => index > start && isInputRule(row))
    if (end === -1 || cursorRow < start || cursorRow >= end) continue
    const contentWidth = cols - 2 - (rows[start].startsWith('│ ') ? 4 : 0)
    const lines = rows.slice(start, end).map((row, index) => {
      const content = withoutSideBorders(row)
      return (index === 0 ? content.replace(/^[❯>][ \u00a0]/u, '') : content.replace(/^  /u, '')).trimEnd()
    })
    let text = lines[0]
    for (let index = 1; index < lines.length; index += 1) {
      const prev = lines[index - 1]
      const next = lines[index]
      const firstWord = next.match(/^\S+/u)?.[0] ?? ''
      const separator = [...prev].length + 1 + [...firstWord].length > contentWidth
        ? ' '
        : [...prev].length >= contentWidth ? '' : '\n'
      text += separator + next
    }
    text = text.trim()
    if (!text) return null
    const repeats = 2 * lines.length + 1
    return { text, clear: '\x0b'.repeat(repeats) + '\x15'.repeat(repeats) }
  }
  const continues = (row: string) => {
    const lastCell = [...row][cols - 1]
    return lastCell !== undefined && lastCell !== ' '
  }
  let firstRow = cursorRow
  let lastRow = cursorRow
  while (firstRow > 0 && (wrapped ? wrapped[firstRow] : continues(rows[firstRow - 1]))) firstRow -= 1
  while (lastRow + 1 < rows.length && (wrapped ? wrapped[lastRow + 1] : continues(rows[lastRow]))) lastRow += 1
  const row = rows.slice(firstRow, lastRow + 1).join('')
  const cursorOffset = (cursorRow - firstRow) * cols + cursorCol
  const prompt = row.match(/^.*?(?:[$#❯>]|(?<!\d)%)[ \u00a0]/u)?.[0]
  const text = prompt && [...prompt].length <= cursorOffset ? row.slice(prompt.length).trimEnd() : row.trim()
  return text ? { text, clear: prompt ? '\x05\x15' : '' } : null
}

export function semanticKeyForEvent(event: TerminalKeyEvent): SpecialKey | null {
  if (event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey) {
    return CONTROL_KEYS[event.key.toLowerCase()] ?? null
  }
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return null
  return SPECIAL_KEYS[event.key] ?? null
}

export type PasteDispatchResult = 'sent' | 'empty' | 'invalid' | 'too-large'

export function dispatchBoundedPaste(
  data: string,
  dispatch: (data: string) => void,
): PasteDispatchResult {
  if (data.length === 0) return 'empty'
  if (data.includes('\0')) return 'invalid'
  if (new TextEncoder().encode(data).byteLength > MAX_PASTE_BYTES) return 'too-large'
  dispatch(data)
  return 'sent'
}
