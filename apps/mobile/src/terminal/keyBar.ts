import type { SpecialKey } from '@commando/protocol'

/**
 * What a key-bar button does when it is tapped. `key` and `input` map straight
 * onto the daemon's `key` / `input` messages; `paste` reads the clipboard
 * first, so it is resolved by the screen rather than here.
 */
export type KeyBarAction =
  | { kind: 'key'; key: SpecialKey }
  | { kind: 'input'; data: string }
  | { kind: 'paste' }

export type KeyBarItem = {
  id: string
  label: string
  accessibilityLabel: string
  action: KeyBarAction
  /** Wider glyph-only buttons read better with a little more room. */
  wide?: boolean
}

/**
 * The bar from mockup screen 03: escape and tab, the two control keys an agent
 * run actually needs, arrows, Enter, the slash that opens Claude Code's command
 * menu, and a paste button.
 */
export const KEY_BAR_ITEMS: readonly KeyBarItem[] = [
  { id: 'esc', label: 'esc', accessibilityLabel: 'Escape', action: { kind: 'key', key: 'Escape' } },
  { id: 'tab', label: 'tab', accessibilityLabel: 'Tab', action: { kind: 'key', key: 'Tab' } },
  { id: 'ctrl-c', label: '⌃c', accessibilityLabel: 'Control C', action: { kind: 'key', key: 'C-c' } },
  { id: 'ctrl-d', label: '⌃d', accessibilityLabel: 'Control D', action: { kind: 'key', key: 'C-d' } },
  { id: 'up', label: '↑', accessibilityLabel: 'Arrow up', action: { kind: 'key', key: 'Up' } },
  { id: 'down', label: '↓', accessibilityLabel: 'Arrow down', action: { kind: 'key', key: 'Down' } },
  { id: 'left', label: '←', accessibilityLabel: 'Arrow left', action: { kind: 'key', key: 'Left' } },
  { id: 'right', label: '→', accessibilityLabel: 'Arrow right', action: { kind: 'key', key: 'Right' } },
  { id: 'enter', label: '⏎', accessibilityLabel: 'Enter', action: { kind: 'key', key: 'Enter' } },
  { id: 'slash', label: '/', accessibilityLabel: 'Slash', action: { kind: 'input', data: '/' } },
  { id: 'paste', label: 'paste', accessibilityLabel: 'Paste from clipboard', action: { kind: 'paste' }, wide: true },
]

export function keyBarItem(id: string): KeyBarItem | undefined {
  return KEY_BAR_ITEMS.find((item) => item.id === id)
}
