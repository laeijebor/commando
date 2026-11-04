import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, Download, Grid2X2, MessageCircle, NotebookText, Palette, Play, Presentation } from 'lucide-react'
import { encodeCanvasPath, type CanvasFrame, type CanvasManifestResult } from '../shared/canvas-manifest'
import type { CanvasSnapshot } from '../shared/canvas-snapshot'
import type { CanvasSpotlightRequest } from '../shared/protocol'
import { CanvasHistory, canvasSnapshotTime } from './CanvasHistory'
import { CanvasPins, canvasPins, canvasPinPoint } from './CanvasPins'
import { CanvasComposer } from './CanvasComposer'
import { CanvasHighlights } from './CanvasHighlights'
import { CanvasSpotlightToast } from './CanvasSpotlightToast'
import { CanvasQuestionControls } from './CanvasQuestionControls'
import { canvasQuestion, canvasQuestionsPage } from './canvasQuestions'
import { pendingForQuestion, sentForQuestion, TileReviewLayer } from './TileReviewLayer'
import { useCanvasComments } from './useCanvasComments'
import { useCanvasLayout } from './useCanvasLayout'
import { canvasFrameUrl, useCanvasFrameBridge } from './canvasFrameBridge'
import { canvasNoteContext } from './canvasComments'
import { labelKey, labelsForFrame, type CanvasLabelRef } from './canvasLabels'
import { canvasRequest } from './canvasWrite'
import { useSlidesReview } from './useSlidesReview'
import './canvas-pane.css'
import './slides-pane.css'

const EMPTY: CanvasManifestResult = { manifest: { title: '', frames: [], annotations: [], sections: [], pages: [] }, errors: [] }
function Thumbnail({ frame, src }: { frame: CanvasFrame; src: string }) {
  const ref = useRef<HTMLDivElement>(null), [width, setWidth] = useState(128)
  useLayoutEffect(() => {
    const node = ref.current!
    const measure = () => setWidth(node.clientWidth || 128)
    measure(); const observer = new ResizeObserver(measure); observer.observe(node)
    return () => observer.disconnect()
  }, [])
  return <div className="slides-thumb-screen" ref={ref} style={{ aspectRatio: `${frame.w}/${frame.h}` }}><iframe title={`Preview: ${frame.title}`} src={src} loading="lazy" sandbox="allow-scripts" tabIndex={-1}
    style={{ width: frame.w, height: frame.h, transform: `scale(${width / frame.w})` }} /></div>
}

export function SlidesPane({ artifactId, manifest: manifestPath, artifactUrl, onTitle, onClose, webPaneId, token = '' }: {
  webPaneId?: string; token?: string; artifactId: string; manifest: string; artifactUrl?: string; onTitle?: (title: string) => void; onClose?: () => void
}) {
  const [result, setResult] = useState(EMPTY), [snapshot, setSnapshot] = useState<CanvasSnapshot | null>(null)
  const [loaded, setLoaded] = useState(false), [revisions, setRevisions] = useState<Record<string, number>>({})
  const [choice, setChoice] = useState(''), [grid, setGrid] = useState(false), [notes, setNotes] = useState(false), [commentMode, setCommentMode] = useState(false)
  const [menu, setMenu] = useState<'theme' | 'export' | null>(null), [themes, setThemes] = useState<string[]>([]), [brand, setBrand] = useState('')
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [presenting, setPresenting] = useState(false)
  const [spotlight, setSpotlight] = useState<CanvasSpotlightRequest | null>(null), [selected, setSelected] = useState<CanvasLabelRef | null>(null)
  const pane = useRef<HTMLDivElement>(null), stage = useRef<HTMLDivElement>(null), screen = useRef<HTMLDivElement>(null)
  const hitSequence = useRef(0), readOnly = !!snapshot
  const themeKey = `commando:slides-theme:${artifactId}:${manifestPath}`
  const [themeChoice, setThemeChoice] = useState(() => { try { return localStorage.getItem(themeKey) ?? '' } catch { return '' } })
  const theme = themeChoice || result.deck?.theme || 'ink'
  const resourceUrl = (path: string) => artifactUrl ? new URL(path, artifactUrl).toString() : path
  const baseUrl = resourceUrl(snapshot ? `/redline/canvas-snapshots/${artifactId}/${snapshot.id}/` : `/redline/artifacts/${artifactId}/`)
  const apiUrl = `/api/redline/artifacts/${artifactId}`
  const questionsPage = canvasQuestionsPage(resourceUrl(`/redline/artifacts/${artifactId}/`), manifestPath)
  const { frames, annotations } = result.manifest
  const index = Math.max(0, frames.findIndex((frame) => frame.id === choice)), frame = frames[index]
  const current = useMemo(() => frame ? [frame] : [], [frame])
  const comments = useCanvasComments(webPaneId, token, frames, result.manifest.sections, webPaneId ? questionsPage : undefined)
  const layout = useCanvasLayout(artifactId, manifestPath, token, setResult, { baseUrl, readOnly, frames, onTitle, setLoaded, setRevisions, onReset: () => { setSelected(null); setSpotlight(null) } })
  const themeParams = useMemo(() => ({ theme }), [theme])
  const { reports, register, hitTest, forwardPending, syncInteraction } = useCanvasFrameBridge(current, baseUrl, revisions, readOnly ? undefined : comments.relay, undefined, themeParams)
  useEffect(() => { forwardPending(readOnly ? { notes: [], knownUpTo: 0, dropped: 0 } : comments.snapshot) }, [readOnly, comments.snapshot, forwardPending, revisions, current, theme])
  useEffect(() => {
    const abort = new AbortController()
    void canvasRequest(`${apiUrl}/deck-themes?${new URLSearchParams({ deck: manifestPath })}`, token, { signal: abort.signal }, 'Could not load themes')
      .then((response) => response.json()).then((data: { themes: string[] }) => setThemes(data.themes)).catch((reason: Error) => { if (!abort.signal.aborted) setError(reason.message) })
    return () => abort.abort()
  }, [apiUrl, manifestPath, token, result.deck?.theme, revisions])
  const go = (next: number) => { ++hitSequence.current; comments.close(); setChoice(frames[Math.max(0, Math.min(frames.length - 1, next))]?.id ?? ''); setSelected(null); setSpotlight(null) }
  const pick = (id: string) => { go(frames.findIndex((f) => f.id === id)); setGrid(false) }
  const [viewport, setViewport] = useState({ w: 0, h: 0 })
  useLayoutEffect(() => {
    const node = stage.current
    if (!node) return
    const measure = () => setViewport({ w: node.clientWidth, h: node.clientHeight })
    measure(); const observer = new ResizeObserver(measure); observer.observe(node)
    return () => observer.disconnect()
  }, [grid, presenting])
  const scale = frame ? Math.max(0.01, Math.min((viewport.w - (presenting ? 0 : 112)) / frame.w, (viewport.h - (presenting ? 0 : 28)) / frame.h)) : 1
  const camera = { scale, x: (viewport.w - (frame?.w ?? 0) * scale) / 2 - (frame?.x ?? 0) * scale, y: (viewport.h - (frame?.h ?? 0) * scale) / 2 }
  useEffect(() => {
    const changed = () => setPresenting(document.fullscreenElement === pane.current)
    document.addEventListener('fullscreenchange', changed)
    return () => document.removeEventListener('fullscreenchange', changed)
  }, [])
  useEffect(() => {
    const node = pane.current
    if (!node) return
    const keydown = (event: KeyboardEvent) => {
      if ((event.target as HTMLElement).closest('input, textarea, select, [contenteditable="true"], .canvas-composer, [class*="tile-review-"]')) return
      if (event.key === 'Escape') { ++hitSequence.current; setCommentMode(false); setMenu(null); comments.close(); return }
      const next = ['ArrowRight', 'PageDown'].includes(event.key) || (presenting && event.key === ' ') ? index + 1 : ['ArrowLeft', 'PageUp'].includes(event.key) ? index - 1 : event.key === 'Home' ? 0 : event.key === 'End' ? frames.length - 1 : null
      if (next === null) return
      event.preventDefault(); go(next)
    }
    node.addEventListener('keydown', keydown)
    return () => node.removeEventListener('keydown', keydown)
  })
  useEffect(() => {
    if (!spotlight?.frame || frame?.id !== spotlight.frame) return
    const labels = labelsForFrame(reports, frame.id)
    const i = labels.findIndex((label) => label.rect.w > 0 && label.rect.h > 0 && (spotlight.labelId ? label.id === spotlight.labelId : label.name === spotlight.label))
    if (i >= 0) setSelected({ frameId: frame.id, key: labelKey(labels[i], i) })
  }, [spotlight, frame, reports])
  const review = useSlidesReview(webPaneId, token, questionsPage, annotations, comments, (selector) => {
    const note = annotations.find((note) => selector === `[data-canvas-note="${note.id}"]`)
    const pending = comments.queued.find((note) => note.selector === selector)
    const id = note?.target?.frame ?? pending?.canvas?.frameId
    if (id) pick(id)
    if (pending) comments.open(`pending:${pending.id}`)
  })
  const pins = readOnly ? [] : canvasPins(comments.draft, comments.queued, comments.threads).filter((pin) => pin.canvas.frameId === frame?.id)
  const activePin = pins.find((pin) => pin.id === comments.active), activePoint = activePin ? canvasPinPoint(activePin, current, camera) : null
  const activeNote = comments.queued.find((note) => `pending:${note.id}` === comments.active), activeThread = comments.threads.find((thread) => thread.id === comments.active)
  const dropComment = async (event: React.MouseEvent) => {
    if (!frame || readOnly || !commentMode || !webPaneId || comments.busy || presenting || (event.target as HTMLElement).closest('button, .canvas-composer, .canvas-spotlight')) return
    const rect = screen.current!.getBoundingClientRect(), point = { x: (event.clientX - rect.left) / scale, y: (event.clientY - rect.top) / scale }
    if (point.x < 0 || point.y < 0 || point.x > frame.w || point.y > frame.h) return
    const sequence = ++hitSequence.current, hit = await hitTest(frame.id, point)
    if (hit && sequence === hitSequence.current) comments.openDraft({ canvas: canvasNoteContext(frame, [], point, hit.label, hit.labelId), hit, pageUrl: new URL(canvasFrameUrl(baseUrl, frame, revisions[frame.id], { theme }), window.location.href).href })
  }
  const selectSnapshot = (next: CanvasSnapshot | null) => { ++hitSequence.current; comments.close(); setCommentMode(false); setMenu(null); setResult(EMPTY); setSnapshot(next) }
  const download = async (format: 'pdf' | 'pptx' | 'png' | 'html') => {
    if (busy || !frame) return
    setBusy(true); setError('')
    try {
      const response = await canvasRequest(`${apiUrl}/deck-export`, token,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ deck: manifestPath, format, theme, ...(format === 'png' ? { slide: frame.id } : {}) }) }, 'Slide export failed')
      const url = URL.createObjectURL(await response.blob()), link = document.createElement('a')
      const slug = result.manifest.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'slides'
      link.href = url; link.download = response.headers.get('Content-Disposition')?.match(/filename="([^"]+)"/)?.[1] ?? `${slug}${format === 'png' ? `-${frame.id}` : ''}.${format}`; link.click()
      setTimeout(() => URL.revokeObjectURL(url), 1000); setMenu(null)
    } catch (reason) { setError((reason as Error).message) } finally { setBusy(false) }
  }
  const thumbUrl = (f: CanvasFrame, previewTheme = theme) => `${baseUrl}${encodeCanvasPath(f.src)}?${new URLSearchParams({ thumb: '', theme: previewTheme, 'canvas-reload': String(revisions[f.id] ?? 0) })}#${f.slide}`
  const thumbnails = <div className={grid ? 'slides-grid' : 'slides-filmstrip'} aria-label={grid ? 'Slide grid' : 'Filmstrip'}>{frames.map((f, i) => {
    const count = readOnly ? 0 : comments.threads.filter((thread) => thread.frameId === f.id && thread.status === 'open').length
    const asks = annotations.some((note) => {
      const question = canvasQuestion(note)
      return note.target?.frame === f.id && note.answer === undefined && question && !pendingForQuestion(question, comments.snapshot.notes, questionsPage) && !sentForQuestion(question, comments.questionSent, questionsPage)
    })
    return <button type="button" key={f.id} className={`slides-thumb${frame?.id === f.id ? ' is-current' : ''}`} aria-label={`Slide ${i + 1}: ${f.title}`} aria-pressed={frame?.id === f.id} onClick={() => pick(f.id)}>
      <Thumbnail frame={f} src={thumbUrl(f)} /><span className="slides-thumb-number">{i + 1}</span>{grid && <span className="slides-thumb-title">{f.title}</span>}
      {(count > 0 || asks) && <span className="slides-thumb-badge">{count > 0 ? `💬 ${count}` : ''}{asks ? ' ?' : ''}</span>}
    </button>
  })}</div>
  return <div className={`slides-pane canvas-pane${presenting ? ' is-presenting' : ''}`} ref={pane} tabIndex={0} aria-label="Slides">
    <div className="slides-toolbar canvas-toolbar" role="toolbar" aria-label="Slides controls">
      <strong className="slides-title" title={result.manifest.title}>{result.manifest.title || 'Slides'}</strong><output aria-label="Slide counter">{frame ? index + 1 : 0} / {frames.length}</output>
      <div className="slides-view-switch"><button type="button" aria-label="Slides view" aria-pressed={!grid} onClick={() => setGrid(false)}><Presentation size={14} /><span>Slides</span></button><button type="button" aria-label="Grid view" aria-pressed={grid} onClick={() => setGrid(true)}><Grid2X2 size={14} /><span>Grid</span></button></div>
      <button type="button" aria-label="Theme" aria-expanded={menu === 'theme'} onClick={() => { setError(''); setMenu(menu === 'theme' ? null : 'theme') }}><Palette size={14} /><span>{theme}</span></button>
      <button type="button" aria-label="Notes" aria-pressed={notes} onClick={() => setNotes(!notes)}><NotebookText size={14} /><span>Notes</span></button>
      <button type="button" aria-label="Comment tool" aria-pressed={commentMode} disabled={readOnly || !webPaneId || comments.busy} onClick={() => { ++hitSequence.current; setCommentMode(!commentMode) }}><MessageCircle size={14} /></button>
      <CanvasHistory apiUrl={`${apiUrl}/canvas/snapshots`} token={token} selected={snapshot} disabled={comments.busy} onSelect={selectSnapshot} />
      <button type="button" aria-label="Present" disabled={!frame} onClick={() => { setGrid(false); setMenu(null); comments.close(); setCommentMode(false); if (!pane.current?.requestFullscreen) { setError('Fullscreen is unavailable in this browser'); return } void pane.current.requestFullscreen().then(() => pane.current?.focus()).catch(() => setError('Fullscreen is unavailable in this browser')) }}><Play size={14} /><span>Present</span></button>
      <button type="button" aria-label="Export" disabled={readOnly} aria-expanded={menu === 'export'} onClick={() => { setError(''); setMenu(menu === 'export' ? null : 'export') }}><Download size={14} /><span>Export</span></button>
      {onClose && <button type="button" aria-label="Close slides tab" onClick={onClose}>×</button>}
    </div>
    {snapshot && <div className="canvas-snapshot-banner">Viewing snapshot from {canvasSnapshotTime(snapshot.createdAt)} — <button type="button" onClick={() => selectSnapshot(null)}>Back to live</button>{snapshot.partial && ' · Partial snapshot'}</div>}
    {loaded && result.errors.length > 0 && <div className="canvas-errors" role="alert">{result.errors.join(' · ')}</div>}
    {loaded && !!result.warnings?.length && <details className="slides-warnings"><summary>Deck warnings ({result.warnings.length})</summary>{result.warnings.map((warning, i) => <div key={i}>{warning}</div>)}</details>}
    {comments.error && <div className="canvas-errors" role="alert">{comments.error}</div>}{layout.error && <div role="alert">{layout.error}</div>}
    {menu && <div className="slides-menu canvas-menu-items" role="menu" aria-label={menu === 'theme' ? 'Deck theme' : 'Export deck'}>
      {menu === 'theme' ? <><div className="slides-theme-options">{[...new Set([result.deck?.theme ?? 'ink', ...themes])].map((name) => <button type="button" role="menuitemradio" aria-label={`${name}${name === result.deck?.theme ? ' (default)' : ''}`} aria-checked={theme === name} key={name} onClick={() => { setThemeChoice(name); try { localStorage.setItem(themeKey, name) } catch { /* private mode */ } setMenu(null) }}>{frame && <Thumbnail frame={frame} src={thumbUrl(frame, name)} />}{name}{name === result.deck?.theme ? ' (default)' : ''}</button>)}</div>
        {!readOnly && <form onSubmit={(event) => { event.preventDefault(); if (!brand.trim() || !review.queue || !frame) return; setBusy(true); void review.queue.add({ selector: 'html', tag: 'section', rect: { x: 0, y: 0, width: 0, height: 0 }, comment: `Make a brand theme for this deck from: ${brand.trim()}`, pageUrl: questionsPage, canvas: canvasNoteContext(frame, [], { x: 0, y: 0 }) }).then(() => { setBrand(''); setMenu(null) }).catch((reason: Error) => setError(reason.message)).finally(() => setBusy(false)) }}>
          <label>Ask agent for a brand theme…<input aria-label="Brand source" placeholder="Website, tokens or brand brief" value={brand} onChange={(event) => setBrand(event.target.value)} /></label><button type="submit" disabled={busy || !webPaneId || !brand.trim()}>Queue request</button></form>}</>
        : <>{(['pdf', 'pptx', 'png', 'html'] as const).map((format) => <button type="button" role="menuitem" disabled={busy} key={format} onClick={() => void download(format)}>{format === 'png' ? 'PNG · current slide' : format === 'html' ? 'Single HTML file' : format.toUpperCase()}</button>)}{busy && <span role="status">Exporting…</span>}</>}
      {error && <span role="alert">{error}</span>}
    </div>}
    {error && !menu && <div className="canvas-errors" role="alert">{error}</div>}
    {grid ? thumbnails : <>
      <div className={`slides-stage${commentMode ? ' is-commenting' : ''}`} ref={stage}>
        {frame && <div className="slides-screen" ref={screen} style={{ width: frame.w * scale, height: frame.h * scale }} onClick={(event) => { pane.current?.focus(); void dropComment(event) }}>
          <iframe key={`${baseUrl}/${frame.id}`} ref={(node) => register(frame.id, node)} title={frame.title} sandbox="allow-scripts" src={canvasFrameUrl(baseUrl, frame, revisions[frame.id], { theme })} onLoad={syncInteraction}
            style={{ width: frame.w, height: frame.h, transform: `scale(${scale})` }} />
        </div>}
        <button type="button" className="slides-nav is-prev" aria-label="Previous slide" disabled={index === 0} onClick={() => go(index - 1)}><ChevronLeft size={20} /></button>
        <button type="button" className="slides-nav is-next" aria-label="Next slide" disabled={index >= frames.length - 1} onClick={() => go(index + 1)}><ChevronRight size={20} /></button>
        {!presenting && <><CanvasHighlights frames={current} reports={reports} camera={camera} selected={selected} hovered={null} />
          <CanvasPins pins={pins} frames={current} camera={camera} active={comments.active} onOpen={(id) => { if (!comments.busy) comments.open(id) }} />
          {activePin && activePoint && <CanvasComposer key={activePin.id} point={activePoint} label={activePin.canvas.label || activeThread?.selector || activeNote?.selector || comments.draft?.hit.selector || 'Unlabelled'}
            text={activeNote?.comment ?? activeThread?.messages[0]?.text ?? comments.draft?.comment} sent={activePin.state === 'sent' || activePin.state === 'resolved'} queued={activePin.state === 'queued'} busy={comments.busy} thread={activeThread}
            onReply={(text) => activeThread ? comments.reply(activeThread.id, text) : Promise.resolve(undefined)} onStatus={(status) => { if (activeThread) void comments.status(activeThread.id, status) }}
            onComment={comments.updateDraftComment} onQueue={(text) => { void comments.queueDraft(text, false) }} onSend={(text) => { if (activeNote) void comments.sendThis(activeNote); else void comments.queueDraft(text, true) }} onCancel={() => { ++hitSequence.current; comments.close() }} />}

        </>}
      </div>
      <div className="slides-details">{annotations.filter((note) => note.target?.frame === frame?.id).map((note) => {
        const question = canvasQuestion(note)
        if (!question) return null
        const delivered = sentForQuestion(question, comments.questionSent, questionsPage)
        return <div className="slides-question" data-canvas-note={note.id} key={note.id}><strong>? Agent asks</strong><span>{note.text}</span>
          <CanvasQuestionControls question={question} recorded={note.answer} pending={readOnly ? undefined : pendingForQuestion(question, comments.snapshot.notes, questionsPage)} sent={readOnly || delivered?.response.answer === note.answer ? undefined : delivered} disabled={readOnly || !webPaneId || comments.busy} onQueue={comments.answer} onRemove={comments.remove} /></div>
      })}{notes && <div className="slides-notes"><b>Notes</b><span>{result.deck?.slides.find((slide) => slide.id === frame?.id)?.notes || 'No speaker notes.'}</span></div>}</div>
      {thumbnails}
    </>}
    {!readOnly && !presenting && <CanvasSpotlightToast webPaneId={webPaneId} token={token} onShow={(request) => { if (request.frame && frames.some((f) => f.id === request.frame)) { pick(request.frame); setSpotlight(request) } }} />}
    {webPaneId && review.queue && !readOnly && !presenting && <TileReviewLayer webPaneId={webPaneId} pageUrl={questionsPage} reviewMode={false} active={false} containerRef={pane} inputRef={stage} pendingQueue={review.queue} surface={review.surface} />}
  </div>
}
