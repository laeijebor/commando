import { CanvasHistory, canvasSnapshotTime } from './CanvasHistory'
import { CanvasFrameExport } from './CanvasFrameExport'
import type { CanvasSnapshot } from '../shared/canvas-snapshot'
import { CanvasSpotlightToast } from './CanvasSpotlightToast'
import type { CanvasSpotlightRequest } from '../shared/protocol'
import { CanvasComposer } from './CanvasComposer'
import { CanvasPins, canvasPins, canvasPinPoint } from './CanvasPins'
import { useCanvasComments } from './useCanvasComments'
import { canvasNoteContext } from './canvasComments'
import { useEffect, useEffectEvent, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { parseCanvasManifest, type CanvasAnnotation, type CanvasManifestResult } from '../shared/canvas-manifest'
import { canvasTransform, createCanvasCameraStore, fitCanvas, unionCanvasBounds, zoomAt, type CanvasBounds, type CanvasCamera, type CanvasCameraStore } from './canvasCamera'
import { CanvasOverview } from './CanvasOverview'
import { CanvasPageMenu, canvasPageStatus, type CanvasPageRow } from './CanvasPages'
import { CanvasHighlights } from './CanvasHighlights'
import { CanvasHotspots, CanvasTip } from './CanvasHotspotDots'
import { canvasConnector, canvasLabelBounds, flyToCanvasRect } from './canvasGeometry'
import { canvasFrameUrl, useCanvasFrameBridge } from './canvasFrameBridge'
import { useCanvasFlight } from './canvasFlight'
import { labelKey, labelsForFrame, type CanvasLabelRef } from './canvasLabels'
import './canvas-pane.css'
import { canvasGestureStep, canvasWheelRoute, useCanvasInteraction } from './canvasInteraction'
import { useCanvasLayout } from './useCanvasLayout'
import { useCanvasFrameDrag } from './useCanvasFrameDrag'
import { CanvasSectionStatus } from './CanvasSectionStatus'
import { CanvasQuestionControls } from './CanvasQuestionControls'
import { canvasNoteIdFromSelector, canvasQuestion, canvasQuestionsPage, openCanvasQuestions } from './canvasQuestions'
import { pendingForQuestion, sentForQuestion, TileReviewLayer, type TileReviewSurface } from './TileReviewLayer'
import { createWebPanesApi } from './webPanesApi'
import type { PendingQueueApi } from './pendingQueueApi'
import type { WebPanePendingSnapshot } from '../shared/protocol'
import type { RedlinePageQuestionSnapshot } from '../shared/redline-response'

const EMPTY = parseCanvasManifest({ title: '', frames: [] })
const KIND_LABELS = { development: 'Development', important: 'Important', design: 'Design', question: 'Question' }
const NOTE_COLOURS = { development: '#1f9d55', important: '#d97706', design: 'var(--accent)', question: '#0e7490' }
const frameBounds = (frame: CanvasBounds): CanvasBounds => ({ ...frame, y: frame.y - 36, h: frame.h + 36 })
/** Re-renders only its children when the camera moves. */
function CanvasCameraView({ store, children }: { store: CanvasCameraStore; children: (camera: CanvasCamera) => ReactNode }) {
  return children(useSyncExternalStore(store.subscribe, store.get))
}

export function CanvasPane({ artifactId, manifest: manifestPath, artifactUrl, onTitle, onClose, webPaneId, token = '' }: {
  webPaneId?: string; token?: string; artifactId: string; manifest: string; artifactUrl?: string; onTitle?: (title: string) => void; onClose?: () => void
}) {
  const [result, setResult] = useState<CanvasManifestResult>(EMPTY)
  const [snapshot, setSnapshot] = useState<CanvasSnapshot | null>(null)
  const liveView = useRef<{ result: CanvasManifestResult; camera: CanvasCamera } | null>(null)
  const restoringCamera = useRef(false)
  const readOnly = snapshot !== null
  const [loaded, setLoaded] = useState(false)
  const [cameraStore] = useState(() => createCanvasCameraStore({ x: 0, y: 0, scale: 1 }))
  const setCamera = cameraStore.set
  const [notesVisible, setNotesVisible] = useState(true)
  const [revisions, setRevisions] = useState<Record<string, number>>({})
  const [sizes, setSizes] = useState<Record<string, { w: number; h: number }>>({})
  const [commentMode, setCommentMode] = useState(false)
  const hitSequence = useRef(0)
  const [panning, setPanning] = useState(false)
  const [overviewOverride, setOverviewOverride] = useState<boolean | null>(null)
  const [wide, setWide] = useState<boolean | null>(null)
  const spotlightFallback = useRef<string | null>(null)
  const [spotlightTarget, setSpotlightTarget] = useState<CanvasSpotlightRequest | null>(null)
  const [spotlightFrame, setSpotlightFrame] = useState<string | null>(null)
  const [selected, setSelected] = useState<CanvasLabelRef | null>(null)
  const [hovered, setHovered] = useState<CanvasLabelRef | null>(null)
  const [exportMenu, setExportMenu] = useState<{ frame: typeof result.manifest.frames[number]; anchor: HTMLElement } | null>(null)
  const exportOverlay = useRef<HTMLDivElement>(null)
  const [badgeTip, setBadgeTip] = useState<{ text: string; x: number; y: number } | null>(null)
  useEffect(() => { setExportMenu(null); setBadgeTip(null) }, [panning, snapshot, result.manifest])
  useEffect(() => cameraStore.subscribe(() => { setExportMenu(null); setBadgeTip(null) }), [cameraStore])
  const pane = useRef<HTMLDivElement>(null)
  const viewport = useRef<HTMLDivElement>(null)
  const world = useRef<HTMLDivElement>(null)
  const drag = useRef<{ pointerId: number; x: number; y: number; camera: CanvasCamera } | null>(null)
  const initialFit = useRef(false)
  const manifestRef = useRef(result.manifest)
  useLayoutEffect(() => { manifestRef.current = result.manifest })
  // Only the open page's frames, sections and notes are drawn; the flat lists still span every page.
  const pageKey = `commando:canvas-page:${artifactId}:${manifestPath}`
  const [pageChoice, setPageChoice] = useState<string | null>(() => { try { return localStorage.getItem(pageKey) } catch { return null } })
  const pageCameras = useRef(new Map<string, CanvasCamera>())
  const { frames: allFrames, sections: allSections, annotations: allAnnotations, title, pages } = result.manifest
  const page = pages.length ? (pages.find((p) => p.id === pageChoice) ?? pages[0]).id : undefined
  const frames = useMemo(() => allFrames.filter((frame) => frame.page === page), [allFrames, page])
  const sections = useMemo(() => allSections.filter((section) => section.page === page), [allSections, page])
  const annotations = useMemo(() => allAnnotations.filter((note) => note.page === page), [allAnnotations, page])
  // Camera moves write the world transform directly instead of re-rendering.
  // `is-moving` gives the world its own compositor layer only while it moves,
  // so pans skip repainting and Chromium re-rasterises crisply once it settles.
  useLayoutEffect(() => {
    const node = world.current!
    let settle = 0
    node.style.transform = canvasTransform(cameraStore.get())
    const unsubscribe = cameraStore.subscribe(() => {
      node.style.transform = canvasTransform(cameraStore.get())
      node.classList.add('is-moving')
      window.clearTimeout(settle)
      settle = window.setTimeout(() => node.classList.remove('is-moving'), 200)
    })
    return () => { unsubscribe(); window.clearTimeout(settle) }
  }, [cameraStore])
  const resourceUrl = (path: string) => artifactUrl ? new URL(path, artifactUrl).toString() : path
  const baseUrl = resourceUrl(snapshot ? `/redline/canvas-snapshots/${artifactId}/${snapshot.id}/` : `/redline/artifacts/${artifactId}/`)
  // Same-origin like the rest of the app's API calls; the daemon answers no CORS preflight.
  const apiUrl = `/api/redline/artifacts/${artifactId}/canvas`
  const questionsPage = canvasQuestionsPage(resourceUrl(`/redline/artifacts/${artifactId}/`), manifestPath)

  const comments = useCanvasComments(webPaneId, token, result.manifest.frames, result.manifest.sections, webPaneId ? questionsPage : undefined)
  const layout = useCanvasLayout(artifactId, manifestPath, token, setResult, {
    baseUrl, readOnly, frames: result.manifest.frames, onTitle, setLoaded, setRevisions,
    onReset: () => {
      setSelected(null); setHovered(null); setSpotlightFrame(null); setSpotlightTarget(null); spotlightFallback.current = null; cancelFlight()
      initialFit.current = restoringCamera.current; restoringCamera.current = false
    },
  })
  const feedbackBusy = comments.busy || layout.busy
  const { flyTo, cancel: cancelFlight } = useCanvasFlight(cameraStore.get, setCamera, viewport)
  const interaction = useCanvasInteraction(result.manifest.frames, (frame) => {
    setSelected(null); setHovered(null); showPage(frame.page, frameBounds(frame))
  })
  const live = !readOnly && !commentMode && result.manifest.frames.some((f) => f.id === interaction.state.live && f.interactive) ? interaction.state.live : null
  const frameDrag = useCanvasFrameDrag(layout.preview, layout.move, cancelFlight)
  const { reports, hotspots, register, hitTest, forwardPending, syncInteraction } = useCanvasFrameBridge(frames, baseUrl, revisions, readOnly ? undefined : comments.relay, {
    live, onInput: (frameId, input) => {
      if (input.type === 'escape') { interaction.act({ type: 'escape' }); cancelFlight() }
      else if (input.type === 'goto') interaction.act({ type: 'goto', id: input.target })
      else {
        const frame = manifestRef.current.frames.find((f) => f.id === frameId)
        if (!frame) return
        cancelFlight(); initialFit.current = true
        const multiplier = input.deltaMode === 1 ? 16 : input.deltaMode === 2 ? frame.h : 1
        setCamera((current) => zoomAt(current, Math.exp(-input.deltaY * multiplier * 0.01), { x: current.x + (frame.x + input.x) * current.scale, y: current.y + (frame.y + input.y) * current.scale }))
      }
    },
  })
  useEffect(() => { forwardPending(readOnly ? { notes: [], knownUpTo: 0, dropped: 0 } : comments.snapshot) }, [readOnly, comments.snapshot, forwardPending, revisions, frames])
  const escape = useEffectEvent((event: KeyboardEvent) => {
    if (event.key !== 'Escape' || !(event.target instanceof Node) || !pane.current?.contains(event.target)) return
    ++hitSequence.current; setCommentMode(false); comments.close(); interaction.act({ type: 'escape' }); cancelFlight()
  })
  useEffect(() => {
    window.addEventListener('keydown', escape)
    return () => { ++hitSequence.current; window.removeEventListener('keydown', escape) }
  }, [])
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
  }, [result.manifest, page])

  /** Opens a page, restoring where you left it; a jump lands on `target` instead. */
  const showPage = (next: string | undefined, target?: CanvasBounds) => {
    if (next === undefined || next === page) {
      if (target) { initialFit.current = true; flyTo(target) }
      return
    }
    if (page !== undefined) pageCameras.current.set(page, cameraStore.get())
    cancelFlight(); setExportMenu(null); setBadgeTip(null); setSpotlightFrame(null)
    setPageChoice(next)
    try { localStorage.setItem(pageKey, next) } catch { /* private mode */ }
    const node = viewport.current, saved = pageCameras.current.get(next)
    if (target && node?.clientWidth && node.clientHeight) { initialFit.current = true; setCamera(flyToCanvasRect(target, { w: node.clientWidth, h: node.clientHeight })) }
    else if (saved) { initialFit.current = true; setCamera(saved) }
    else initialFit.current = false
  }
  const pickPage = (next: string) => {
    if (next === page) return
    ++hitSequence.current; comments.close(); setSelected(null); setHovered(null); interaction.act({ type: 'background' })
    showPage(next)
  }
  const framePage = (frameId: string) => allFrames.find((frame) => frame.id === frameId)?.page
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
      const frame = (event.target as HTMLElement).closest('.canvas-frame')
      const route = canvasWheelRoute(!!frame?.classList.contains('is-live'), node.classList.contains('is-commenting'), event.ctrlKey, event.metaKey)
      if (route === 'frame') return
      event.preventDefault()
      cancelFlight()
      initialFit.current = true
      const rect = node.getBoundingClientRect()
      const multiplier = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? node.clientHeight : 1
      setCamera((current) => route === 'zoom'
        ? zoomAt(current, Math.exp(-event.deltaY * multiplier * 0.01), { x: event.clientX - rect.left, y: event.clientY - rect.top })
        : { ...current, x: current.x - event.deltaX * multiplier, y: current.y - event.deltaY * multiplier })
    }
    // WKWebView delivers trackpad pinch as WebKit gesture events, not ctrl+wheel.
    let gestureScale = 1
    const gesture = (event: Event) => {
      event.preventDefault()
      const { scale, clientX, clientY } = event as Event & { scale?: number; clientX?: number; clientY?: number }
      if (event.type === 'gesturestart') { gestureScale = 1; cancelFlight(); initialFit.current = true; return }
      const step = canvasGestureStep(gestureScale, scale ?? NaN)
      if (step === null) return
      gestureScale = scale!
      const rect = node.getBoundingClientRect()
      const point = clientX === undefined || clientY === undefined ? { x: node.clientWidth / 2, y: node.clientHeight / 2 } : { x: clientX - rect.left, y: clientY - rect.top }
      setCamera((current) => zoomAt(current, step, point))
    }
    node.addEventListener('wheel', wheel, { passive: false })
    node.addEventListener('gesturestart', gesture)
    node.addEventListener('gesturechange', gesture)
    return () => {
      node.removeEventListener('wheel', wheel)
      node.removeEventListener('gesturestart', gesture)
      node.removeEventListener('gesturechange', gesture)
    }
  }, [])
  const zoom = (factor: number) => {
    cancelFlight()
    initialFit.current = true
    const node = viewport.current!
    setCamera((current) => zoomAt(current, factor, { x: node.clientWidth / 2, y: node.clientHeight / 2 }))
  }
  useEffect(() => {
    if (!spotlightTarget || !loaded) return
    const target = spotlightTarget.frame ? allFrames.find((frame) => frame.id === spotlightTarget.frame) : undefined
    if (target && target.page !== page) { showPage(target.page, frameBounds(target)); return }
    const candidates = frames.filter((frame) => !spotlightTarget.frame || frame.id === spotlightTarget.frame)
    for (const frame of candidates) {
      const labels = labelsForFrame(reports, frame.id)
      const index = labels.findIndex((label) => spotlightTarget.labelId ? label.id === spotlightTarget.labelId : label.name === spotlightTarget.label)
      if (index >= 0) {
        setSelected({ frameId: frame.id, key: labelKey(labels[index], index) }); setHovered(null); setSpotlightFrame(null)
        initialFit.current = true; flyTo(canvasLabelBounds(frame, labels[index].rect)); setSpotlightTarget(null)
        return
      }
    }
    if (spotlightTarget.frame && candidates[0] && spotlightFallback.current !== spotlightTarget.id) {
      spotlightFallback.current = spotlightTarget.id
      setSelected(null); setHovered(null); setSpotlightFrame(candidates[0].id)
      initialFit.current = true; flyTo(frameBounds(candidates[0]))
      if (!spotlightTarget.label && !spotlightTarget.labelId) setSpotlightTarget(null)
    }
  }, [spotlightTarget, loaded, reports, frames, allFrames, page, flyTo])
  const answerable = !readOnly && !!webPaneId
  const questions = useMemo(() => answerable ? openCanvasQuestions(allAnnotations) : [], [answerable, allAnnotations])
  const questionState = (note: CanvasAnnotation) => {
    const question = canvasQuestion(note)
    if (!question) return null
    const pending = pendingForQuestion(question, comments.snapshot.notes, questionsPage)
    const delivered = sentForQuestion(question, comments.questionSent, questionsPage)
    // Once the agent records the answer it sent, the note reads as answered.
    const sent = delivered?.response.answer === note.answer ? undefined : delivered
    return { question, pending, sent, state: pending ? 'queued' as const : sent ? 'sent' as const : note.answer !== undefined ? 'answered' as const : 'open' as const }
  }
  const questionRows = answerable ? allAnnotations.flatMap((note) => { const ask = questionState(note); return ask ? [{ note, state: ask.state }] : [] }) : []
  const openPins = readOnly ? [] : [...comments.threads.filter((thread) => thread.status === 'open').map((thread) => thread.frameId), ...comments.queued.flatMap((note) => note.canvas ? [note.canvas.frameId] : [])]
  const pageRows: CanvasPageRow[] = pages.map((p) => ({
    ...p, frames: allFrames.filter((frame) => frame.page === p.id).length, status: canvasPageStatus(allSections.filter((section) => section.page === p.id)),
    questions: questionRows.filter(({ note, state }) => state === 'open' && note.page === p.id).length,
    comments: openPins.filter((frameId) => framePage(frameId) === p.id).length,
  }))
  const reviewListeners = useRef({ pending: new Set<(snapshot: WebPanePendingSnapshot) => void>(), questions: new Set<(page: string, snapshot: RedlinePageQuestionSnapshot) => void>() })
  const reviewState = useRef({ questions, questionsPage, sent: comments.questionSent })
  useLayoutEffect(() => { reviewState.current = { questions, questionsPage, sent: comments.questionSent } })
  const questionSnapshot = (): RedlinePageQuestionSnapshot => ({ type: 'questions', version: 1, questions: reviewState.current.questions })
  useEffect(() => { for (const listener of reviewListeners.current.questions) listener(questionsPage, questionSnapshot()) }, [questions, questionsPage])
  useEffect(() => {
    // A fresh pane's empty first snapshot would only race the drawer's own load.
    if (!comments.snapshot.revision && !comments.snapshot.notes.length) return
    for (const listener of reviewListeners.current.pending) listener({ ...comments.snapshot, sent: comments.questionSent })
  }, [comments.snapshot, comments.questionSent])
  const reveal = useEffectEvent((selector: string) => {
    setSpotlightFrame(null); setSelected(null); setHovered(null); initialFit.current = true
    const note = allAnnotations.find((n) => n.id === canvasNoteIdFromSelector(selector))
    if (note) { setNotesVisible(true); showPage(note.page, noteBounds(note)); return }
    const pending = comments.queued.find((n) => n.selector === selector)
    const frame = pending?.canvas && allFrames.find((f) => f.id === pending.canvas!.frameId)
    if (!pending?.canvas || !frame) return
    showPage(frame.page, { x: frame.x + pending.canvas.point.x - 40, y: frame.y + pending.canvas.point.y - 40, w: 80, h: 80 })
    ++hitSequence.current; comments.open(`pending:${pending.id}`)
  })
  const reviewSurface = useMemo<TileReviewSurface>(() => ({
    inspect: () => {},
    resolveSelectors: (_items, receive) => receive([]),
    subscribePending: (listener) => { reviewListeners.current.pending.add(listener); return () => { reviewListeners.current.pending.delete(listener) } },
    subscribeQuestions: (listener) => {
      reviewListeners.current.questions.add(listener)
      listener(reviewState.current.questionsPage, questionSnapshot())
      return () => { reviewListeners.current.questions.delete(listener) }
    },
    revealSelector: (selector) => reveal(selector),
  }), [])
  const pendingQueue = useMemo<PendingQueueApi | null>(() => {
    if (!webPaneId) return null
    const api = createWebPanesApi(token)
    // The drawer's questions live on the manifest page, so it always sees that page's sent answers.
    const ours = (work: Promise<WebPanePendingSnapshot>) => work.then((snapshot) => ({ ...snapshot, sent: reviewState.current.sent }))
    return {
      list: () => api.pendingNotes(webPaneId, questionsPage),
      add: (note) => ours(api.addPendingNote(webPaneId, note)),
      addResponse: (pageUrl, response) => ours(api.addPendingResponse(webPaneId, pageUrl, response)),
      update: (noteId, revision, change) => ours(api.updatePendingNote(webPaneId, noteId, revision, change)),
      upload: (noteId, revision, file) => ours(api.uploadPendingAttachment(webPaneId, noteId, revision, file)),
      removeAttachment: (noteId, revision, attachmentId) => ours(api.removePendingAttachment(webPaneId, noteId, revision, attachmentId)),
      attachmentUrl: (attachmentId) => api.pendingAttachmentUrl(webPaneId, attachmentId),
      remove: (noteId) => ours(api.removePendingNote(webPaneId, noteId)),
      send: (targets, options) => ours(api.sendPendingNotes(webPaneId, targets, options)),
      dismissDropped: () => ours(api.dismissPendingDropped(webPaneId)),
    }
  }, [webPaneId, token, questionsPage])
  const pins = readOnly ? [] : canvasPins(comments.draft, comments.queued, comments.threads)
  const activePin = pins.find((pin) => pin.id === comments.active)
  const activeNote = comments.queued.find((note) => `pending:${note.id}` === comments.active)
  const activeThread = comments.threads.find((thread) => thread.id === comments.active)
  const dropComment = async (event: React.MouseEvent<HTMLDivElement>) => {
    if (readOnly || !commentMode || !webPaneId || feedbackBusy || (event.target as HTMLElement).closest('.canvas-spotlight, .canvas-composer, .canvas-pin, .canvas-note, .canvas-variant, .canvas-section-head')) return
    const rect = viewport.current!.getBoundingClientRect(), camera = cameraStore.get()
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

  const selectSnapshot = (next: CanvasSnapshot | null) => {
    if (feedbackBusy || layout.hasPreview() || next?.id === snapshot?.id) return
    if (next && !snapshot) liveView.current = { result, camera: cameraStore.get() }
    ++hitSequence.current; setCommentMode(false); comments.close(); interaction.act({ type: 'escape' }); cancelFlight()
    drag.current = null; frameDrag.reset(); setPanning(false)
    setSelected(null); setHovered(null)
    if (!next && liveView.current) {
      setResult(liveView.current.result); setCamera(liveView.current.camera); restoringCamera.current = true
    } else setResult(EMPTY)
    setLoaded(false); setSnapshot(next)
  }

  return <div className={`canvas-pane${readOnly ? ' is-snapshot' : ''}`} ref={pane}>
    <div className="canvas-toolbar" role="toolbar" aria-label="Canvas controls">
      <button type="button" aria-label="Toggle overview" aria-pressed={overviewVisible} onClick={() => { setExportMenu(null); setOverviewOverride(!overviewVisible); setHovered(null) }}>☰</button>
      {pages.length > 1 && !overviewVisible && <CanvasPageMenu pages={pageRows} active={page} onSelect={pickPage} overlay={exportOverlay.current} />}
      <button type="button" aria-label="Zoom out" onClick={() => zoom(0.8)}>−</button>
      <output className="canvas-zoom" aria-label="Zoom"><CanvasCameraView store={cameraStore}>{(camera) => `${Math.round(camera.scale * 100)}%`}</CanvasCameraView></output>
      <button type="button" aria-label="Zoom in" onClick={() => zoom(1.25)}>+</button>
      <button type="button" onClick={() => { initialFit.current = true; fit() }}>Fit</button>
      <button type="button" aria-label="Play" title="Play" aria-pressed={interaction.state.playing} disabled={readOnly || !allFrames.some((f) => f.focus === 1 || f.interactive)} onClick={() => { ++hitSequence.current; setCommentMode(false); comments.close(); interaction.act({ type: 'play' }) }}>▶</button>
      {interaction.state.playing && <button type="button" disabled={!interaction.state.history.length} onClick={() => interaction.act({ type: 'back' })}>Back</button>}
      <span className="canvas-toolbar-separator" />
      <button type="button" aria-label="Notes" title="Notes" aria-pressed={notesVisible} onClick={() => setNotesVisible((visible) => !visible)}>▤</button>
      <button type="button" aria-label="Comment tool" title="Comment tool" aria-pressed={commentMode} disabled={readOnly || !webPaneId || feedbackBusy} onClick={() => { ++hitSequence.current; setCommentMode(!commentMode) }}>💬</button>
      <CanvasHistory apiUrl={`${apiUrl}/snapshots`} token={token} selected={snapshot} disabled={feedbackBusy} onSelect={selectSnapshot} />
      <span className="canvas-toolbar-title" title={title}>{title || 'Canvas'}</span>
      {onClose && <button type="button" aria-label="Close canvas tab" onClick={onClose}>×</button>}
    </div>
    {snapshot && <div className="canvas-snapshot-banner" role="status">Viewing snapshot from {canvasSnapshotTime(snapshot.createdAt)} — <button type="button" onClick={() => selectSnapshot(null)}>Back to live</button>{snapshot.partial && <span> · Partial snapshot</span>}</div>}
    {loaded && result.errors.length > 0 && <div className="canvas-errors" role="alert"><strong>Canvas errors</strong><ul>{result.errors.map((error, i) => <li key={i}>{error}</li>)}</ul></div>}
    {comments.error && <div className="canvas-errors" role="alert">{comments.error}</div>}
    {layout.error && <div className="canvas-errors" role="alert">{layout.error}</div>}
    <div className="canvas-body">
      {overviewVisible && <CanvasOverview key={snapshot?.id ?? 'live'} hideThreads={readOnly} frames={frames} annotations={annotations} reports={reports} selected={selected} onHover={setHovered}
        threads={readOnly ? [] : comments.threads} queued={readOnly ? [] : comments.queued}
        pages={pageRows} page={page} onPage={pickPage} framePage={framePage}
        questions={questionRows} onThread={(thread) => {
          const frame = allFrames.find((f) => f.id === thread.frameId)
          if (!frame) return
          setSpotlightFrame(null); setSelected(null); setHovered(null)
          showPage(frame.page, { x: frame.x + thread.point.x - 40, y: frame.y + thread.point.y - 40, w: 80, h: 80 })
          ++hitSequence.current; comments.open(thread.id)
        }}
        onSelect={(instance) => { setSpotlightFrame(null); setSelected(instance); initialFit.current = true; flyTo(canvasLabelBounds(frames.find((frame) => frame.id === instance.frameId)!, instance.label.rect)) }}
        onFrame={(frame) => { setSpotlightFrame(null); setSelected(null); setHovered(null); initialFit.current = true; flyTo(frameBounds(frame)) }}
        onExport={(frame, anchor) => setExportMenu({ frame, anchor })}
        onNote={(note) => { setSpotlightFrame(null); setSelected(null); setHovered(null); setNotesVisible(true); showPage(note.page, noteBounds(note)) }} />}
      <div className={`canvas-viewport${panning ? ' is-panning' : ''}${commentMode ? ' is-commenting' : ''}`} ref={viewport}
        onClick={(event) => {
          if (!(event.target as HTMLElement).closest('.canvas-frame, .canvas-note, .canvas-variant, .canvas-section-head, .canvas-pin, .canvas-composer, .canvas-spotlight, .canvas-hotspot')) interaction.act({ type: 'background' })
          void dropComment(event)
        }}
        onPointerDown={(event) => {
          if (commentMode || (event.target as HTMLElement).closest('.canvas-spotlight, .canvas-composer, .canvas-pin, .canvas-hotspot') || event.button !== 0 || (event.target as HTMLElement).closest('.canvas-frame, .canvas-note, .canvas-variant, .canvas-section-head')) return
          cancelFlight()
          initialFit.current = true
          drag.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, camera: cameraStore.get() }
          event.currentTarget.setPointerCapture(event.pointerId)
          setPanning(true)
        }}
        onPointerMove={(event) => {
          const start = drag.current
          if (start && event.pointerId === start.pointerId) setCamera({ ...start.camera, x: start.camera.x + event.clientX - start.x, y: start.camera.y + event.clientY - start.y })
        }} onPointerUp={endPan} onPointerCancel={endPan} onLostPointerCapture={endPan}>
        <div ref={world} className={`canvas-world${notesVisible ? '' : ' hide-notes'}`}>
          {sectionBoxes.map(({ section, bounds }) => <div key={section.id} className="canvas-section" style={{ left: bounds.x, top: bounds.y, width: bounds.w, height: bounds.h }}>
            <div className="canvas-section-head" data-measure={`section:${section.id}`}><span className="canvas-chip">{section.ticket ? `[${section.ticket}] ` : ''}{section.title}</span>
              <CanvasSectionStatus section={section} disabled={readOnly || layout.busy || comments.busy || !webPaneId} onChange={(status) => {
                const frame = frames.find((f) => section.frames.includes(f.id))!
                void layout.status(section, status, () => comments.sectionStatus(section, status, new URL(canvasFrameUrl(baseUrl, frame, revisions[frame.id]), window.location.href).href))
              }} />
            </div>
          </div>)}
          {frames.map((frame) => <div key={frame.id} className={`canvas-frame${frame.focus ? ' is-focus' : ''}${live === frame.id ? ' is-live' : ''}${spotlightFrame === frame.id ? ' is-spotlight' : ''}`} style={{ left: frame.x, top: frame.y, width: frame.w, height: frame.h }}
            onDoubleClick={() => { if (!readOnly && !commentMode) interaction.act({ type: 'enter', id: frame.id }) }}>
            <div className="canvas-frame-label" onPointerDown={(event) => { if (!readOnly && !commentMode && !interaction.state.playing && !layout.busy) frameDrag.start(event, frame, cameraStore.get().scale) }} onPointerMove={frameDrag.move} onPointerUp={frameDrag.end} onPointerCancel={frameDrag.cancel} onLostPointerCapture={frameDrag.cancel}>
              {frame.platform && <i>[{frame.platform}]</i>}<b>{frame.title}</b>{frame.focus && <span className="canvas-badge focus">★ Focus {frame.focus}</span>}<span className={`canvas-badge ${frame.interactive ? 'live' : 'static'}${frame.interactiveNote ? ' has-note' : ''}`} aria-description={frame.interactiveNote}
                onPointerEnter={(event) => {
                  const badge = event.currentTarget.getBoundingClientRect(), rect = viewport.current!.getBoundingClientRect()
                  if (frame.interactiveNote) setBadgeTip({ text: frame.interactiveNote, x: badge.left + badge.width / 2 - rect.left, y: badge.top - rect.top })
                }} onPointerLeave={() => setBadgeTip(null)}>{frame.interactive ? '▶ Interactive' : 'Static'}{frame.interactiveNote && <span className="canvas-badge-info" aria-hidden="true">i</span>}</span>
              <button type="button" className="canvas-frame-export" aria-label={`Export ${frame.title}`} title={`Export ${frame.title}`} aria-haspopup="menu" aria-expanded={exportMenu?.frame.id === frame.id}
                onPointerDown={(event) => event.stopPropagation()} onDoubleClick={(event) => event.stopPropagation()}
                onClick={(event) => { event.stopPropagation(); setExportMenu(exportMenu?.anchor === event.currentTarget ? null : { frame, anchor: event.currentTarget }) }}>⤓</button>
              {live === frame.id && <span className="canvas-badge entered">Live — Esc to leave</span>}
            </div>
            <iframe ref={(node) => register(frame.id, node)} title={frame.title} sandbox="allow-scripts" loading="lazy" onLoad={syncInteraction} src={canvasFrameUrl(baseUrl, frame, revisions[frame.id])} />
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
          {annotations.map((note) => {
            const ask = answerable ? questionState(note) : null
            return <div key={note.id} className="canvas-note" data-canvas-note={note.id} data-measure={`note:${note.id}`} style={{ left: note.x, top: note.y, width: note.w ?? 300 }}>
              <span className="canvas-kind" style={{ background: NOTE_COLOURS[note.kind] }}>{KIND_LABELS[note.kind]}</span>
              {note.title && <strong className="canvas-note-title">{note.title}</strong>}{note.text && <div>{note.text}</div>}{note.items && <ul>{note.items.map((item, i) => <li key={i}>{item}</li>)}</ul>}
              {ask && <CanvasQuestionControls key={JSON.stringify([ask.question.queueKey, ask.question.question, ask.question.options ?? null, ask.question.multiple ?? null])} question={ask.question} recorded={note.answer} pending={ask.pending} sent={ask.sent}
                disabled={feedbackBusy} onQueue={comments.answer} onRemove={comments.remove} />}
            </div>
          })}
        </div>
        <CanvasCameraView store={cameraStore}>{(camera) => {
          const activePoint = activePin ? canvasPinPoint(activePin, frames, camera) : null
          return <>
        <CanvasHighlights frames={frames} reports={reports} camera={camera} selected={selected} hovered={hovered} />
        {!readOnly && !commentMode && notesVisible && <CanvasHotspots frames={frames} reports={hotspots} camera={camera} />}
        {badgeTip && <div className="canvas-overlay"><CanvasTip {...badgeTip} /></div>}
        <CanvasPins pins={pins} frames={frames} camera={camera} active={comments.active} onOpen={(id) => { if (!feedbackBusy) { ++hitSequence.current; comments.open(id) } }} />
        {activePin && activePoint && <CanvasComposer key={activePin.id} point={activePoint} label={activePin.canvas.label || activeThread?.selector || activeNote?.selector || comments.draft?.hit.selector || 'Unlabelled'}
          text={activeNote?.comment ?? activeThread?.messages[0]?.text ?? comments.draft?.comment} sent={activePin.state === 'sent' || activePin.state === 'resolved'} queued={activePin.state === 'queued'} busy={feedbackBusy}
          thread={activeThread} onReply={(text) => activeThread ? comments.reply(activeThread.id, text) : Promise.resolve(undefined)}
          onStatus={(status) => { if (activeThread) void comments.status(activeThread.id, status) }}
          onComment={comments.updateDraftComment}
          onQueue={(text) => { void comments.queueDraft(text, false) }} onSend={(text) => { if (activeNote) void comments.sendThis(activeNote); else void comments.queueDraft(text, true) }}
          onCancel={() => { ++hitSequence.current; comments.close() }} />}
          </>
        }}</CanvasCameraView>
        {!readOnly && <CanvasSpotlightToast webPaneId={webPaneId} token={token} onShow={setSpotlightTarget} />}
        <div className="canvas-hint" role="status" aria-label="Canvas hint">{interaction.state.hint || (commentMode ? 'Click a frame to comment · Esc to exit' : loaded ? readOnly ? 'Snapshot · Drag to pan · ⌘/Ctrl/pinch to zoom' : 'Drag to pan · Double-click to enter · ⌘/Ctrl/pinch to zoom' : 'Loading canvas…')}</div>
      </div>
    </div>
    {webPaneId && pendingQueue && !readOnly && <TileReviewLayer webPaneId={webPaneId} pageUrl={questionsPage} reviewMode={false} active={false}
      containerRef={pane} inputRef={viewport} pendingQueue={pendingQueue} surface={reviewSurface} />}
    <div ref={exportOverlay} className="canvas-overlay canvas-export-overlay">
      {exportMenu && exportOverlay.current && <CanvasFrameExport key={`${baseUrl}/${exportMenu.frame.id}/${exportMenu.frame.src}`} frame={exportMenu.frame} anchor={exportMenu.anchor} overlay={exportOverlay.current}
        baseUrl={baseUrl} apiUrl={`${apiUrl}/frames`} manifest={manifestPath} token={token} snapshot={readOnly} onClose={() => setExportMenu(null)} />}
    </div>
  </div>
}
