import { useCallback, useEffect, useMemo, useRef, useState, type ComponentProps } from 'react'
import { Search, X } from 'lucide-react'
import { PaneWorklog } from './PaneWorklog'
import { useHost } from './HostContext'
import { boardThumbPath, createBoardsApi, type BoardsApiClient } from './boardsApi'
import { BoardCanvas } from './BoardCanvas'
import { BoardCard, type BoardThumbUrl } from './BoardCards'
import { BOARD_TYPES, boardMatches, boardMatchesClosed, boardPlaced, boardType, type BoardEntry, type BoardType } from './BoardGeometry'
import { BoardQuickLook } from './BoardQuickLook'
import { useBoard } from './useBoard'
import type { PanePrList, PanePrSummary } from './prsApi'
import './board-tile.css'

type BoardTileProps = ComponentProps<typeof PaneWorklog> & { token?: string; boardApi?: BoardsApiClient; panePrs?: PanePrList | null }
type View = 'board' | 'type'
const storedView = (key: string): View => {
  try { return localStorage.getItem(key) === 'type' ? 'type' : 'board' } catch { return 'board' }
}

export function BoardTile({ token = '', boardApi, panePrs, ...worklog }: BoardTileProps) {
  const { brief, paneLabel, visible = true, revealInFinder = false, connected = true } = worklog
  const { activeHost, daemonFetch, path, local } = useHost()
  const targetId = brief.targetId ?? `${brief.sessionId}:${brief.paneId}`
  const preferenceKey = `commando.board.${activeHost}:${targetId}.view`
  const [view, setView] = useState<View>(() => storedView(preferenceKey))
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<BoardType | null>(null)
  const [closedOnly, setClosedOnly] = useState(false)
  const [details, setDetails] = useState(false)
  const [narrow, setNarrow] = useState(false)
  const [selection, setSelection] = useState<{ key: string; trigger: HTMLElement } | null>(null)
  const root = useRef<HTMLElement>(null)
  const detailsPanel = useRef<HTMLDivElement>(null)
  const detailsButton = useRef<HTMLButtonElement>(null)
  const focusSection = useRef<'notes' | 'terms' | null>(null)
  const api = useMemo(() => boardApi ?? createBoardsApi(token, daemonFetch), [boardApi, token, daemonFetch])
  const { board, error, pending, mutate, retry } = useBoard(targetId, activeHost, visible, api)
  useEffect(() => { setView(storedView(preferenceKey)) }, [preferenceKey])
  const changeView = (next: View) => {
    setView(next)
    try { localStorage.setItem(preferenceKey, next) } catch { /* Keep this view in memory. */ }
  }
  useEffect(() => {
    const node = root.current
    if (!node || typeof ResizeObserver === 'undefined') return
    const update = () => { const width = node.getBoundingClientRect().width; if (width > 0) setNarrow(width < 420) }
    const observer = new ResizeObserver(update); observer.observe(node); update()
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    if (!details || !focusSection.current) return
    const section = focusSection.current
    focusSection.current = null
    const frame = requestAnimationFrame(() => {
      const node = detailsPanel.current?.querySelector<HTMLElement>(section === 'notes' ? '.pane-worklog-note' : '.pane-worklog-references')
      node?.scrollIntoView?.({ block: 'start' })
      if (section === 'notes') node?.querySelector('textarea')?.focus({ preventScroll: true })
    })
    return () => cancelAnimationFrame(frame)
  }, [details])
  const openDetails = (section?: 'notes' | 'terms') => {
    focusSection.current = section ?? null
    setDetails(true)
    if (details && section) {
      const node = detailsPanel.current?.querySelector<HTMLElement>(section === 'notes' ? '.pane-worklog-note' : '.pane-worklog-references')
      node?.scrollIntoView?.({ block: 'start' })
      if (section === 'notes') node?.querySelector('textarea')?.focus({ preventScroll: true })
    }
  }
  const closeDetails = () => { setDetails(false); detailsButton.current?.focus() }
  const open = useCallback((item: BoardEntry, trigger: HTMLElement) => setSelection({ key: item.key, trigger }), [])
  const close = useCallback(() => setSelection((current) => { if (current?.trigger.isConnected) current.trigger.focus(); else detailsButton.current?.focus(); return null }), [])
  const selected = board?.items.find((item) => item.key === selection?.key)
  const tasks = (brief.tasks ?? []).filter((task) => task.status !== 'cancelled')
  const completed = tasks.filter((task) => task.status === 'completed').length
  const terms = (brief.references?.length ?? 0) + (local ? (brief.simulator ? 1 : 0) + (brief.devices?.length ?? 0) : 0)
  const items = useMemo(() => board?.items.filter((item) => boardMatches(item, query)) ?? [], [board, query])
  const counts = useMemo(() => Object.fromEntries(BOARD_TYPES.map((type) => [type.id, items.filter((item) => boardType(item) === type.id && boardMatchesClosed(item, closedOnly)).length])) as Record<BoardType, number>, [items, closedOnly])
  const cachedPrs = panePrs
  const prs = new Map<string, PanePrSummary>()
  if (cachedPrs && (!brief.targetId || cachedPrs.targetId === brief.targetId)) for (const pr of [...cachedPrs.pullRequests, ...cachedPrs.impacted ?? []]) prs.set(`pr:${pr.repo.toLowerCase()}#${pr.number}`, pr)
  // The thumb route is a host-owned image resource; no live content is embedded here.
  const thumbUrl: BoardThumbUrl = useCallback((item, size, hash) => {
    const url = path(boardThumbPath(hash ?? (item.thumb?.hash || item.preview?.image || ''), size))
    return token ? `${url}?token=${encodeURIComponent(token)}` : url
  }, [path, token])
  const card = (item: BoardEntry, compact = false) => <BoardCard key={item.key} item={item} thumbUrl={thumbUrl} onOpen={open} pr={prs.get(item.key)} compact={compact} />
  const headline = worklog.empty ? `Board for ${paneLabel}` : brief.headline
  return <section className={`board-tile${narrow ? ' is-narrow' : ''}`} ref={root} aria-label={`Board for ${paneLabel}`}>
    <header className="board-brief" aria-label="Brief strip">
      <span className={`board-status state-${worklog.hookConnected === false && !worklog.empty ? 'stale' : brief.state}`} aria-label={`Status: ${brief.state}`} />
      <strong title={headline}>{headline}</strong>
      <span className="board-task-progress"><span className="board-progress-bar" role="progressbar" aria-label="Task progress" aria-valuemin={0} aria-valuemax={tasks.length || 1} aria-valuenow={completed}><i style={{ width: `${tasks.length ? completed / tasks.length * 100 : 0}%` }} /></span>{completed}/{tasks.length} tasks</span>
      <button type="button" onClick={() => openDetails('notes')}>My notes</button><button type="button" onClick={() => openDetails('terms')}>Terms · {terms}</button>
      <button type="button" ref={detailsButton} aria-expanded={details} onClick={() => details ? closeDetails() : openDetails()}>Details</button>
    </header>
    {!narrow && <div className="board-toolbar"><div className="board-view-switch" role="group" aria-label="Board view">
      <button type="button" aria-pressed={view === 'board'} onClick={() => changeView('board')}>Board</button><button type="button" aria-pressed={view === 'type'} onClick={() => changeView('type')}>By type</button>
    </div><span className="board-item-count">{board?.items.length ?? 0} items</span><label className="board-search"><Search size={14} /><input aria-label="Search board" value={query} placeholder="Search this board" onChange={(event) => setQuery(event.target.value)} /></label></div>}
    <div className="board-content">
      {error && !selected && <div className="board-error" role="alert">{error}<button type="button" onClick={retry}>Retry</button></div>}
      {!board && !error && <p className="board-loading" role="status">Loading board…</p>}
      {board && (narrow ? <div className="board-compact">
        <section><h3>Recent <small>· newest first</small></h3><div className="board-filmstrip">{[...board.items].sort((a, b) => b.addedAt - a.addedAt).slice(0, 6).map((item) => card(item, true))}</div>{!board.items.length && <p>Artifacts appear here as you work.</p>}</section>
        <section><h3>On the board</h3><div className="board-type-counts">{BOARD_TYPES.map((type) => <span key={type.id}>{type.label}<b>{counts[type.id]}</b></span>)}</div>
          <button type="button" disabled title="Widen this tile to at least 420 px to open the board">Open board ↗</button><small>Widen this tile to open the board.</small></section>
        <section><h3>Tasks <small>{completed}/{tasks.length}</small></h3><ul className="board-compact-tasks">{tasks.slice(0, 4).map((task) => <li key={task.id} data-status={task.status}><span aria-hidden="true">{task.status === 'completed' ? '✓' : '□'}</span>{task.content}</li>)}</ul>{tasks.length > 4 && <button type="button" onClick={() => openDetails()}>All {tasks.length} tasks</button>}</section>
      </div> : view === 'board' ? <BoardCanvas key={`${activeHost}:${targetId}`} cameraKey={`commando.board.${activeHost}:${targetId}.camera`} board={board} items={items} thumbUrl={thumbUrl} prs={prs} pending={pending || !connected} onOpen={open}
        onPlace={(key, placement) => { void mutate((current) => boardPlaced(current, key, placement), () => api.place(targetId, key, placement)) }} />
        : <div className="board-by-type"><div className="board-filter-chips" role="group" aria-label="Filter by type">
          <button type="button" aria-pressed={filter === null} onClick={() => setFilter(null)}>All <b>{Object.values(counts).reduce((sum, count) => sum + count, 0)}</b></button>
          {BOARD_TYPES.map((type) => <button key={type.id} type="button" aria-pressed={filter === type.id} onClick={() => setFilter((current) => current === type.id ? null : type.id)}>{type.label} <b>{counts[type.id]}</b></button>)}
          <button type="button" aria-pressed={closedOnly} onClick={() => setClosedOnly((current) => !current)}>Closed tiles</button>
        </div><div className="board-type-scroll">{BOARD_TYPES.filter((type) => filter === null || type.id === filter).map((type) => {
          const entries = items.filter((item) => boardType(item) === type.id && boardMatchesClosed(item, closedOnly)).sort((a, b) => b.addedAt - a.addedAt)
          return entries.length > 0 && <section className="board-type-row" key={type.id} aria-label={type.label}><h3>{type.label} <small>{entries.length}</small></h3><div className="board-type-cards">{entries.map((item) => card(item))}</div></section>
        })}{!BOARD_TYPES.some((type) => (filter === null || type.id === filter) && counts[type.id] > 0) && <p className="board-empty">{query || closedOnly || filter ? 'No matching items.' : 'Artifacts appear here as you work.'}</p>}</div></div>)}
      <div className="board-details" hidden={!details} ref={detailsPanel} onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); closeDetails() } }}>
        <header><strong>Details</strong><button type="button" aria-label="Close details" onClick={closeDetails}><X size={16} /></button></header>
        <PaneWorklog {...worklog} fullWidth visible={visible && details} />
      </div>
      {selected && visible && <BoardQuickLook key={selected.key} item={selected} thumbUrl={thumbUrl} revealInFinder={revealInFinder} pending={pending || !connected} boardError={error} onClose={close}
        onRevive={async () => {
          if (selected.kind === 'pr') {
            if (!selected.ref.pr || !worklog.onOpenPr) throw new Error('PR quick look is unavailable')
            worklog.onOpenPr(selected.ref.pr.repo, selected.ref.pr.number)
          } else {
            const result = await api.revive(targetId, selected.key, brief.paneId)
            if (result.path) await api.reveal(targetId, selected.key)
          }
          close(); retry()
        }}
        onReveal={() => api.reveal(targetId, selected.key)}
        onPin={async () => { await mutate((current) => ({ ...current, items: current.items.map((item) => item.key === selected.key ? { ...item, pinned: !item.pinned } : item) }), () => api.patch(targetId, selected.key, { pinned: !selected.pinned })) }}
        onRemove={async () => { const removed = await mutate((current) => ({ ...current, items: current.items.filter((item) => item.key !== selected.key) }), () => api.remove(targetId, selected.key)); if (removed) close() }} />}
    </div>
  </section>
}
