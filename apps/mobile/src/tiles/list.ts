import type {
  CommandoSnapshot,
  WebPane,
  WebPaneFeedbackInfo,
} from '@commando/protocol'

/** A tile as the list renders it: everything resolved against the snapshot. */
export type TileRow = {
  tile: WebPane
  /** `example.com:5173` — the part of the URL that says *where*. */
  host: string
  /** `/redline/artifacts/3f9c…/companion.html` — the part that says *what*. */
  path: string
  engine: WebPane['engine']
  /** "opened by claude · gizmo" / "opened by you". */
  opener: string
  /** "island · claude" — the window and pane the tile sits beside. */
  anchor: string
  /** Answers waiting in the feedback queue for the agent to drain. */
  queued: number
  /** True while an external origin waits for the owner's confirmation. */
  awaitingConfirmation: boolean
}

export type TileGroup = {
  sessionId: string
  sessionName: string
  rows: TileRow[]
}

/** Splits a tile URL into the two halves the row shows on its two lines. */
export function describeTileUrl(raw: string): { host: string; path: string } {
  try {
    const url = new URL(raw)
    const path = `${url.pathname}${url.search}` || '/'
    return { host: url.port ? `${url.hostname}:${url.port}` : url.hostname, path }
  } catch {
    return { host: raw, path: '' }
  }
}

/** The tile screen's subtitle: host and path on one line, as in the mockup. */
export function tileSubtitle(raw: string): string {
  const { host, path } = describeTileUrl(raw)
  return path ? `${host}${path}` : host
}

function openerLabel(tile: WebPane): string {
  if (tile.openedBy === 'user') return 'opened by you'
  return tile.openerLabel ? `opened by ${tile.openerLabel}` : 'opened by an agent'
}

export function buildTileRows(input: {
  webPanes: readonly WebPane[]
  feedback: Record<string, WebPaneFeedbackInfo>
  snapshot: CommandoSnapshot | null
}): TileRow[] {
  const panes = new Map((input.snapshot?.panes ?? []).map((pane) => [pane.id, pane]))
  const windows = new Map((input.snapshot?.windows ?? []).map((window) => [window.id, window]))

  return input.webPanes.map((tile) => {
    const { host, path } = describeTileUrl(tile.url)
    const anchorPane = panes.get(tile.anchorPaneId)
    const anchorWindow = windows.get(tile.windowId)
    const anchorParts = [anchorWindow?.name, anchorPane?.title || anchorPane?.command].filter(
      (part): part is string => Boolean(part),
    )
    return {
      tile,
      host,
      path,
      engine: tile.engine,
      opener: openerLabel(tile),
      anchor: anchorParts.length ? anchorParts.join(' · ') : tile.anchorPaneId,
      queued: input.feedback[tile.id]?.queued ?? 0,
      awaitingConfirmation: tile.status === 'pending',
    }
  })
}

/**
 * Groups tiles under their tmux session, in the snapshot's session order so
 * the list reads like the session tree. Tiles whose session has since gone
 * (a stale `web_panes` broadcast, or a session killed under them) keep their
 * own group at the end rather than disappearing.
 */
export function groupTileRows(
  rows: readonly TileRow[],
  snapshot: CommandoSnapshot | null,
): TileGroup[] {
  const names = new Map((snapshot?.sessions ?? []).map((session) => [session.id, session.name]))
  const order = new Map((snapshot?.sessions ?? []).map((session, index) => [session.id, index]))
  const groups = new Map<string, TileGroup>()

  for (const row of rows) {
    const sessionId = row.tile.sessionId
    let group = groups.get(sessionId)
    if (!group) {
      group = { sessionId, sessionName: names.get(sessionId) ?? sessionId, rows: [] }
      groups.set(sessionId, group)
    }
    group.rows.push(row)
  }

  return [...groups.values()].sort((a, b) => {
    const left = order.get(a.sessionId) ?? Number.MAX_SAFE_INTEGER
    const right = order.get(b.sessionId) ?? Number.MAX_SAFE_INTEGER
    if (left !== right) return left - right
    return a.sessionName.localeCompare(b.sessionName)
  })
}

/**
 * Only chromium tiles stream to the phone. A webkit tile renders in the
 * desktop app's own WebView against the host's localhost, which the phone
 * cannot reach — hence the "Reopen as chromium" offer (Decision 3).
 */
export function canStream(tile: WebPane): boolean {
  return tile.engine === 'chromium' && tile.status === 'open'
}

/** Why a tile cannot be opened, in the words the row shows. */
export function unstreamableReason(tile: WebPane): string | null {
  if (tile.status === 'pending') return 'Waiting for you to allow this origin'
  if (tile.engine === 'webkit') return 'Webkit tiles render on the host, not here'
  return null
}
