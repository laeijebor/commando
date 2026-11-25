import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react'
import type { BoardPlacement, BoardView } from '../shared/board'
import type { PanePrSummary } from './prsApi'
import { canvasTransform, createCanvasCameraStore, fitCanvas, unionCanvasBounds, zoomAt, type CanvasBounds, type CanvasCamera } from './canvasCamera'
import { canvasGestureStep, snapCanvasMove } from './canvasInteraction'
import { canvasConnector } from './canvasGeometry'
import { BOARD_CARD_SIZE, boardGroupAt, boardInViewport, boardLod, boardWorldPoint, type BoardEntry } from './BoardGeometry'
import { BoardCard, type BoardThumbUrl } from './BoardCards'

type Drag = { id: number; key?: string; start: { x: number; y: number }; origin: { x: number; y: number }; camera: CanvasCamera; moved: boolean }

export function BoardCanvas({ board, items, thumbUrl, prs, pending, onOpen, onPlace }: {
  board: BoardView; items: BoardEntry[]; thumbUrl: BoardThumbUrl; prs: ReadonlyMap<string, PanePrSummary>; pending: boolean
  onOpen: (item: BoardEntry, trigger: HTMLElement) => void; onPlace: (key: string, placement: Partial<BoardPlacement>) => void
}) {
  const [store] = useState(() => createCanvasCameraStore({ x: 24, y: 24, scale: 1 }))
  const stage = useRef<HTMLDivElement>(null)
  const viewport = useRef<HTMLDivElement>(null)
  const world = useRef<HTMLDivElement>(null)
  const zoomLabel = useRef<HTMLOutputElement>(null)
  const drag = useRef<Drag | null>(null)
  const suppressClick = useRef(false)
  const [preview, setPreview] = useState<{ key: string; x: number; y: number } | null>(null)
  const [size, setSize] = useState({ w: 800, h: 600 })
  const [drawCamera, setDrawCamera] = useState(store.get)
  const arrowId = `board-arrow-${useId().replace(/:/g, '')}`
  const lod = boardLod(drawCamera.scale)
  const placed = useMemo(() => items.filter((item) => board.placements[item.key]), [board.placements, items])
  const unplaced = useMemo(() => items.filter((item) => !board.placements[item.key]).sort((a, b) => b.addedAt - a.addedAt), [board.placements, items])

  useLayoutEffect(() => {
    let settle = 0
    let previousLod = boardLod(store.get().scale)
    const update = () => {
      const camera = store.get()
      if (world.current) world.current.style.transform = canvasTransform(camera)
      if (zoomLabel.current) zoomLabel.current.textContent = `${Math.round(camera.scale * 100)}%`
      // Transform every frame; throttle React culling while the screen of overscan covers movement.
      if (previousLod !== boardLod(camera.scale)) setDrawCamera(camera)
      previousLod = boardLod(camera.scale)
      if (!settle) settle = window.setTimeout(() => { settle = 0; setDrawCamera(store.get()) }, 100)
    }
    update()
    const stop = store.subscribe(update)
    return () => { stop(); window.clearTimeout(settle) }
  }, [store])
  useLayoutEffect(() => {
    const node = viewport.current
    if (!node) return
    const update = () => {
      const rect = node.getBoundingClientRect()
      if (rect.width && rect.height) setSize({ w: rect.width, h: rect.height })
    }
    update()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(update); observer.observe(node)
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    const node = viewport.current
    if (!node) return
    const wheel = (event: WheelEvent) => {
      event.preventDefault()
      if (event.ctrlKey || event.metaKey) {
        const rect = node.getBoundingClientRect()
        store.set((camera) => zoomAt(camera, Math.exp(-event.deltaY * 0.01), { x: event.clientX - rect.left, y: event.clientY - rect.top }))
      } else {
        const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? node.clientHeight : 1
        store.set((camera) => ({ ...camera, x: camera.x - event.deltaX * unit, y: camera.y - event.deltaY * unit }))
      }
    }
    type GestureEvent = Event & { scale: number; clientX: number; clientY: number }
    let previousScale = 1
    const start = (event: Event) => { event.preventDefault(); previousScale = 1 }
    const pinch = (event: Event) => {
      event.preventDefault()
      const gesture = event as GestureEvent, factor = canvasGestureStep(previousScale, gesture.scale)
      if (!factor) return
      previousScale = gesture.scale
      const rect = node.getBoundingClientRect()
      store.set((camera) => zoomAt(camera, factor, { x: gesture.clientX - rect.left, y: gesture.clientY - rect.top }))
    }
    node.addEventListener('wheel', wheel, { passive: false })
    node.addEventListener('gesturestart', start, { passive: false }); node.addEventListener('gesturechange', pinch, { passive: false })
    return () => { node.removeEventListener('wheel', wheel); node.removeEventListener('gesturestart', start); node.removeEventListener('gesturechange', pinch) }
  }, [store])
  const pointAt = (event: { clientX: number; clientY: number }) => {
    const rect = viewport.current!.getBoundingClientRect()
    return boardWorldPoint({ x: event.clientX - rect.left, y: event.clientY - rect.top }, store.get())
  }
  const start = (event: ReactPointerEvent<HTMLElement>, item?: BoardEntry) => {
    if (event.button !== 0 || (item && pending)) return
    if (!item && (event.target as HTMLElement).closest('button, .board-inbox')) return
    event.stopPropagation()
    const camera = store.get(), point = pointAt(event)
    drag.current = { id: event.pointerId, key: item?.key, start: { x: event.clientX, y: event.clientY }, origin: item ? board.placements[item.key] ?? point : point, camera, moved: false }
    suppressClick.current = false
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  const move = (event: ReactPointerEvent<HTMLDivElement>) => {
    const current = drag.current
    if (!current || current.id !== event.pointerId) return
    const delta = { x: event.clientX - current.start.x, y: event.clientY - current.start.y }
    if (!current.moved && Math.hypot(delta.x, delta.y) < 4) return
    current.moved = true; suppressClick.current = true
    if (current.key) {
      const position = board.placements[current.key] ? snapCanvasMove(current.origin, delta, store.get().scale) : snapCanvasMove(pointAt(event), { x: 0, y: 0 }, 1)
      setPreview({ key: current.key, ...position })
    } else store.set({ ...current.camera, x: current.camera.x + delta.x, y: current.camera.y + delta.y })
  }
  const finish = (event: ReactPointerEvent<HTMLDivElement>, commit: boolean) => {
    const current = drag.current
    if (!current || current.id !== event.pointerId) return
    drag.current = null
    if (stage.current?.hasPointerCapture(event.pointerId)) stage.current.releasePointerCapture(event.pointerId)
    if (commit && current.moved && current.key) {
      const rect = viewport.current!.getBoundingClientRect()
      if (event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom) {
        const point = pointAt(event), group = boardGroupAt(board.groups, point)
        const position = board.placements[current.key]
          ? snapCanvasMove(current.origin, { x: event.clientX - current.start.x, y: event.clientY - current.start.y }, store.get().scale)
          : snapCanvasMove(point, { x: 0, y: 0 }, 1)
        onPlace(current.key, group ? { group: group.id } : { ...position, fixed: true })
      }
    }
    setPreview(null)
  }
  const open = (item: BoardEntry, trigger: HTMLElement) => { if (!suppressClick.current) onOpen(item, trigger) }
  const card = (item: BoardEntry, compact = false) => <BoardCard item={item} thumbUrl={thumbUrl} onOpen={open} compact={compact}
    onPointerDown={(event, entry) => start(event, entry)} lod={lod === 'full' ? 'full' : 'thumbnail'} pr={prs.get(item.key)} />
  const boxes: CanvasBounds[] = [...board.groups, ...placed.map((item) => ({ ...board.placements[item.key], ...BOARD_CARD_SIZE }))]
  const endpoint = (id: string) => board.groups.find((group) => group.id === id) ?? (board.placements[id] ? { ...board.placements[id], ...BOARD_CARD_SIZE } : undefined)
  const zoom = (factor: number) => store.set((camera) => zoomAt(camera, factor, { x: size.w / 2, y: size.h / 2 }))
  return <div className="board-canvas" ref={stage} onPointerMove={move} onPointerUp={(event) => finish(event, true)} onPointerCancel={(event) => finish(event, false)}
    onClickCapture={(event) => { if (suppressClick.current) { event.preventDefault(); event.stopPropagation(); suppressClick.current = false } }}>
    <div className="board-viewport" ref={viewport} aria-label="Board canvas" onPointerDown={(event) => start(event)}>
      <div className={`board-world lod-${lod}`} ref={world}>
        {board.groups.filter((group) => boardInViewport(group, drawCamera, size)).map((group) => <section key={group.id} className="board-group" data-tone={group.tone ?? 'accent'}
          style={{ left: group.x, top: group.y, width: group.w, height: group.h } as CSSProperties} aria-label={`Group: ${group.title}`}>
          <header><strong>{group.title}</strong><small>placed by {group.by === 'user' ? 'you' : group.by === 'agent' ? 'agent' : 'auto'}</small></header>
        </section>)}
        <svg className="board-links" aria-hidden="true"><defs><marker id={arrowId} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" /></marker></defs>
          {board.links.map((link) => {
            const from = endpoint(link.from), to = endpoint(link.to)
            if (!from || !to) return null
            const curve = canvasConnector(from, to)
            return <g key={link.id}><path d={curve.path} markerEnd={`url(#${arrowId})`} />{link.label && <text x={(from.x + from.w / 2 + to.x + to.w / 2) / 2} y={(from.y + from.h / 2 + to.y + to.h / 2) / 2 - 8}>{link.label}</text>}</g>
          })}
        </svg>
        {lod !== 'groups' && placed.filter((item) => boardInViewport({ ...board.placements[item.key], ...BOARD_CARD_SIZE }, drawCamera, size)).map((item) => {
          const p = preview?.key === item.key ? preview : board.placements[item.key]
          return <div className="board-placed-item" key={item.key} style={{ left: p.x, top: p.y, width: BOARD_CARD_SIZE.w }}>{card(item)}</div>
        })}
        {lod !== 'groups' && preview && !board.placements[preview.key] && <div className="board-placed-item is-dragging" style={{ left: preview.x, top: preview.y, width: BOARD_CARD_SIZE.w }}>{card(items.find((item) => item.key === preview.key)!)}</div>}
      </div>
      {!board.items.length && <div className="board-empty"><strong>A space for what you make</strong><p>Canvases, links, files and other artifacts appear here as you work.</p></div>}
      {!!board.items.length && !placed.length && <p className="board-placement-hint">Drag an item from Unplaced to start your board.</p>}
      <div className="board-zoom" onPointerDown={(event) => event.stopPropagation()}>
        <button type="button" aria-label="Zoom out" onClick={() => zoom(1 / 1.2)}>−</button><output ref={zoomLabel} aria-label="Board zoom">100%</output>
        <button type="button" aria-label="Zoom in" onClick={() => zoom(1.2)}>+</button><button type="button" onClick={() => store.set(fitCanvas(unionCanvasBounds(boxes), size))}>Fit</button>
      </div>
    </div>
    <aside className="board-inbox" aria-label="Unplaced inbox"><h3>Unplaced <b>{unplaced.length}</b></h3><p>Captured automatically. Drag onto the board or into a group.</p>
      {unplaced.map((item) => <div key={item.key}>{card(item, true)}</div>)}
      {!unplaced.length && <small>Everything has a place.</small>}
    </aside>
  </div>
}
