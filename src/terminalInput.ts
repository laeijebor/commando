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
