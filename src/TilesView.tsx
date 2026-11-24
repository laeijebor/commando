import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ExternalLink, LoaderCircle, Trash2, X } from 'lucide-react'
import { MAX_WEB_PANES, type TmuxPane, type TmuxSession, type WebPane } from '../shared/protocol'
import type { PaneManagementApiClient, PaneViews } from './paneManagementApi'
import { relativeTime } from './relativeTime'
import { embeddableUrl, matchesTileQuery, sortTileRows, tileRows, type TileRow, type TileSort } from './tilesList'
import { usePoll } from './usePoll'
import './panes-view.css'

const VIEWS_POLL_MS = 5_000

const SORT_LABELS: Record<TileSort, string> = {
  viewed: 'Last viewed',
  created: 'Opened',
  session: 'Session',
}

function viewedText(row: TileRow, now: number): string {
  if (row.viewing) return 'On screen'
  return row.viewedAt ? relativeTime(row.viewedAt, now) : 'Not recorded'
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`

/** Every tile (web pages, redlines, canvases, guides, simulators) against the daemon's tile limit. */
export function TilesView({ tiles, sessions, panes, label, api, connected, onOpen, onClose, switcher }: {
  tiles: readonly WebPane[]
  sessions: readonly TmuxSession[]
  panes: readonly TmuxPane[]
  /** The tile's name as its side-panel tab shows it. */
  label: (tile: WebPane) => string
  api: Pick<PaneManagementApiClient, 'paneViews'>
  connected: boolean
  onOpen: (tileId: string) => void
  /** Closes the tiles one by one; errors go to `onError`. */
  onClose: (tileIds: string[], onError: (message: string) => void) => Promise<void>
  switcher?: ReactNode
}) {
  const [sort, setSort] = useState<TileSort>('viewed')
  const [query, setQuery] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [checked, setChecked] = useState<ReadonlySet<string>>(new Set())
  const [closing, setClosing] = useState(false)
  const [error, setError] = useState('')
  const [now, setNow] = useState(() => Date.now())

  const views = usePoll<PaneViews>(connected ? api.paneViews : null, VIEWS_POLL_MS, 'views')
  useEffect(() => { setNow(Date.now()) }, [views.value])

  const rows = useMemo(() => tileRows({
    tiles, sessions, panes, label,
    viewedAt: views.value?.tiles.viewedAt ?? {},
    viewing: new Set(views.value?.tiles.viewing ?? []),
  }), [tiles, sessions, panes, label, views.value])
  const shown = useMemo(() => sortTileRows(rows.filter((row) => matchesTileQuery(row, query)), sort), [rows, query, sort])

  // Tiles that closed drop out of the selection and the preview.
  const liveIds = useMemo(() => new Set(tiles.map((tile) => tile.id)), [tiles])
  useEffect(() => {
    setChecked((current) => [...current].every((id) => liveIds.has(id)) ? current : new Set([...current].filter((id) => liveIds.has(id))))
    if (selectedId && !liveIds.has(selectedId)) setSelectedId(null)
  }, [liveIds, selectedId])
  const selected = selectedId ? rows.find((row) => row.tile.id === selectedId) : undefined

  const close = async (tileIds: string[]) => {
    const closingRows = rows.filter((row) => tileIds.includes(row.tile.id))
    if (!closingRows.length) return
    const simulators = closingRows.filter((row) => row.kind === 'Simulator').length
    const reopenable = closingRows.length - simulators
    const notes = [
      reopenable ? `${reopenable === closingRows.length ? 'They' : `${plural(reopenable, 'tile')}`} can be reopened from the Worklog's closed tabs for 14 days.` : '',
      simulators ? `${plural(simulators, 'simulator tile')} cannot be reopened from there.` : '',
    ].filter(Boolean).join(' ')
    const what = closingRows.length === 1 ? `“${closingRows[0].label}”` : plural(closingRows.length, 'tile')
    if (!window.confirm(`Close ${what}? ${notes}`)) return
    setClosing(true)
    setError('')
    try {
      await onClose(closingRows.map((row) => row.tile.id), setError)
      setChecked(new Set())
    } finally {
      setClosing(false)
    }
  }

  const allShownChecked = shown.length > 0 && shown.every((row) => checked.has(row.tile.id))
  const toggleAll = () => setChecked(allShownChecked ? new Set() : new Set(shown.map((row) => row.tile.id)))
  const toggle = (tileId: string) => setChecked((current) => {
    const next = new Set(current)
    if (!next.delete(tileId)) next.add(tileId)
    return next
  })
  const tableBody = useRef<HTMLTableSectionElement>(null)
  // Focus follows the highlight, so Enter opens the tile being previewed.
  const move = (direction: 1 | -1) => {
    const index = shown.findIndex((row) => row.tile.id === selectedId)
    const next = shown[Math.min(shown.length - 1, Math.max(0, index + direction))]
    if (!next) return
    setSelectedId(next.tile.id)
    ;[...tableBody.current?.rows ?? []].find((element) => element.dataset.tileId === next.tile.id)?.focus()
  }

  const remaining = MAX_WEB_PANES - tiles.length
  const embed = selected ? embeddableUrl(selected.tile) : undefined
  return <section className="panes-view" aria-label="Tiles">
    <div className="panes-list">
      <header className="panes-bar">
        {switcher ?? <h2>Tiles</h2>}
        <span className={`panes-pill${remaining <= 4 ? ' over' : ''}`} title={`The daemon opens at most ${MAX_WEB_PANES} tiles`}>
          {tiles.length} / {MAX_WEB_PANES}{remaining <= 0 ? ' · full' : ''}
        </span>
        <input type="search" className="panes-search" placeholder="Filter tiles" aria-label="Filter tiles" value={query} onChange={(event) => setQuery(event.target.value)} />
        <label className="panes-sort">
          <span>Sort</span>
          <select value={sort} onChange={(event) => setSort(event.target.value as TileSort)} aria-label="Sort tiles">
            {(Object.keys(SORT_LABELS) as TileSort[]).map((key) => <option key={key} value={key}>{SORT_LABELS[key]}</option>)}
          </select>
        </label>
        <button type="button" className="panes-danger" disabled={!checked.size || closing || !connected} onClick={() => { void close([...checked]) }}>
          {closing ? <LoaderCircle className="spin" aria-hidden="true" /> : <Trash2 aria-hidden="true" />}
          Close {checked.size || ''} selected
        </button>
      </header>
      {error ? <p className="panes-error" role="alert">{error} <button type="button" aria-label="Dismiss" onClick={() => setError('')}><X aria-hidden="true" /></button></p> : null}
      {views.error ? <p className="panes-error" role="status">Last viewed times are unavailable: {views.error}</p> : null}
      <div className="panes-table-wrap">
        <table className="panes-table">
          <thead>
            <tr>
              <th className="panes-check"><input type="checkbox" checked={allShownChecked} onChange={toggleAll} aria-label="Select all shown tiles" /></th>
              <th>Tile</th>
              <th>Kind</th>
              <th>Pane</th>
              <th>Last viewed</th>
              <th>Opened</th>
              <th aria-label="Actions" />
            </tr>
          </thead>
          <tbody ref={tableBody} onKeyDown={(event) => {
            if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
            event.preventDefault()
            move(event.key === 'ArrowDown' ? 1 : -1)
          }}>
            {shown.map((row) => <tr key={row.tile.id} data-tile-id={row.tile.id} className={row.tile.id === selectedId ? 'selected' : undefined} aria-selected={row.tile.id === selectedId}
              tabIndex={0} onClick={() => setSelectedId(row.tile.id)} onKeyDown={(event) => { if (event.key === 'Enter' && event.target === event.currentTarget) onOpen(row.tile.id) }}>
              <td className="panes-check" onClick={(event) => event.stopPropagation()}>
                <input type="checkbox" checked={checked.has(row.tile.id)} onChange={() => toggle(row.tile.id)} aria-label={`Select ${row.label}`} />
              </td>
              <td className="panes-name">
                <strong title={row.label}>{row.label}</strong>
                <small title={row.tile.url || undefined}>{row.tile.url || `${row.placement} · ${row.openedBy}`}</small>
              </td>
              <td className={`panes-status tile-kind-${row.kind.toLowerCase()}`}>
                {row.kind}
                <small className="panes-sub">{row.tile.status === 'pending' ? 'Awaiting approval' : row.placement}</small>
              </td>
              <td className="panes-session">
                <span title={`${row.sessionName} · ${row.paneLabel}`}>{row.sessionName}</span>
                <small title={row.paneLabel}>{row.paneLabel}</small>
              </td>
              <td className={row.viewing ? 'panes-viewing' : undefined}>{viewedText(row, now)}</td>
              <td title={new Date(row.tile.createdAt).toLocaleString()}>
                {relativeTime(row.tile.createdAt, now)}
                <small className="panes-sub">{row.openedBy}</small>
              </td>
              <td className="panes-actions" onClick={(event) => event.stopPropagation()}>
                <button type="button" onClick={() => onOpen(row.tile.id)} aria-label={`Open ${row.label}`} title="Open beside its pane"><ExternalLink aria-hidden="true" /></button>
                <button type="button" className="danger" disabled={closing || !connected} onClick={() => { void close([row.tile.id]) }}
                  aria-label={`Close tile: ${row.label}`} title="Close tile"><Trash2 aria-hidden="true" /></button>
              </td>
            </tr>)}
          </tbody>
        </table>
        {!shown.length ? <p className="panes-empty">{tiles.length ? 'No tiles match the filter.' : 'No tiles are open.'}</p> : null}
      </div>
    </div>
    {selected ? <aside className="panes-preview" aria-label={`Preview of ${selected.label}`}>
      <header>
        <div>
          <strong title={selected.label}>{selected.label}</strong>
          <small>{selected.kind} · {selected.sessionName} · {selected.paneLabel}</small>
        </div>
        <button type="button" onClick={() => onOpen(selected.tile.id)}><ExternalLink aria-hidden="true" /> Open</button>
        <button type="button" className="danger" disabled={closing || !connected} onClick={() => { void close([selected.tile.id]) }}>
          <Trash2 aria-hidden="true" /> Close
        </button>
        <button type="button" className="panes-preview-close" aria-label="Close preview" onClick={() => setSelectedId(null)}><X aria-hidden="true" /></button>
      </header>
      {embed
        ? <>
          <iframe key={selected.tile.id} className="tiles-frame" src={embed} title={`Preview of ${selected.label}`}
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-downloads allow-modals" referrerPolicy="no-referrer" />
          <p className="tiles-frame-note">A live copy of the page. Sites that refuse embedding show blank here; Open shows the tile itself.</p>
        </>
        : <p className="panes-empty">{selected.tile.status === 'pending'
          ? 'This page is waiting for you to allow its site, so it is not loaded here. Open it to decide.'
          : `${selected.kind === 'Page' ? 'This page has no web address to show' : `A ${selected.kind.toLowerCase()} tile renders inside Commando`}. Open it to see it.`}</p>}
    </aside> : <aside className="panes-preview placeholder"><p className="panes-empty">Select a tile to preview it.</p></aside>}
  </section>
}
