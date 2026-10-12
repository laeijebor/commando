import type { WebPane } from './protocol.js'

/**
 * Resolves an 'auto' web pane placement to a concrete split direction from
 * the anchor pane's cell size. Terminal cells are ~2x taller than wide, so
 * split along the anchor's longer pixel edge so neither half becomes a
 * sliver.
 *
 * The decision must be made ONCE, from the anchor's unsplit geometry, and
 * then stored. Re-deriving it from live geometry oscillates: the applied
 * layout halves the anchor along the chosen axis, which can flip the choice
 * on the next measurement, forever (right ↔ below thrash).
 */
export function resolveAutoPlacement(anchor: {
  cols: number
  rows: number
}): 'right' | 'below' {
  return anchor.cols >= anchor.rows * 2 ? 'right' : 'below'
}

/** Panel tabs belong to their anchor, independent of the terminal layout. */
export function panelTabs(panes: readonly WebPane[], anchorPaneId: string): WebPane[] {
  return panes.filter((pane) => pane.dock !== 'split' && pane.anchorPaneId === anchorPaneId)
    .sort((a, b) => (a.order ?? a.createdAt) - (b.order ?? b.createdAt) || a.createdAt - b.createdAt || a.id.localeCompare(b.id))
}

export function nextWebPaneOrder(panes: readonly WebPane[], anchorPaneId: string): number {
  return panes.reduce((max, pane) => pane.anchorPaneId === anchorPaneId ? Math.max(max, pane.order ?? -1) : max, -1) + 1
}

export function neighbouringTab(tabs: readonly WebPane[], removedId: string): string | undefined {
  const index = tabs.findIndex((tab) => tab.id === removedId)
  return index < 0 ? tabs[0]?.id : (tabs[index + 1] ?? tabs[index - 1])?.id
}

export const BUILTIN_PANEL_KEYS = ['session', 'changes'] as const
export type PrPanelKey = `pr:${string}:${string}:${number}`
export type BuiltinPanelKey = typeof BUILTIN_PANEL_KEYS[number] | PrPanelKey

export function prPanelKey(repo: string, number: number): PrPanelKey {
  return `pr:${repo.toLowerCase().replace('/', ':')}:${number}` as PrPanelKey
}

export function parsePrPanelKey(value: string): { repo: string; number: number } | undefined {
  const match = /^pr:([A-Za-z0-9][A-Za-z0-9-]{0,38}):([A-Za-z0-9._-]{1,100}):([1-9]\d*)$/.exec(value)
  if (!match) return undefined
  const number = Number(match[3])
  return Number.isSafeInteger(number) ? { repo: `${match[1]}/${match[2]}`.toLowerCase(), number } : undefined
}

/** Preserve old selections on disk until the client can resolve pane membership. */
export function isLegacyPrPanelKey(value: string): boolean {
  return value === 'pr' || (/^pr:[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value.slice(3))))
}

export function isBuiltinPanelKey(value: string): value is BuiltinPanelKey {
  return (BUILTIN_PANEL_KEYS as readonly string[]).includes(value) || parsePrPanelKey(value) !== undefined
}
