import { findTextMatches } from './AnsiText'

/**
 * In-file search over a rendered @pierre/diffs view. Pierre renders into a shadow root and
 * re-renders rows as context expands or highlighting arrives, so matches are found in the
 * rendered rows (what the user can see) and painted with the CSS Custom Highlight API. The
 * highlight registry is global to the document, so each view paints under its own names and
 * styles them through Pierre's `unsafeCSS` (see `searchHighlightCSS`).
 */

/** Code rows only: line numbers live in a separate gutter column and never match. */
const ROW_SELECTOR = '[data-content] [data-line]'
/** Marks the row holding the current match, for browsers without highlights (and for tests). */
export const ACTIVE_ROW_ATTRIBUTE = 'data-commando-search-active'

export type SearchHighlightNames = { match: string; current: string }

export function searchHighlightNames(id: string): SearchHighlightNames {
  const safe = id.replace(/[^a-zA-Z0-9_-]/g, '')
  return { match: `commando-find-${safe}`, current: `commando-find-current-${safe}` }
}

/** Shadow-root CSS for one view's highlights; amber like the ANSI engines' search marks. */
export function searchHighlightCSS(names: SearchHighlightNames): string {
  return `::highlight(${names.match}) { color: #f8f4e8; background-color: rgb(243 198 107 / 0.42); }
::highlight(${names.current}) { color: #130f05; background-color: #f3c66b; }`
}

export type DiffSearchMatch = {
  row: HTMLElement
  /** Character offsets within the row's text. */
  start: number
  end: number
}

export function pierreSearchRoot(host: Element): ParentNode {
  return host.shadowRoot ?? host
}

/** Matches in reading order: top to bottom, and the old (left) column before the new in split view. */
export function findRowMatches(root: ParentNode, query: string): DiffSearchMatch[] {
  if (!query.trim()) return []
  const found: Array<DiffSearchMatch & { top: number; left: number; order: number }> = []
  let order = 0
  for (const row of root.querySelectorAll<HTMLElement>(ROW_SELECTOR)) {
    const matches = findTextMatches(row.textContent ?? '', query)
    if (!matches.length) continue
    const bounds = row.getBoundingClientRect()
    for (const match of matches) found.push({ row, ...match, top: bounds.top, left: bounds.left, order: order++ })
  }
  // Split view renders the whole old column before the new one, so DOM order isn't reading order.
  found.sort((a, b) => a.top - b.top || a.left - b.left || a.order - b.order)
  return found.map(({ row, start, end }) => ({ row, start, end }))
}

function rangeFor(match: DiffSearchMatch): Range | null {
  const document = match.row.ownerDocument
  const walker = document.createTreeWalker(match.row, NodeFilter.SHOW_TEXT)
  let offset = 0
  let range: Range | null = null
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const length = node.textContent?.length ?? 0
    const end = offset + length
    if (!range && match.start < end) {
      range = document.createRange()
      range.setStart(node, match.start - offset)
    }
    if (range && match.end <= end) {
      range.setEnd(node, match.end - offset)
      return range
    }
    offset = end
  }
  return null
}

type HighlightRegistry = { set(name: string, value: unknown): void; delete(name: string): void }
type HighlightConstructor = new (...ranges: Range[]) => { priority: number }

function highlightApi(view: Window | null): { registry: HighlightRegistry; Highlight: HighlightConstructor } | null {
  const registry = (view as (Window & { CSS?: { highlights?: HighlightRegistry } }) | null)?.CSS?.highlights
  const Highlight = (view as (Window & { Highlight?: HighlightConstructor }) | null)?.Highlight
  return registry && typeof Highlight === 'function' ? { registry, Highlight } : null
}

/** Paints all matches, marks the current one and returns a cleanup that removes the paint. */
export function paintMatches(matches: DiffSearchMatch[], current: number, names: SearchHighlightNames): () => void {
  const active = matches[current]?.row
  active?.setAttribute(ACTIVE_ROW_ATTRIBUTE, '')
  const api = highlightApi(matches[0]?.row.ownerDocument.defaultView ?? null)
  if (api) {
    const ranges = matches.map(rangeFor)
    const others = ranges.filter((range, index): range is Range => range !== null && index !== current)
    const currentRange = ranges[current]
    const currentHighlight = new api.Highlight(...(currentRange ? [currentRange] : []))
    currentHighlight.priority = 1
    api.registry.set(names.match, new api.Highlight(...others))
    api.registry.set(names.current, currentHighlight)
  }
  return () => {
    active?.removeAttribute(ACTIVE_ROW_ATTRIBUTE)
    api?.registry.delete(names.match)
    api?.registry.delete(names.current)
  }
}

/** Scrolls the current match into view, horizontally too when a long line overflows its column. */
export function revealMatch(match: DiffSearchMatch | undefined): void {
  if (!match) return
  const range = rangeFor(match)
  const container = range?.startContainer.parentElement
  const target = container && match.row.contains(container) ? container : match.row
  if (typeof target.scrollIntoView === 'function') target.scrollIntoView({ block: 'center', inline: 'nearest' })
}

/** A row's line number on one side of the diff, or undefined when the row belongs to the other side. */
function sideLineNumber(row: HTMLElement, side: 'deletions' | 'additions'): number | undefined {
  const code = row.closest('code')
  const own = Number(row.dataset.line)
  const alt = row.dataset.altLine === undefined ? NaN : Number(row.dataset.altLine)
  let number: number
  // Split view gives each side its own column, numbered by that side's file.
  if (code?.hasAttribute('data-deletions')) number = side === 'deletions' ? own : NaN
  else if (code?.hasAttribute('data-additions')) number = side === 'additions' ? own : NaN
  // Unified view: deletions carry old numbers, additions new ones, context rows new with the old as alt.
  else if (row.dataset.lineType === 'change-deletion') number = side === 'deletions' ? own : NaN
  else if (row.dataset.lineType === 'change-addition') number = side === 'additions' ? own : NaN
  else number = side === 'additions' ? own : alt
  return Number.isFinite(number) ? number : undefined
}

/**
 * The rendered row showing a line of one side, or else the nearest rendered line on that side
 * (unchanged context is collapsed, so not every line has a row). Null while nothing is rendered.
 */
export function findSideRow(root: ParentNode, side: 'deletions' | 'additions', line: number): HTMLElement | null {
  let best: HTMLElement | null = null
  let bestDistance = Infinity
  for (const row of root.querySelectorAll<HTMLElement>(ROW_SELECTOR)) {
    const number = sideLineNumber(row, side)
    if (number === undefined) continue
    const distance = Math.abs(number - line)
    if (distance < bestDistance) {
      best = row
      bestDistance = distance
      if (!distance) break
    }
  }
  return best
}
