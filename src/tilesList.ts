import { isRedlineArtifactUrl } from '../shared/chat-tile-events'
import { isDeckPath } from '../shared/deck'
import type { TmuxPane, TmuxSession, WebPane } from '../shared/protocol'
import { paneLabel } from './panesList'

export type TileKind = 'Page' | 'Redline' | 'Canvas' | 'Slides' | 'Guide' | 'Simulator'
export type TileSort = 'viewed' | 'created' | 'session'

export type TileRow = {
  tile: WebPane
  kind: TileKind
  label: string
  sessionName: string
  paneLabel: string
  /** Where the tile sits: split beside its pane, or a tab in the pane's side panel. */
  placement: 'Split' | 'Side panel'
  openedBy: string
  viewedAt?: number
  viewing: boolean
}

export type TileListContext = {
  tiles: readonly WebPane[]
  sessions: readonly TmuxSession[]
  panes: readonly TmuxPane[]
  viewedAt: Readonly<Record<string, number>>
  viewing: ReadonlySet<string>
  label: (tile: WebPane) => string
}

export function tileKind(tile: WebPane): TileKind {
  if (tile.content?.kind === 'simulator') return 'Simulator'
  if (tile.content?.kind === 'canvas') return isDeckPath(tile.content.manifest) ? 'Slides' : 'Canvas'
  if (tile.content?.kind === 'guide') return 'Guide'
  return isRedlineArtifactUrl(tile.url) ? 'Redline' : 'Page'
}

export function tileRows(context: TileListContext): TileRow[] {
  const sessions = new Map(context.sessions.map((session) => [session.id, session]))
  const panes = new Map(context.panes.map((pane) => [pane.id, pane]))
  return context.tiles.map((tile) => {
    const anchor = panes.get(tile.anchorPaneId)
    return {
      tile,
      kind: tileKind(tile),
      label: context.label(tile),
      sessionName: sessions.get(tile.sessionId)?.name ?? tile.sessionId,
      paneLabel: anchor ? paneLabel(anchor) : tile.anchorPaneId,
      placement: tile.dock === 'split' ? 'Split' : 'Side panel',
      openedBy: tile.openedBy === 'agent' ? tile.openerLabel || 'Agent' : 'You',
      viewedAt: context.viewedAt[tile.id],
      viewing: context.viewing.has(tile.id),
    }
  })
}

/** Stalest first for the times, so the tiles most likely to close sit at the top. */
export function sortTileRows(rows: readonly TileRow[], sort: TileSort): TileRow[] {
  const viewed = (row: TileRow) => row.viewing ? Infinity : row.viewedAt ?? -Infinity
  const bySession = (a: TileRow, b: TileRow) => a.sessionName.localeCompare(b.sessionName) || a.paneLabel.localeCompare(b.paneLabel) || (a.tile.order ?? 0) - (b.tile.order ?? 0)
  return [...rows].sort((a, b) => {
    if (sort === 'session') return bySession(a, b)
    if (sort === 'created') return a.tile.createdAt - b.tile.createdAt || bySession(a, b)
    return viewed(a) - viewed(b) || a.tile.createdAt - b.tile.createdAt
  })
}

export function matchesTileQuery(row: TileRow, query: string): boolean {
  const needle = query.trim().toLowerCase()
  if (!needle) return true
  return [row.label, row.kind, row.sessionName, row.paneLabel, row.openedBy, row.tile.url]
    .some((value) => value.toLowerCase().includes(needle))
}

/** Only an http(s) page the owner has confirmed is embedded; built-in tiles have no URL. */
export function embeddableUrl(tile: WebPane): string | undefined {
  if (tile.status !== 'open' || tile.content) return undefined
  try {
    const url = new URL(tile.url)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : undefined
  } catch { return undefined }
}
