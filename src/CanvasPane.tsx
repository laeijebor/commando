import { CanvasComposer } from './CanvasComposer'
import { CanvasPins, canvasPins, canvasPinPoint } from './CanvasPins'
import { CanvasQueueChip } from './CanvasQueueChip'
import { useCanvasComments } from './useCanvasComments'
import { canvasNoteContext } from './canvasComments'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { parseCanvasManifest, type CanvasAnnotation, type CanvasManifestResult } from '../shared/canvas-manifest'
import { fitCanvas, unionCanvasBounds, zoomAt, type CanvasBounds, type CanvasCamera } from './canvasCamera'
import { subscribeCanvasChanges } from './webPanesApi'
import { CanvasOverview } from './CanvasOverview'
import { CanvasHighlights } from './CanvasHighlights'
import { canvasConnector, canvasLabelBounds } from './canvasGeometry'
import { canvasFrameUrl, useCanvasFrameBridge } from './canvasFrameBridge'
import { useCanvasFlight } from './canvasFlight'
import { labelsForFrame, type CanvasLabelRef } from './canvasLabels'
import './canvas-pane.css'

const EMPTY = parseCanvasManifest({ title: '', frames: [] })
const STATUS_LABELS = { idea: 'Idea', 'in-progress': 'In progress', 'ready-for-review': 'Ready for review', 'ready-for-dev': 'Ready for dev', shipped: 'Shipped' }
const KIND_LABELS = { development: 'Development', important: 'Important', design: 'Design', question: 'Question' }
const NOTE_COLOURS = { development: '#1f9d55', important: '#d97706', design: 'var(--accent)', question: '#0e7490' }
const frameBounds = (frame: CanvasBounds): CanvasBounds => ({ ...frame, y: frame.y - 36, h: frame.h + 36 })

export function CanvasPane({ artifactId, manifest: manifestPath, artifactUrl, onTitle, onClose, webPaneId, token = '' }: {
  webPaneId?: string; token?: string; artifactId: string; manifest: string; artifactUrl?: string; onTitle?: (title: string) => void; onClose?: () => void
}) {
  const [result, setResult] = useState<CanvasManifestResult>(EMPTY)
  const [loaded, setLoaded] = useState(false)
  const [camera, setCamera] = useState<CanvasCamera>({ x: 0, y: 0, scale: 1 })
  const [notesVisible, setNotesVisible] = useState(true)
  const [revisions, setRevisions] = useState<Record<string, number>>({})
  const [sizes, setSizes] = useState<Record<string, { w: number; h: number }>>({})
  const [commentMode, setCommentMode] = useState(false)
  const hitSequence = useRef(0)
  const [panning, setPanning] = useState(false)
  const [overviewOverride, setOverviewOverride] = useState<boolean | null>(null)
  const [wide, setWide] = useState<boolean | null>(null)
  const [selected, setSelected] = useState<CanvasLabelRef | null>(null)
  const [hovered, setHovered] = useState<CanvasLabelRef | null>(null)
  const pane = useRef<HTMLDivElement>(null)
  const viewport = useRef<HTMLDivElement>(null)
  const world = useRef<HTMLDivElement>(null)
  const drag = useRef<{ pointerId: number; x: number; y: number; camera: CanvasCamera } | null>(null)
  const initialFit = useRef(false)
  const manifestRef = useRef(result.manifest)
  const titleCallback = useRef(onTitle)
  useLayoutEffect(() => { manifestRef.current = result.manifest; titleCallback.current = onTitle })
  const baseUrl = artifactUrl ? new URL(`/redline/artifacts/${artifactId}/`, artifactUrl).toString() : `/redline/artifacts/${artifactId}/`

  const comments = useCanvasComments(webPaneId, token, result.manifest.frames, result.manifest.sections)
  const { reports, register, hitTest, forwardPending } = useCanvasFrameBridge(result.manifest.frames, baseUrl, revisions, comments.relay)
  useEffect(() => { forwardPending(comments.snapshot) }, [comments.snapshot, forwardPending, revisions, result.manifest.frames])
  useEffect(() => {
    ++hitSequence.current
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { ++hitSequence.current; setCommentMode(false); comments.close() }
    }
    window.addEventListener('keydown', escape)
    return () => { ++hitSequence.current; window.removeEventListener('keydown', escape) }
  }, [commentMode, artifactId, webPaneId])
  const { flyTo, cancel: cancelFlight } = useCanvasFlight(camera, setCamera, viewport)
  const overviewVisible = overviewOverride ?? (wide ?? false)
  useLayoutEffect(() => {
    const node = pane.current
    if (!node) return
    const measure = () => setWide(node.clientWidth >= 420)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    setSelected(null); setHovered(null); cancelFlight()
    let disposed = false
    let sequence = 0
    const abort = new AbortController()
    initialFit.current = false
    setLoaded(false)
    setRevisions({})
    const load = async () => {
      const request = ++sequence
      try {
        const response = await fetch(baseUrl + manifestPath.split('/').map(encodeURIComponent).join('/'), { cache: 'no-store', signal: abort.signal })
        if (!response.ok) throw new Error(`${manifestPath}: could not load (${response.status})`)
        const parsed = parseCanvasManifest(await response.text())
        if (!disposed && request === sequence) { setResult(parsed); setLoaded(true); titleCallback.current?.(parsed.manifest.title || 'Canvas') }
      } catch (error) {
        if (!disposed && request === sequence) { setResult((current) => ({ ...current, errors: [String((error as Error).message)] })); setLoaded(true) }
      }
    }
    void load()
    const unsubscribe = subscribeCanvasChanges(({ artifactId: changedArtifact, changed }) => {
      if (changedArtifact !== artifactId) return
      const other = changed.filter((path) => path !== manifestPath)
      const frames = manifestRef.current.frames
      const unknown = other.some((path) => !frames.some((frame) => frame.src === path))
      if (changed.includes(manifestPath) || unknown) void load()
      if (!other.length) return
      setRevisions((current) => {
        const next = { ...current }
        for (const frame of frames) if (unknown || other.includes(frame.src)) next[frame.id] = (next[frame.id] ?? 0) + 1
        return next
      })
    })
    return () => { disposed = true; abort.abort(); unsubscribe() }
  }, [artifactId, manifestPath, baseUrl])

  useLayoutEffect(() => {
    const elements = world.current?.querySelectorAll<HTMLElement>('[data-measure]')
    if (!elements) return
    const measure = () => {
      const measured: typeof sizes = {}
      for (const element of elements) measured[element.dataset.measure!] = { w: element.offsetWidth, h: element.offsetHeight }
      setSizes((current) => JSON.stringify(current) === JSON.stringify(measured) ? current : measured)
    }
    measure()
    const observer = new ResizeObserver(measure)
    for (const element of elements) observer.observe(element)
    return () => observer.disconnect()
  }, [result.manifest])

  const { frames, sections, annotations, title } = result.manifest
  const variantBounds = (frame: typeof frames[number]): CanvasBounds => ({ x: frame.x + 16, y: frame.y - 35 - (sizes[`variant:${frame.id}`]?.h || 165), w: sizes[`variant:${frame.id}`]?.w || 330, h: sizes[`variant:${frame.id}`]?.h || 165 })
  const noteBounds = (note: CanvasAnnotation): CanvasBounds => ({ x: note.x, y: note.y, w: note.w ?? 300, h: sizes[`note:${note.id}`]?.h || 120 })
  const sectionBoxes = useMemo(() => sections.map((section) => {
    const members = frames.filter((frame) => section.frames.includes(frame.id))
    if (!members.length) return null
    const bounds = unionCanvasBounds(members.flatMap((frame) => [frameBounds(frame), ...(frame.variant ? [variantBounds(frame)] : [])]))
    return { section, bounds: { x: bounds.x - 60, y: bounds.y - 60, w: bounds.w + 120, h: bounds.h + 120 } }
  }).filter((box) => box !== null), [sections, frames, sizes])
  const allBounds = unionCanvasBounds([
    ...frames.map(frameBounds), ...frames.filter((frame) => frame.variant).map(variantBounds), ...annotations.map(noteBounds),
    ...sectionBoxes.flatMap(({ section, bounds }) => [bounds, { x: bounds.x, y: bounds.y - 50, w: sizes[`section:${section.id}`]?.w || bounds.w, h: 38 }]),
  ])
  const focus = frames.filter((frame) => frame.focus).sort((a, b) => a.focus! - b.focus!)
  const initialBounds = focus.length ? unionCanvasBounds(focus.map(frameBounds)) : allBounds
  const fit = (bounds = allBounds) => {
    cancelFlight()
    const node = viewport.current
    if (node?.clientWidth && node.clientHeight) setCamera(fitCanvas(bounds, { w: node.clientWidth, h: node.clientHeight }))
  }
  useLayoutEffect(() => {
    const node = viewport.current
    const measureCount = annotations.length + frames.filter((frame) => frame.variant).length + sectionBoxes.length
    if (!node || wide === null || !loaded || Object.keys(sizes).length !== measureCount) return
    const initialize = () => {
      if (initialFit.current || !node.clientWidth || !node.clientHeight) return
      initialFit.current = true
      setCamera(fitCanvas(initialBounds, { w: node.clientWidth, h: node.clientHeight }))
    }
    initialize()
    const observer = new ResizeObserver(initialize)
    observer.observe(node)
    return () => observer.disconnect()
  }, [loaded, wide, overviewVisible, initialBounds.x, initialBounds.y, initialBounds.w, initialBounds.h, sizes, annotations.length, frames, sectionBoxes.length])

  useEffect(() => {
    const node = viewport.current
    if (!node) return
    const wheel = (event: WheelEvent) => {
      event.preventDefault()
      cancelFlight()
      initialFit.current = true
      const rect = node.getBoundingClientRect()
      const multiplier = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? node.clientHeight : 1
      setCamera((current) => event.ctrlKey || event.metaKey
        ? zoomAt(current, Math.exp(-event.deltaY * multiplier * 0.01), { x: event.clientX - rect.left, y: event.clientY - rect.top })
        : { ...current, x: current.x - event.deltaX * multiplier, y: current.y - event.deltaY * multiplier })
    }
    node.addEventListener('wheel', wheel, { passive: false })
    return () => node.removeEventListener('wheel', wheel)
  }, [])
  const zoom = (factor: number) => {
    cancelFlight()
    initialFit.current = true
    const node = viewport.current!
    setCamera((current) => zoomAt(current, factor, { x: node.clientWidth / 2, y: node.clientHeight / 2 }))
  }
  const pins = canvasPins(comments.draft, comments.queued, comments.threads)
  const activePin = pins.find((pin) => pin.id === comments.active)
  const activePoint = activePin ? canvasPinPoint(activePin, frames, camera) : null
  const activeNote = comments.queued.find((note) => `pending:${note.id}` === comments.active)
  const activeThread = comments.threads.find((thread) => thread.id === comments.active)
  const dropComment = async (event: React.MouseEvent<HTMLDivElement>) => {
    if (!commentMode || !webPaneId || comments.busy || (event.target as HTMLElement).closest('.canvas-composer, .canvas-pin, .canvas-note, .canvas-variant, .canvas-section-head')) return
    const rect = viewport.current!.getBoundingClientRect()
    const worldPoint = { x: (event.clientX - rect.left - camera.x) / camera.scale, y: (event.clientY - rect.top - camera.y) / camera.scale }
    const frame = [...frames].reverse().find((f) => worldPoint.x >= f.x && worldPoint.x < f.x + f.w && worldPoint.y >= f.y && worldPoint.y < f.y + f.h)
    if (!frame) return
    const point = { x: worldPoint.x - frame.x, y: worldPoint.y - frame.y }
    const sequence = ++hitSequence.current
    const hit = await hitTest(frame.id, point)
    if (hit && sequence === hitSequence.current) comments.openDraft({ canvas: canvasNoteContext(frame, sections, point, hit.label, hit.labelId), hit,
      pageUrl: new URL(canvasFrameUrl(baseUrl, frame, revisions[frame.id]), window.location.href).href })
  }
  const endPan = () => { drag.current = null; setPanning(false) }

  return <div className="canvas-pane" ref={pane}>
    <div className="canvas-toolbar" role="toolbar" aria-label="Canvas controls">
      <button type="button" aria-label="Toggle overview" aria-pressed={overviewVisible} onClick={() => { setOverviewOverride(!overviewVisible); setHovered(null) }}>☰</button>
      <button type="button" aria-label="Zoom out" onClick={() => zoom(0.8)}>−</button>
      <output className="canvas-zoom" aria-label="Zoom">{Math.round(camera.scale * 100)}%</output>
      <button type="button" aria-label="Zoom in" onClick={() => zoom(1.25)}>+</button>
      <button type="button" onClick={() => { initialFit.current = true; fit() }}>Fit</button>
      <span className="canvas-toolbar-separator" />
      <button type="button" aria-pressed={notesVisible} onClick={() => setNotesVisible((visible) => !visible)}>Notes</button>
      <button type="button" aria-label="Comment tool" aria-pressed={commentMode} disabled={!webPaneId || comments.busy} onClick={() => { ++hitSequence.current; setCommentMode(!commentMode) }}>💬</button>
      <CanvasQueueChip count={comments.queued.length} busy={comments.busy} onSend={comments.sendAll} />
      <span className="canvas-toolbar-title" title={title}>{title || 'Canvas'}</span>
      {onClose && <button type="button" aria-label="Close canvas tab" onClick={onClose}>×</button>}
    </div>
    {loaded && result.errors.length > 0 && <div className="canvas-errors" role="alert"><strong>Canvas errors</strong><ul>{result.errors.map((error, i) => <li key={i}>{error}</li>)}</ul></div>}
    {comments.error && <div className="canvas-errors" role="alert">{comments.error}</div>}
    <div className="canvas-body">
      {overviewVisible && <CanvasOverview frames={frames} annotations={annotations} reports={reports} selected={selected} onHover={setHovered}
        threads={comments.threads} queued={comments.queued} onThread={(thread) => {
          const frame = frames.find((f) => f.id === thread.frameId)
          if (!frame) return
          setSelected(null); setHovered(null); initialFit.current = true
          flyTo({ x: frame.x + thread.point.x - 40, y: frame.y + thread.point.y - 40, w: 80, h: 80 })
          ++hitSequence.current; comments.open(thread.id)
        }}
        onSelect={(instance) => { setSelected(instance); initialFit.current = true; flyTo(canvasLabelBounds(frames.find((frame) => frame.id === instance.frameId)!, instance.label.rect)) }}
        onFrame={(frame) => { setSelected(null); setHovered(null); initialFit.current = true; flyTo(frameBounds(frame)) }}
        onNote={(note) => { setSelected(null); setHovered(null); setNotesVisible(true); initialFit.current = true; flyTo(noteBounds(note)) }} />}
      <div className={`canvas-viewport${panning ? ' is-panning' : ''}${commentMode ? ' is-commenting' : ''}`} ref={viewport}
        onClick={(event) => { void dropComment(event) }}
        onPointerDown={(event) => {
          if (commentMode || (event.target as HTMLElement).closest('.canvas-composer, .canvas-pin') || event.button !== 0 || (event.target as HTMLElement).closest('.canvas-frame, .canvas-note, .canvas-variant, .canvas-section-head')) return
          cancelFlight()
          initialFit.current = true
          drag.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, camera }
          event.currentTarget.setPointerCapture(event.pointerId)
          setPanning(true)
        }}
        onPointerMove={(event) => {
          const start = drag.current
          if (start && event.pointerId === start.pointerId) setCamera({ ...start.camera, x: start.camera.x + event.clientX - start.x, y: start.camera.y + event.clientY - start.y })
        }} onPointerUp={endPan} onPointerCancel={endPan} onLostPointerCapture={endPan}>
        <div ref={world} className={`canvas-world${notesVisible ? '' : ' hide-notes'}`} style={{ transform: `translate(${camera.x}px, ${camera.y}px) scale(${camera.scale})` }}>
          {sectionBoxes.map(({ section, bounds }) => <div key={section.id} className="canvas-section" style={{ left: bounds.x, top: bounds.y, width: bounds.w, height: bounds.h }}>
            <div className="canvas-section-head" data-measure={`section:${section.id}`}><span className="canvas-chip">{section.ticket ? `[${section.ticket}] ` : ''}{section.title}</span><span className={`canvas-chip canvas-status status-${section.status}`}>{STATUS_LABELS[section.status]}</span></div>
          </div>)}
          {frames.map((frame) => <div key={frame.id} className={`canvas-frame${frame.focus ? ' is-focus' : ''}`} style={{ left: frame.x, top: frame.y, width: frame.w, height: frame.h }}>
            <div className="canvas-frame-label">{frame.platform && <i>[{frame.platform}]</i>}<b>{frame.title}</b>{frame.focus && <span className="canvas-badge focus">★ Focus {frame.focus}</span>}<span className={`canvas-badge ${frame.interactive ? 'live' : 'static'}`}>{frame.interactive ? '▶ Interactive' : 'Static'}</span></div>
            <iframe ref={(node) => register(frame.id, node)} title={frame.title} sandbox="allow-scripts" loading="lazy" src={canvasFrameUrl(baseUrl, frame, revisions[frame.id])} />
          </div>)}
          {frames.filter((frame) => frame.variant).map((frame) => <div key={frame.id} className="canvas-variant" data-measure={`variant:${frame.id}`} style={{ left: variantBounds(frame).x, top: variantBounds(frame).y }}>
            {frame.variant!.context && <span>{frame.variant!.context}</span>}<b>{frame.variant!.title}</b>{frame.variant!.description && <span>{frame.variant!.description}</span>}
          </div>)}
          <svg className="canvas-connectors" aria-hidden="true">{annotations.map((note) => {
            const frame = frames.find((frame) => frame.id === note.target?.frame)
            if (!frame) return null
            const label = labelsForFrame(reports, frame.id).find((label) => label.name === note.target?.label)
            const { path, end } = canvasConnector(noteBounds(note), label ? canvasLabelBounds(frame, label.rect) : frame)
            return <g key={note.id}><path d={path} fill="none" stroke={NOTE_COLOURS[note.kind]} strokeWidth="2.5" />{label && <circle cx={end.x} cy={end.y} r="4" fill={NOTE_COLOURS[note.kind]} />}</g>
          })}</svg>
          {annotations.map((note) => <div key={note.id} className="canvas-note" data-measure={`note:${note.id}`} style={{ left: note.x, top: note.y, width: note.w ?? 300 }}>
            <span className="canvas-kind" style={{ background: NOTE_COLOURS[note.kind] }}>{KIND_LABELS[note.kind]}</span>
            {note.title && <strong className="canvas-note-title">{note.title}</strong>}{note.text && <div>{note.text}</div>}{note.items && <ul>{note.items.map((item, i) => <li key={i}>{item}</li>)}</ul>}
          </div>)}
        </div>
        <CanvasHighlights frames={frames} reports={reports} camera={camera} selected={selected} hovered={hovered} />
        <CanvasPins pins={pins} frames={frames} camera={camera} active={comments.active} onOpen={(id) => { if (!comments.busy) { ++hitSequence.current; comments.open(id) } }} />
        {activePin && activePoint && <CanvasComposer key={activePin.id} point={activePoint} label={activePin.canvas.label || activeThread?.selector || activeNote?.selector || comments.draft?.hit.selector || 'Unlabelled'}
          text={activeNote?.comment ?? activeThread?.messages[0]?.text ?? comments.draft?.comment} sent={activePin.state === 'sent'} queued={activePin.state === 'queued'} busy={comments.busy}
          onComment={comments.updateDraftComment}
          onQueue={(text) => { void comments.queueDraft(text, false) }} onSend={(text) => { if (activeNote) void comments.sendThis(activeNote); else void comments.queueDraft(text, true) }}
          onCancel={() => { ++hitSequence.current; comments.close() }} />}
        <div className="canvas-hint">{commentMode ? 'Click a frame to comment · Esc to exit' : loaded ? 'Drag to pan · ⌘/Ctrl/pinch to zoom' : 'Loading canvas…'}</div>
      </div>
    </div>
  </div>
}
