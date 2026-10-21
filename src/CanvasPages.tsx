import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { createPortal } from 'react-dom'
import { CANVAS_STATUSES, type CanvasPage, type CanvasSection } from '../shared/canvas-manifest'

export type CanvasPageRow = CanvasPage & { frames: number; questions: number; comments: number; status?: CanvasSection['status'] }

const COLLAPSED_KEY = 'commando:canvas-pages-collapsed', HEIGHT_KEY = 'commando:canvas-pages-height'
const MIN_HEIGHT = 48
const stored = (key: string) => { try { return localStorage.getItem(key) } catch { return null } }
const store = (key: string, value: string) => { try { localStorage.setItem(key, value) } catch { /* private mode */ } }

/** A page reads as far along as its least advanced section. */
export function canvasPageStatus(sections: CanvasSection[]): CanvasSection['status'] | undefined {
  return sections.reduce<CanvasSection['status'] | undefined>((least, { status }) =>
    least === undefined || CANVAS_STATUSES.indexOf(status) < CANVAS_STATUSES.indexOf(least) ? status : least, undefined)
}

function PageBadges({ page }: { page: CanvasPageRow }) {
  return <>
    {page.questions > 0 && <em className="canvas-o-count is-question" aria-label={`${page.questions} open questions`}>?{page.questions}</em>}
    {page.comments > 0 && <em className="canvas-o-count" aria-label={`${page.comments} open comments`}>💬{page.comments}</em>}
    <em className="canvas-o-count" aria-label={`${page.frames} frames`}>{page.frames}</em>
  </>
}

/** The sidebar's page list: collapsible, with a divider that resizes it against the components below. */
export function CanvasPagesList({ pages, active, onSelect }: { pages: CanvasPageRow[]; active?: string; onSelect: (id: string) => void }) {
  const [collapsed, setCollapsed] = useState(() => stored(COLLAPSED_KEY) === '1')
  const [height, setHeight] = useState<number | null>(() => Number(stored(HEIGHT_KEY)) || null)
  const panel = useRef<HTMLDivElement>(null)
  const drag = useRef<{ pointerId: number; y: number; h: number } | null>(null)
  const listId = useId()
  const resize = (next: number) => {
    const limit = (panel.current?.parentElement?.clientHeight ?? 600) * 0.8
    const clamped = Math.round(Math.min(Math.max(next, MIN_HEIGHT), Math.max(limit, MIN_HEIGHT)))
    setHeight(clamped); store(HEIGHT_KEY, String(clamped))
  }
  const toggle = () => setCollapsed((value) => { store(COLLAPSED_KEY, value ? '0' : '1'); return !value })
  const frames = pages.reduce((sum, page) => sum + page.frames, 0)
  return <>
    <div ref={panel} className={`canvas-pages${collapsed ? ' is-collapsed' : ''}`} style={!collapsed && height ? { height, maxHeight: 'none' } : undefined}>
      <button type="button" className="canvas-pages-head" aria-expanded={!collapsed} aria-controls={listId} onClick={toggle}>
        <span aria-hidden="true">{collapsed ? '▸' : '▾'}</span><b>Pages</b><em>{pages.length} · {frames} frames</em>
      </button>
      {!collapsed && <div className="canvas-pages-list" id={listId}>
        {pages.map((page) => <button type="button" key={page.id} className={`canvas-page-row${page.id === active ? ' is-active' : ''}`}
          aria-current={page.id === active ? 'page' : undefined} title={page.title} onClick={() => onSelect(page.id)}>
          <i className={`canvas-page-dot${page.status ? ` status-${page.status}` : ''}`} aria-hidden="true" /><span>{page.title}</span><PageBadges page={page} />
        </button>)}
      </div>}
    </div>
    {!collapsed && <div className="canvas-pages-divider" role="separator" aria-orientation="horizontal" aria-label="Resize pages list" tabIndex={0}
      aria-valuenow={height ?? undefined}
      onKeyDown={(event: KeyboardEvent) => {
        if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
        event.preventDefault(); resize((panel.current?.offsetHeight ?? 0) + (event.key === 'ArrowDown' ? 24 : -24))
      }}
      onPointerDown={(event: PointerEvent<HTMLDivElement>) => {
        drag.current = { pointerId: event.pointerId, y: event.clientY, h: panel.current?.offsetHeight ?? 0 }
        event.currentTarget.setPointerCapture(event.pointerId)
      }}
      onPointerMove={(event) => { const start = drag.current; if (start?.pointerId === event.pointerId) resize(start.h + event.clientY - start.y) }}
      onPointerUp={() => { drag.current = null }} onPointerCancel={() => { drag.current = null }} />}
  </>
}

/** Narrow tiles hide the sidebar, so the toolbar offers the pages instead.
 * The list renders into the pane's overlay so the toolbar cannot clip it. */
export function CanvasPageMenu({ pages, active, onSelect, overlay }: { pages: CanvasPageRow[]; active?: string; onSelect: (id: string) => void; overlay: HTMLElement | null }) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null), list = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null)
  const index = pages.findIndex((page) => page.id === active)
  useLayoutEffect(() => {
    if (!open || !overlay || !root.current) { setPosition(null); return }
    const bounds = overlay.getBoundingClientRect(), trigger = root.current.getBoundingClientRect()
    setPosition({ left: Math.max(4, trigger.left - bounds.left), top: trigger.bottom - bounds.top + 4 })
  }, [open, overlay])
  useEffect(() => {
    if (!open) return
    const close = (event: Event) => { if (!(event.target instanceof Node) || !(root.current?.contains(event.target) || list.current?.contains(event.target))) setOpen(false) }
    const escape = (event: globalThis.KeyboardEvent) => { if (event.key === 'Escape') setOpen(false) }
    window.addEventListener('pointerdown', close, true); window.addEventListener('keydown', escape)
    return () => { window.removeEventListener('pointerdown', close, true); window.removeEventListener('keydown', escape) }
  }, [open])
  return <div className="canvas-page-menu" ref={root}>
    <button type="button" className="canvas-page-picker" aria-haspopup="menu" aria-expanded={open} aria-label={`Page: ${pages[index]?.title ?? ''}`} onClick={() => setOpen(!open)}>
      <span>{pages[index]?.title}</span><em>{index + 1}/{pages.length}</em><span aria-hidden="true">▾</span>
    </button>
    {open && overlay && createPortal(<div ref={list} className="canvas-page-menu-list" role="menu" aria-label="Pages"
      style={position ? { left: position.left, top: position.top } : { visibility: 'hidden' }}>
      {pages.map((page, i) => <button type="button" role="menuitemradio" aria-checked={page.id === active} key={page.id}
        className={`canvas-page-row${page.id === active ? ' is-active' : ''}`} onClick={() => { setOpen(false); onSelect(page.id) }}>
        <span>{i + 1} · {page.title}</span><PageBadges page={page} />
      </button>)}
    </div>, overlay)}
  </div>
}
