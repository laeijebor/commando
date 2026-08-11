import { useEffect, useRef, useState } from 'react'
import { MAX_PENDING_NOTES, type WebPane, type WebPanePendingNote, type WebPanePendingSnapshot } from '../shared/protocol'
import type { TileInspectRect, TileInspectResult, TileInspectSuccess } from '../shared/tile-inspect'
import {
  attachTileWheelCapture,
  cdpModifiers,
  isCopyShortcut,
  shouldCaptureKey,
  tileKeyMessages,
  tileMouseMessage,
} from './chromiumTileInput'
import { loadPendingMirror, savePendingMirror } from './pendingMirror'
import { getNativeWindowBridge, hasNativeClipboardHandler } from './nativeWindowBridge'
import { createInspectThrottle } from './tileReview'
import type { PendingNoteDraft, PendingSendTarget } from './webPanesApi'

const VIEWPORT_THROTTLE_MS = 200
const MOUSEMOVE_THROTTLE_MS = 16
const FIRST_FRAME_TIMEOUT_MS = 12_000
const INSPECT_HINT_MS = 2_000
const REVIEW_CARD_WIDTH = 240
const REVIEW_CARD_HEIGHT = 132
const REVIEW_CARD_GAP = 8

type StreamState = 'connecting' | 'streaming' | 'closed' | 'error'

type TileSocketMessage = {
  type?: string
  data?: string
  message?: string
  id?: string
  ok?: boolean
  error?: string
  selector?: string
  tag?: string
  rect?: TileInspectRect
  text?: string
  snippet?: string
  notes?: unknown
  revision?: number
  dropped?: number
  knownUpTo?: number
}

/**
 * The daemon-side pending queue for one tile. Every mutation returns the new
 * authoritative queue, which the tile renders as pills.
 */
export type PendingQueueApi = {
  list: () => Promise<WebPanePendingSnapshot>
  add: (note: PendingNoteDraft) => Promise<WebPanePendingSnapshot>
  update: (
    noteId: number,
    expectedRevision: number,
    change: { answer?: string; note?: string },
  ) => Promise<WebPanePendingSnapshot>
  upload: (noteId: number, expectedRevision: number, file: File) => Promise<WebPanePendingSnapshot>
  removeAttachment: (
    noteId: number,
    expectedRevision: number,
    attachmentId: string,
  ) => Promise<WebPanePendingSnapshot>
  attachmentUrl: (attachmentId: string) => string
  remove: (noteId: number) => Promise<WebPanePendingSnapshot>
  send: (targets?: readonly number[] | readonly PendingSendTarget[]) => Promise<WebPanePendingSnapshot>
  dismissDropped: () => Promise<WebPanePendingSnapshot>
}

const EMPTY_SNAPSHOT: WebPanePendingSnapshot = {
  notes: [],
  knownUpTo: Number.POSITIVE_INFINITY,
  dropped: 0,
}

type PendingDraft = {
  answer: string
  note: string
  baseAnswer: string
  baseNote: string
  baseRevision: number
  dirty: boolean
  conflict: boolean
}

type DraftReconcile = {
  reset?: ReadonlySet<number>
  rebase?: ReadonlySet<number>
}

type PendingEditor =
  | { kind: 'choice'; options: string[]; multiple: boolean }
  | { kind: 'approve'; options: string[] }
  | { kind: 'rating'; max: number }
  | { kind: 'text' }

function responseData(note: WebPanePendingNote): Record<string, unknown> {
  const data = note.response?.data
  return typeof data === 'object' && data !== null && !Array.isArray(data)
    ? data as Record<string, unknown>
    : {}
}

function editorFor(note: WebPanePendingNote): PendingEditor {
  const data = responseData(note)
  if (Array.isArray(data.options) && data.options.every((option) => typeof option === 'string')) {
    return { kind: 'choice', options: data.options, multiple: data.multiple === true }
  }
  if (typeof data.verdict === 'string') {
    return { kind: 'approve', options: ['approve', 'reject', 'needs-changes'] }
  }
  if (typeof data.max === 'number' && Number.isInteger(data.max) && data.max >= 2) {
    return { kind: 'rating', max: Math.min(10, data.max) }
  }
  return { kind: 'text' }
}

function draftValues(note: WebPanePendingNote): { answer: string; note: string } {
  if (!note.response) return { answer: note.comment, note: '' }
  const data = responseData(note)
  const editor = editorFor(note)
  let answer = note.response.answer
  if (editor.kind === 'choice') {
    const choice = data.choice
    if (Array.isArray(choice)) answer = choice.map(String).join(', ')
    else if (typeof choice === 'string') answer = choice
  } else if (editor.kind === 'approve' && typeof data.verdict === 'string') {
    answer = data.verdict
  } else if (editor.kind === 'rating') {
    const rating = typeof data.rating === 'number' ? data.rating : Number.parseInt(answer, 10)
    if (Number.isFinite(rating)) answer = `${rating}/${editor.max}`
  }
  const legacyNote = typeof data.comment === 'string' ? data.comment : ''
  return { answer, note: note.response.note ?? legacyNote }
}

function draftFor(note: WebPanePendingNote): PendingDraft {
  const values = draftValues(note)
  return {
    ...values,
    baseAnswer: values.answer,
    baseNote: values.note,
    baseRevision: note.revision ?? 1,
    dirty: false,
    conflict: false,
  }
}

function itemLabel(note: WebPanePendingNote): string {
  return note.response ? note.response.question : note.selector
}

function itemType(note: WebPanePendingNote): string {
  return note.response ? 'Response' : 'Annotation'
}

/** Narrows a socket frame already known to be an `inspect_result`. */
function toInspectResult(message: TileSocketMessage): TileInspectResult {
  if (message.ok !== true || !message.selector || !message.tag || !message.rect) {
    return { ok: false, error: message.error ?? 'Inspect failed' }
  }
  return {
    ok: true,
    selector: message.selector,
    tag: message.tag,
    rect: message.rect,
    ...(message.text !== undefined ? { text: message.text } : {}),
    ...(message.snippet !== undefined ? { snippet: message.snippet } : {}),
  }
}

/**
 * Places the comment card just below the inspected element, then clamps it
 * inside the tile so a hit near an edge stays fully readable.
 */
function cardPosition(rect: TileInspectRect, container: DOMRect | null): { x: number; y: number } {
  const width = container?.width ?? REVIEW_CARD_WIDTH
  const height = container?.height ?? REVIEW_CARD_HEIGHT
  const below = rect.y + rect.height + REVIEW_CARD_GAP
  const y = below + REVIEW_CARD_HEIGHT <= height
    ? below
    : Math.max(REVIEW_CARD_GAP, rect.y - REVIEW_CARD_GAP - REVIEW_CARD_HEIGHT)
  return {
    x: Math.max(
      REVIEW_CARD_GAP,
      Math.min(rect.x, Math.max(REVIEW_CARD_GAP, width - REVIEW_CARD_WIDTH - REVIEW_CARD_GAP)),
    ),
    y: Math.max(REVIEW_CARD_GAP, Math.min(y, Math.max(REVIEW_CARD_GAP, height - REVIEW_CARD_GAP))),
  }
}

/**
 * The chromium-engine tile body: renders the daemon's CDP screencast onto a
 * canvas and relays input back over `/ws/web-tiles/:id`. Ordinary cockpit
 * tiles pause while hidden; detached AppKit windows opt into a persistent stream.
 */
export function ChromiumTileCard({
  webPane,
  wsToken,
  reloadKey,
  reviewMode,
  pendingQueue,
  connected = true,
  keepStreamingWhenHidden = false,
}: {
  webPane: WebPane
  wsToken: string
  reloadKey: number
  /** Review mode swaps input relay for element inspect + note queueing. */
  reviewMode: boolean
  pendingQueue: PendingQueueApi
  /** Main daemon connection state; a recovered daemon needs a fresh tile socket. */
  connected?: boolean
  /** Detached AppKit windows remain visible while another application is active. */
  keepStreamingWhenHidden?: boolean
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const socketRef = useRef<WebSocket | null>(null)
  const [state, setState] = useState<StreamState>('connecting')
  const [detail, setDetail] = useState('')
  const [connectEpoch, setConnectEpoch] = useState(0)
  const lastReloadKey = useRef(reloadKey)

  const [highlight, setHighlight] = useState<TileInspectRect | null>(null)
  const [card, setCard] = useState<{ inspect: TileInspectSuccess; x: number; y: number } | null>(null)
  const [comment, setComment] = useState('')
  const [queued, setQueued] = useState<WebPanePendingNote[]>([])
  const [dropped, setDropped] = useState(0)
  const [hydrated, setHydrated] = useState(false)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [drafts, setDrafts] = useState<Record<number, PendingDraft>>({})
  const [busyIds, setBusyIds] = useState<ReadonlySet<number>>(() => new Set())
  const busyIdsRef = useRef<ReadonlySet<number>>(new Set())
  const [sendingAll, setSendingAll] = useState(false)
  const sendingAllRef = useRef(false)
  const [queueError, setQueueError] = useState('')
  const [preview, setPreview] = useState<{ id: string; name: string } | null>(null)
  const [hint, setHint] = useState<{ x: number; y: number } | null>(null)
  const nextInspectId = useRef(0)
  const nextSelectionId = useRef(0)
  const pendingSelectionId = useRef('')
  const activePointer = useRef<{
    id: number
    button: 'none' | 'left' | 'middle' | 'right'
    x: number
    y: number
  } | null>(null)
  const nativeWindowBridge = useRef(
    hasNativeClipboardHandler() ? getNativeWindowBridge() : null,
  ).current
  const lastHoverId = useRef('')
  const lastClickId = useRef('')
  const lastClickPoint = useRef({ x: 0, y: 0 })
  const reviewModeRef = useRef(reviewMode)
  reviewModeRef.current = reviewMode
  const pendingQueueRef = useRef(pendingQueue)
  pendingQueueRef.current = pendingQueue
  const queuedRef = useRef(queued)
  queuedRef.current = queued
  const draftsRef = useRef(drafts)
  draftsRef.current = drafts
  const latestSnapshotRevisionRef = useRef<number | undefined>(undefined)
  const attachmentMutationIdsRef = useRef(new Set<number>())
  /** Set once the daemon has pushed a queue over the socket for this tile. */
  const pushedRef = useRef(false)

  const applySnapshot = (snapshot: WebPanePendingSnapshot, reconcile: DraftReconcile = {}): boolean => {
    const latestRevision = latestSnapshotRevisionRef.current
    if (
      snapshot.revision !== undefined &&
      latestRevision !== undefined &&
      snapshot.revision < latestRevision
    ) return false
    if (snapshot.revision !== undefined) latestSnapshotRevisionRef.current = snapshot.revision

    const currentDrafts = draftsRef.current
    const nextDrafts: Record<number, PendingDraft> = {}
    for (const note of snapshot.notes) {
      const current = currentDrafts[note.id]
      if (!current || reconcile.reset?.has(note.id)) {
        nextDrafts[note.id] = draftFor(note)
        continue
      }
      const serverDraft = draftFor(note)
      if (reconcile.rebase?.has(note.id)) {
        nextDrafts[note.id] = current.dirty
          ? {
              ...current,
              baseAnswer: serverDraft.baseAnswer,
              baseNote: serverDraft.baseNote,
              baseRevision: serverDraft.baseRevision,
              dirty: current.answer !== serverDraft.baseAnswer || current.note !== serverDraft.baseNote,
              conflict: current.conflict,
            }
          : serverDraft
        continue
      }
      if (current.dirty) {
        nextDrafts[note.id] = {
          ...current,
          conflict: current.conflict || (
            note.revision !== undefined && note.revision !== current.baseRevision
          ),
        }
      } else {
        nextDrafts[note.id] = serverDraft
      }
    }
    draftsRef.current = nextDrafts
    queuedRef.current = snapshot.notes
    setDrafts(nextDrafts)
    setQueued(snapshot.notes)
    setDropped(snapshot.dropped)
    if (snapshot.notes.length === 0) setDrawerOpen(false)
    const attachmentIds = new Set(snapshot.notes.flatMap((note) => (
      note.attachments ?? []
    ).map((attachment) => attachment.id)))
    setPreview((current) => current && attachmentIds.has(current.id) ? current : null)
    setSelectedId((current) => (
      current !== null && snapshot.notes.some((note) => note.id === current)
        ? current
        : snapshot.notes[0]?.id ?? null
    ))
    return true
  }
  // The socket handler is built once per connection but must always call the
  // current setters, so it goes through a ref.
  const applySnapshotRef = useRef(applySnapshot)
  applySnapshotRef.current = applySnapshot

  // Pills are daemon state: hydrate on mount so notes queued while this tile
  // was unmounted (another session focused, page reloaded) come back.
  useEffect(() => {
    let cancelled = false
    const hydrate = async () => {
      let snapshot: WebPanePendingSnapshot
      try {
        snapshot = await pendingQueueRef.current.list()
        // Belt and braces: restore only notes the daemon has no record of
        // ever issuing. Anything it sent, dropped, or removed stays at or
        // below the watermark forever, so sent notes cannot resurrect —
        // an id above it means the journal itself was lost.
        const unknown = loadPendingMirror(webPane.id)
          .filter((note) => note.id > snapshot.knownUpTo)
        for (const note of unknown) {
          const { id: _id, ...draft } = note
          snapshot = await pendingQueueRef.current.add(draft)
        }
      } catch {
        // The daemon will still push `pending` over the tile socket.
        snapshot = EMPTY_SNAPSHOT
      }
      // A `pending` push that landed while this request was in flight is
      // strictly fresher than its result — never clobber it.
      if (cancelled || pushedRef.current) return
      applySnapshotRef.current(snapshot)
      setHydrated(true)
    }
    void hydrate()
    return () => {
      cancelled = true
    }
  }, [webPane.id])

  useEffect(() => {
    if (!hydrated) return
    savePendingMirror(webPane.id, queued)
  }, [hydrated, queued, webPane.id])

  // Reload button: reload the page inside the live stream, or reconnect a
  // dead one.
  useEffect(() => {
    if (reloadKey === lastReloadKey.current) return
    lastReloadKey.current = reloadKey
    const socket = socketRef.current
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'reload' }))
    } else {
      setConnectEpoch((current) => current + 1)
    }
  }, [reloadKey])

  useEffect(() => {
    if (!connected) {
      setState('closed')
      return
    }

    let disposed = false
    let socket: WebSocket | null = null
    let viewportTimer: number | undefined
    let observer: ResizeObserver | undefined
    let stallTimer: number | undefined
    let stalled = false
    let firstFrameDrawn = false

    const disarmStallWatchdog = () => {
      if (stallTimer !== undefined) {
        window.clearTimeout(stallTimer)
        stallTimer = undefined
      }
    }

    const armStallWatchdog = () => {
      if (firstFrameDrawn) return
      disarmStallWatchdog()
      stallTimer = window.setTimeout(() => {
        stallTimer = undefined
        if (disposed) return
        stalled = true
        setState('error')
        setDetail('No frames from the chromium stream. Retry to reconnect.')
        socket?.close()
      }, FIRST_FRAME_TIMEOUT_MS)
    }

    const sendViewport = (targetSocket = socket) => {
      const container = containerRef.current
      if (!container || !targetSocket || targetSocket.readyState !== WebSocket.OPEN) return
      const rect = container.getBoundingClientRect()
      if (rect.width < 1 || rect.height < 1) return
      targetSocket.send(JSON.stringify({
        type: 'viewport',
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        deviceScaleFactor: Math.min(4, Math.max(1, window.devicePixelRatio || 1)),
      }))
    }

    const connect = () => {
      if (disposed || (!keepStreamingWhenHidden && document.hidden)) return
      setState('connecting')
      setDetail('')
      stalled = false
      firstFrameDrawn = false
      const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
      const tokenQuery = wsToken ? `?token=${encodeURIComponent(wsToken)}` : ''
      const connectedSocket = new WebSocket(
        `${wsProtocol}//${window.location.host}/ws/web-tiles/${webPane.id}${tokenQuery}`,
      )
      socket = connectedSocket
      socketRef.current = connectedSocket
      connectedSocket.addEventListener('open', () => {
        sendViewport(connectedSocket)
      })
      connectedSocket.addEventListener('message', (event) => {
        if (socketRef.current !== connectedSocket) return
        if (typeof event.data !== 'string') return
        let message: TileSocketMessage
        try {
          message = JSON.parse(event.data) as TileSocketMessage
        } catch {
          return
        }
        if (message.type === 'frame' && typeof message.data === 'string') {
          drawFrame(message.data, connectedSocket)
          return
        }
        if (message.type === 'inspect_result' && typeof message.id === 'string') {
          routeInspectResult(message.id, toInspectResult(message))
          return
        }
        if (message.type === 'selection_result' && typeof message.id === 'string') {
          routeSelectionResult(message)
          return
        }
        if (message.type === 'pending') {
          // The daemon's pending queue is authoritative — replace, never merge.
          if (Array.isArray(message.notes)) {
            pushedRef.current = true
            const snapshot = {
              ...(typeof message.revision === 'number' ? { revision: message.revision } : {}),
              notes: message.notes as WebPanePendingNote[],
              knownUpTo: typeof message.knownUpTo === 'number' ? message.knownUpTo : 0,
              dropped: typeof message.dropped === 'number' ? message.dropped : 0,
            }
            const attachmentMutations = attachmentMutationIdsRef.current
            applySnapshotRef.current(
              snapshot,
              attachmentMutations.size > 0 ? { rebase: new Set(attachmentMutations) } : undefined,
            )
            setHydrated(true)
          }
          return
        }
        if (message.type === 'ready') {
          // The engine target exists now — (re)assert the tile's viewport.
          sendViewport(connectedSocket)
          // Target creation has its own bounded CDP timeouts and can exceed
          // the frameless budget on a cold browser. Only time the stream once
          // the relay says setup completed.
          armStallWatchdog()
          return
        }
        if (message.type === 'engine_error') {
          disarmStallWatchdog()
          setState('error')
          setDetail(message.message ?? 'Chromium engine failed')
        }
      })
      connectedSocket.addEventListener('close', (event) => {
        if (socketRef.current !== connectedSocket) return
        socketRef.current = null
        pendingSelectionId.current = ''
        disarmStallWatchdog()
        if (disposed || (!keepStreamingWhenHidden && document.hidden)) return
        if (stalled) return // the watchdog already set the error state
        if (event.code === 4503) return // engine_error already set the state
        setState('closed')
      })
    }

    // Only refs and state setters here: the handler is created once per
    // connection but must always act on the current review state.
    const routeInspectResult = (id: string, result: TileInspectResult) => {
      if (!reviewModeRef.current) return
      if (id.startsWith('h-')) {
        if (id !== lastHoverId.current) return // a newer hover already won
        setHighlight(result.ok ? result.rect : null)
        return
      }
      if (id !== lastClickId.current) return
      if (!result.ok) {
        setCard(null)
        setHint(lastClickPoint.current)
        return
      }
      setHint(null)
      setComment('')
      setCard({
        inspect: result,
        ...cardPosition(result.rect, containerRef.current?.getBoundingClientRect() ?? null),
      })
    }

    const routeSelectionResult = (message: TileSocketMessage) => {
      if (message.id !== pendingSelectionId.current) return
      pendingSelectionId.current = ''
      if (message.ok !== true || typeof message.text !== 'string' || !message.text) return
      if (nativeWindowBridge?.writeClipboardText(message.text)) return
      void navigator.clipboard?.writeText(message.text).catch(() => undefined)
    }

    const drawFrame = (base64: string, sourceSocket: WebSocket) => {
      const image = new Image()
      image.onload = () => {
        if (disposed || stalled || socketRef.current !== sourceSocket) return
        const canvas = canvasRef.current
        if (!canvas) return
        if (canvas.width !== image.width || canvas.height !== image.height) {
          canvas.width = image.width
          canvas.height = image.height
        }
        canvas.getContext('2d')?.drawImage(image, 0, 0)
        firstFrameDrawn = true
        disarmStallWatchdog()
        setState((current) => (current === 'streaming' ? current : 'streaming'))
      }
      image.onerror = () => {
        if (disposed || stalled || socketRef.current !== sourceSocket) return
        stalled = true
        disarmStallWatchdog()
        setState('error')
        setDetail('Chromium sent an invalid stream frame. Retry to reconnect.')
        sourceSocket.close()
      }
      image.src = `data:image/png;base64,${base64}`
    }

    const onVisibility = () => {
      if (keepStreamingWhenHidden) return
      if (document.hidden) {
        disarmStallWatchdog()
        if (socketRef.current === socket) {
          socketRef.current = null
          pendingSelectionId.current = ''
        }
        socket?.close()
      } else if (!socketRef.current) {
        connect()
      }
    }

    connect()
    if (!keepStreamingWhenHidden) document.addEventListener('visibilitychange', onVisibility)
    if (containerRef.current && typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(() => {
        if (viewportTimer) return
        viewportTimer = window.setTimeout(() => {
          viewportTimer = undefined
          sendViewport()
        }, VIEWPORT_THROTTLE_MS)
      })
      observer.observe(containerRef.current)
    }

    return () => {
      disposed = true
      if (!keepStreamingWhenHidden) document.removeEventListener('visibilitychange', onVisibility)
      observer?.disconnect()
      if (viewportTimer) window.clearTimeout(viewportTimer)
      disarmStallWatchdog()
      socket?.close()
      if (socketRef.current === socket) {
        socketRef.current = null
        pendingSelectionId.current = ''
      }
    }
  }, [webPane.id, webPane.url, wsToken, connectEpoch, connected, keepStreamingWhenHidden])

  const send = (payload: unknown) => {
    const socket = socketRef.current
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'input', event: payload }))
    }
  }

  const sendInspect = (id: string, x: number, y: number, grade: 'hover' | 'click') => {
    const socket = socketRef.current
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'inspect', id, x, y, grade }))
    }
  }

  const requestSelectionCopy = () => {
    const socket = socketRef.current
    if (!socket || socket.readyState !== WebSocket.OPEN) return
    const id = `s-${nextSelectionId.current++}`
    pendingSelectionId.current = id
    socket.send(JSON.stringify({ type: 'selection', id }))
  }

  // Hover inspects are throttled so a sweep across the page costs a handful of
  // round trips, not one per mousemove.
  const hoverThrottle = useRef<ReturnType<typeof createInspectThrottle> | null>(null)
  useEffect(() => {
    if (!reviewMode) {
      // Leaving review mode drops the transient overlays; queued notes stay.
      setHighlight(null)
      setCard(null)
      setHint(null)
      return
    }
    const throttle = createInspectThrottle((x, y) => {
      const id = `h-${nextInspectId.current++}`
      lastHoverId.current = id
      sendInspect(id, x, y, 'hover')
    })
    hoverThrottle.current = throttle
    return () => {
      throttle.dispose()
      hoverThrottle.current = null
    }
  }, [reviewMode])

  useEffect(() => {
    if (!hint) return
    const timer = window.setTimeout(() => setHint(null), INSPECT_HINT_MS)
    return () => window.clearTimeout(timer)
  }, [hint])

  useEffect(() => {
    if (!preview) return
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setPreview(null)
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [preview])

  const reviewActive = reviewMode && state === 'streaming'

  // Every mutation returns the daemon's new authoritative queue; rendering
  // that (rather than patching local state) keeps all viewers consistent.
  const mutateQueue = async (mutate: () => Promise<WebPanePendingSnapshot>, failure: string) => {
    try {
      applySnapshot(await mutate())
      setQueueError('')
    } catch (error) {
      setQueueError(error instanceof Error ? error.message : failure)
    }
  }

  const changeDraft = (noteId: number, change: Partial<Pick<PendingDraft, 'answer' | 'note'>>) => {
    const serverNote = queuedRef.current.find((note) => note.id === noteId)
    if (!serverNote) return
    const current = draftsRef.current[noteId] ?? draftFor(serverNote)
    const nextDraft = { ...current, ...change }
    nextDraft.dirty = nextDraft.answer !== nextDraft.baseAnswer || nextDraft.note !== nextDraft.baseNote
    if (!nextDraft.dirty) nextDraft.conflict = false
    const nextDrafts = { ...draftsRef.current, [noteId]: nextDraft }
    draftsRef.current = nextDrafts
    setDrafts(nextDrafts)
    setQueueError('')
  }

  const resetDraft = (noteId: number) => {
    const serverNote = queuedRef.current.find((note) => note.id === noteId)
    if (!serverNote) return
    const nextDrafts = { ...draftsRef.current, [noteId]: draftFor(serverNote) }
    draftsRef.current = nextDrafts
    setDrafts(nextDrafts)
    setQueueError('')
  }

  const markBusy = (noteId: number, busy: boolean) => {
    const next = new Set(busyIdsRef.current)
    if (busy) next.add(noteId)
    else next.delete(noteId)
    busyIdsRef.current = next
    setBusyIds(next)
  }

  const saveDraft = async (noteId: number): Promise<boolean> => {
    const draft = draftsRef.current[noteId]
    const serverNote = queuedRef.current.find((note) => note.id === noteId)
    if (!draft || !serverNote || !draft.dirty) return Boolean(serverNote)
    if (draft.conflict) {
      setQueueError('This draft changed on the server. Reload it before saving or sending.')
      return false
    }
    try {
      const snapshot = await pendingQueueRef.current.update(
        noteId,
        draft.baseRevision,
        serverNote.response
          ? { answer: draft.answer, note: draft.note }
          : { answer: draft.answer },
      )
      const accepted = applySnapshot(snapshot, { reset: new Set([noteId]) })
      if (!accepted) {
        setQueueError('A newer queue snapshot arrived while saving. Reload the draft before sending.')
        return false
      }
      setQueueError('')
      return true
    } catch (error) {
      setQueueError(error instanceof Error ? error.message : 'Could not save changes')
      return false
    }
  }

  const saveOne = async (noteId: number) => {
    if (sendingAllRef.current) return
    markBusy(noteId, true)
    try {
      await saveDraft(noteId)
    } finally {
      markBusy(noteId, false)
    }
  }

  const sendOne = async (noteId: number) => {
    if (sendingAllRef.current) return
    markBusy(noteId, true)
    try {
      if (!(await saveDraft(noteId))) return
      const latest = queuedRef.current.find((note) => note.id === noteId)
      if (!latest) {
        setQueueError('This item changed before it could be sent. Reload the queue and try again.')
        return
      }
      applySnapshot(await pendingQueueRef.current.send([{
        id: latest.id,
        revision: latest.revision ?? 1,
      }]))
      setQueueError('')
    } catch (error) {
      setQueueError(error instanceof Error ? error.message : 'Could not send this item')
    } finally {
      markBusy(noteId, false)
    }
  }

  // Capture the visible ids first so an answer queued during the save pass is
  // not accidentally included in this explicit send.
  const sendAll = async () => {
    if (sendingAllRef.current || busyIdsRef.current.size > 0) return
    const visible = queuedRef.current.map((note) => ({ id: note.id, revision: note.revision ?? 1 }))
    const ids = visible.map((note) => note.id)
    if (ids.length === 0) return
    const expectedRevisions = new Map(visible.map((note) => [note.id, note.revision]))
    sendingAllRef.current = true
    setSendingAll(true)
    setQueueError('')
    try {
      for (const noteId of ids) {
        const draft = draftsRef.current[noteId]
        if (draft?.conflict) {
          setQueueError('Resolve or reload conflicted drafts before sending the queue.')
          return
        }
        if (draft?.dirty) {
          if (!(await saveDraft(noteId))) return
          const saved = queuedRef.current.find((note) => note.id === noteId)
          if (!saved) {
            setQueueError('The queue changed while saving. Nothing was sent.')
            return
          }
          expectedRevisions.set(noteId, saved.revision ?? 1)
        }
      }
      const targets: PendingSendTarget[] = []
      for (const noteId of ids) {
        const note = queuedRef.current.find((candidate) => candidate.id === noteId)
        const draft = draftsRef.current[noteId]
        if (
          !note ||
          draft?.conflict ||
          (note.revision ?? 1) !== expectedRevisions.get(noteId)
        ) {
          setQueueError('The queue changed while saving. Nothing was sent.')
          return
        }
        targets.push({ id: note.id, revision: note.revision ?? 1 })
      }
      applySnapshot(await pendingQueueRef.current.send(targets))
    } catch (error) {
      setQueueError(error instanceof Error ? error.message : 'Could not send the queue')
    } finally {
      sendingAllRef.current = false
      setSendingAll(false)
    }
  }

  const removeOne = async (noteId: number) => {
    if (sendingAllRef.current) return
    markBusy(noteId, true)
    try {
      applySnapshot(await pendingQueueRef.current.remove(noteId))
      setQueueError('')
    } catch (error) {
      setQueueError(error instanceof Error ? error.message : 'Could not remove the item')
    } finally {
      markBusy(noteId, false)
    }
  }

  const uploadAttachment = async (noteId: number, file: File) => {
    if (sendingAllRef.current) return
    const acceptedTypes = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
    if (!acceptedTypes.has(file.type)) {
      setQueueError('Choose a PNG, JPEG, GIF, or WebP image.')
      return
    }
    const note = queuedRef.current.find((candidate) => candidate.id === noteId)
    if (!note) return
    if (draftsRef.current[noteId]?.conflict) {
      setQueueError('Reload the conflicted draft before changing its attachments.')
      return
    }
    markBusy(noteId, true)
    attachmentMutationIdsRef.current.add(noteId)
    try {
      applySnapshot(
        await pendingQueueRef.current.upload(noteId, note.revision ?? 1, file),
        { rebase: new Set([noteId]) },
      )
      setQueueError('')
    } catch (error) {
      setQueueError(error instanceof Error ? error.message : 'Could not upload the attachment')
    } finally {
      attachmentMutationIdsRef.current.delete(noteId)
      markBusy(noteId, false)
    }
  }

  const removeAttachment = async (noteId: number, attachmentId: string) => {
    if (sendingAllRef.current) return
    const note = queuedRef.current.find((candidate) => candidate.id === noteId)
    if (!note) return
    if (draftsRef.current[noteId]?.conflict) {
      setQueueError('Reload the conflicted draft before changing its attachments.')
      return
    }
    markBusy(noteId, true)
    attachmentMutationIdsRef.current.add(noteId)
    try {
      applySnapshot(
        await pendingQueueRef.current.removeAttachment(noteId, note.revision ?? 1, attachmentId),
        { rebase: new Set([noteId]) },
      )
      if (preview?.id === attachmentId) setPreview(null)
      setQueueError('')
    } catch (error) {
      setQueueError(error instanceof Error ? error.message : 'Could not remove the attachment')
    } finally {
      attachmentMutationIdsRef.current.delete(noteId)
      markBusy(noteId, false)
    }
  }

  const lastMove = useRef(0)

  // Wheel goes through a native non-passive listener (not React's onWheel) so
  // preventDefault actually stops the cockpit page scrolling behind the tile.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    return attachTileWheelCapture(canvas, send)
  }, [])

  // Pointer capture is normally enough to deliver an off-canvas release. If
  // WebKit refuses capture, the window fallback still clears Chromium's held button.
  useEffect(() => {
    const releaseOutsideCanvas = (event: PointerEvent) => {
      const active = activePointer.current
      const canvas = canvasRef.current
      if (!active || active.id !== event.pointerId || !canvas) return
      activePointer.current = null
      const rect = canvas.getBoundingClientRect()
      send({
        kind: 'mouse',
        type: 'mouseReleased',
        x: Math.max(0, Math.round(event.clientX - rect.left)),
        y: Math.max(0, Math.round(event.clientY - rect.top)),
        button: active.button,
        buttons: 0,
        clickCount: 1,
        modifiers: cdpModifiers(event),
      })
    }
    window.addEventListener('pointerup', releaseOutsideCanvas)
    window.addEventListener('pointercancel', releaseOutsideCanvas)
    return () => {
      window.removeEventListener('pointerup', releaseOutsideCanvas)
      window.removeEventListener('pointercancel', releaseOutsideCanvas)
    }
  }, [])

  const selected = selectedId === null ? undefined : queued.find((note) => note.id === selectedId)
  const selectedDraft = selected ? drafts[selected.id] ?? draftFor(selected) : undefined
  const selectedEditor = selected ? editorFor(selected) : undefined
  const selectedBusy = selected ? sendingAll || busyIds.has(selected.id) : false

  return (
    <div
      ref={containerRef}
      className={`chromium-tile${reviewMode ? ' is-reviewing' : ''}`}
      data-stream-state={state}
    >
      <canvas
        ref={canvasRef}
        className="chromium-tile-canvas"
        tabIndex={0}
        aria-label={`Chromium tile: ${webPane.url}`}
        onPointerDown={(event) => {
          if (reviewMode) {
            if (!reviewActive || event.button !== 0) return
            const x = Math.max(0, Math.round(event.nativeEvent.offsetX))
            const y = Math.max(0, Math.round(event.nativeEvent.offsetY))
            const id = `c-${nextInspectId.current++}`
            lastClickId.current = id
            lastClickPoint.current = { x, y }
            sendInspect(id, x, y, 'click')
            return
          }
          event.currentTarget.focus()
          const message = tileMouseMessage(event.nativeEvent)
          if (!message) return
          activePointer.current = {
            id: event.pointerId,
            button: message.button,
            x: message.x,
            y: message.y,
          }
          try {
            event.currentTarget.setPointerCapture(event.pointerId)
          } catch {
            // The release handler still clears the remote button state.
          }
          send(message)
        }}
        onPointerUp={(event) => {
          if (reviewMode) return
          const message = tileMouseMessage(event.nativeEvent)
          if (message) send(message)
          if (activePointer.current?.id === event.pointerId) activePointer.current = null
          if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId)
          }
        }}
        onPointerMove={(event) => {
          if (reviewMode) {
            if (!reviewActive) return
            hoverThrottle.current?.schedule(
              Math.max(0, Math.round(event.nativeEvent.offsetX)),
              Math.max(0, Math.round(event.nativeEvent.offsetY)),
            )
            return
          }
          const now = Date.now()
          if (now - lastMove.current < MOUSEMOVE_THROTTLE_MS) return
          lastMove.current = now
          const message = tileMouseMessage(event.nativeEvent)
          if (!message) return
          if (activePointer.current?.id === event.pointerId) {
            activePointer.current.x = message.x
            activePointer.current.y = message.y
          }
          send(message)
        }}
        onPointerCancel={(event) => {
          const active = activePointer.current
          if (!active || active.id !== event.pointerId) return
          activePointer.current = null
          send({
            kind: 'mouse',
            type: 'mouseReleased',
            x: active.x,
            y: active.y,
            button: active.button,
            buttons: 0,
            clickCount: 1,
            modifiers: cdpModifiers(event.nativeEvent),
          })
        }}
        onLostPointerCapture={(event) => {
          const active = activePointer.current
          if (!active || active.id !== event.pointerId) return
          activePointer.current = null
          send({
            kind: 'mouse',
            type: 'mouseReleased',
            x: active.x,
            y: active.y,
            button: active.button,
            buttons: 0,
            clickCount: 1,
            modifiers: 0,
          })
        }}
        onKeyDown={(event) => {
          if (reviewMode) return
          if (!shouldCaptureKey(event.key)) return
          event.preventDefault()
          event.stopPropagation()
          if (isCopyShortcut(event.nativeEvent) && (!nativeWindowBridge || event.metaKey)) {
            // Preserve the page's own copy handlers, then bridge its effective
            // text selection back to the host clipboard.
            for (const message of tileKeyMessages(event.nativeEvent)) send(message)
            requestSelectionCopy()
            return
          }
          for (const message of tileKeyMessages(event.nativeEvent)) {
            send(message)
          }
        }}
        onKeyUp={(event) => {
          if (reviewMode) return
          if (!shouldCaptureKey(event.key)) return
          event.preventDefault()
          event.stopPropagation()
          for (const message of tileKeyMessages(event.nativeEvent)) {
            send(message)
          }
        }}
      />
      {reviewActive && highlight && (
        <div
          className="tile-review-highlight"
          style={{
            left: highlight.x,
            top: highlight.y,
            width: highlight.width,
            height: highlight.height,
          }}
        />
      )}
      {reviewActive && hint && (
        <div className="tile-review-hint" style={{ left: hint.x, top: hint.y }} role="status">
          couldn't resolve an element here
        </div>
      )}
      {reviewActive && card && (
        <div className="tile-review-card" style={{ left: card.x, top: card.y }}>
          <span className="tile-review-card-target" title={card.inspect.selector}>
            {card.inspect.tag}
          </span>
          <textarea
            autoFocus
            value={comment}
            placeholder="What's wrong with this?"
            aria-label={`Note about ${card.inspect.selector}`}
            onChange={(event) => setComment(event.target.value)}
          />
          <div className="web-pane-confirm-actions">
            <button
              type="button"
              className="web-pane-action"
              disabled={comment.trim().length === 0}
              onClick={() => {
                const { selector, tag, text, rect } = card.inspect
                void mutateQueue(
                  () => pendingQueueRef.current.add({
                    selector,
                    tag,
                    ...(text !== undefined ? { text } : {}),
                    rect,
                    comment: comment.trim(),
                  }),
                  'Could not queue the note',
                )
                setCard(null)
                setComment('')
              }}
            >
              Queue note
            </button>
            <button
              type="button"
              className="web-pane-action is-ghost"
              onClick={() => {
                setCard(null)
                setComment('')
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      {(queued.length > 0 || dropped > 0) && (
        <>
          {!drawerOpen ? (
            <div className="tile-review-strip" data-testid="pending-queue-strip">
              {dropped > 0 && (
                <span className="tile-review-dropped" role="alert">
                  {`${dropped} older answer${dropped === 1 ? '' : 's'} dropped — the queue is full at ${MAX_PENDING_NOTES}. Send to make room.`}
                  <button
                    type="button"
                    className="tile-review-pill-remove"
                    aria-label="Dismiss the dropped-answer warning"
                    onClick={() => {
                      void mutateQueue(
                        () => pendingQueueRef.current.dismissDropped(),
                        'Could not dismiss the warning',
                      )
                    }}
                  >
                    ×
                  </button>
                </span>
              )}
              {queued.length > 0 && (
                <button
                  type="button"
                  className="tile-review-queue-toggle"
                  aria-expanded="false"
                  onClick={() => setDrawerOpen(true)}
                >
                  Review queue · {queued.length}
                </button>
              )}
              <div className="tile-review-strip-items" aria-hidden="true">
                {queued.slice(0, 3).map((note) => (
                  <span key={note.id} className={`tile-review-chip is-${note.response ? 'response' : 'annotation'}`}>
                    {note.response ? note.response.answer : note.comment}
                  </span>
                ))}
                {queued.length > 3 && <span className="tile-review-chip">+{queued.length - 3}</span>}
              </div>
              {queued.length > 0 && (
                <button
                  type="button"
                  className="tile-review-send-all"
                  disabled={sendingAll || busyIds.size > 0}
                  onClick={() => void sendAll()}
                >
                  {sendingAll ? 'Saving…' : 'Send all'}
                </button>
              )}
              {queueError && <span className="tile-review-error" role="alert">{queueError}</span>}
            </div>
          ) : (
            <section
              className="tile-review-drawer"
              role="dialog"
              aria-label="Pending review queue"
              data-testid="pending-queue-drawer"
            >
              <header className="tile-review-drawer-head">
                <div>
                  <span className="tile-review-eyebrow">Pending answers</span>
                  <strong>Review queue · {queued.length}</strong>
                </div>
                <div className="tile-review-drawer-actions">
                  <button
                    type="button"
                    className="tile-review-send-all"
                    disabled={sendingAll || busyIds.size > 0 || queued.length === 0}
                    onClick={() => void sendAll()}
                  >
                    {sendingAll ? 'Saving and sending…' : 'Send all'}
                  </button>
                  <button
                    type="button"
                    className="tile-review-collapse"
                    aria-label="Collapse review queue"
                    onClick={() => setDrawerOpen(false)}
                  >
                    ↓
                  </button>
                </div>
              </header>
              {dropped > 0 && (
                <div className="tile-review-drawer-warning" role="alert">
                  <span>{`${dropped} older answer${dropped === 1 ? '' : 's'} dropped because the queue reached ${MAX_PENDING_NOTES}.`}</span>
                  <button
                    type="button"
                    onClick={() => void mutateQueue(
                      () => pendingQueueRef.current.dismissDropped(),
                      'Could not dismiss the warning',
                    )}
                  >
                    Dismiss
                  </button>
                </div>
              )}
              <div className="tile-review-drawer-body">
                <nav className="tile-review-drawer-list" aria-label="Queued review items">
                  {queued.map((note) => {
                    const draft = drafts[note.id] ?? draftFor(note)
                    return (
                      <button
                        key={note.id}
                        type="button"
                        className={`tile-review-list-item${note.id === selectedId ? ' is-selected' : ''}`}
                        aria-current={note.id === selectedId ? 'true' : undefined}
                        onClick={() => setSelectedId(note.id)}
                      >
                        <span className="tile-review-list-meta">
                          <span className={`tile-review-type is-${note.response ? 'response' : 'annotation'}`}>
                            {itemType(note)}
                          </span>
                          {(note.attachments?.length ?? 0) > 0 && (
                            <span>{note.attachments?.length} image{note.attachments?.length === 1 ? '' : 's'}</span>
                          )}
                          {draft.dirty && <span className="tile-review-dirty">Edited</span>}
                        </span>
                        <strong>{itemLabel(note)}</strong>
                        <span className="tile-review-list-preview">{draft.answer}</span>
                      </button>
                    )
                  })}
                </nav>
                <div className="tile-review-drawer-detail">
                  {selected && selectedDraft && selectedEditor ? (
                    <>
                      <div className="tile-review-detail-heading">
                        <span className={`tile-review-type is-${selected.response ? 'response' : 'annotation'}`}>
                          {itemType(selected)}
                        </span>
                        <h3>{selected.response?.question ?? selected.selector}</h3>
                        {!selected.response && <code>{selected.tag}</code>}
                      </div>
                      {selectedDraft.conflict && (
                        <div className="tile-review-conflict" role="alert">
                          <span>This item changed after you started editing. Reload the server version before continuing.</span>
                          <button type="button" onClick={() => resetDraft(selected.id)}>Reload draft</button>
                        </div>
                      )}
                      <fieldset className="tile-review-editor" disabled={selectedBusy}>
                        <legend>{selected.response ? 'Answer' : 'Comment'}</legend>
                        {selectedEditor.kind === 'choice' && selectedEditor.multiple ? (
                          <div className="tile-review-checks">
                            {selectedEditor.options.map((option) => {
                              const values = selectedDraft.answer.split(', ').filter(Boolean)
                              return (
                                <label key={option}>
                                  <input
                                    type="checkbox"
                                    checked={values.includes(option)}
                                    onChange={(event) => {
                                      const next = new Set(values)
                                      if (event.target.checked) next.add(option)
                                      else next.delete(option)
                                      changeDraft(selected.id, {
                                        answer: selectedEditor.options.filter((value) => next.has(value)).join(', '),
                                      })
                                    }}
                                  />
                                  <span>{option}</span>
                                </label>
                              )
                            })}
                          </div>
                        ) : selectedEditor.kind === 'choice' ? (
                          <select
                            aria-label="Answer"
                            value={selectedDraft.answer}
                            onChange={(event) => changeDraft(selected.id, { answer: event.target.value })}
                          >
                            {selectedEditor.options.map((option) => <option key={option}>{option}</option>)}
                          </select>
                        ) : selectedEditor.kind === 'approve' ? (
                          <select
                            aria-label="Verdict"
                            value={selectedDraft.answer}
                            onChange={(event) => changeDraft(selected.id, { answer: event.target.value })}
                          >
                            {selectedEditor.options.map((option) => <option key={option}>{option}</option>)}
                          </select>
                        ) : selectedEditor.kind === 'rating' ? (
                          <div className="tile-review-rating" role="radiogroup" aria-label="Rating">
                            {Array.from({ length: selectedEditor.max }, (_, index) => index + 1).map((rating) => (
                              <label key={rating}>
                                <input
                                  type="radio"
                                  name={`pending-rating-${selected.id}`}
                                  value={rating}
                                  checked={selectedDraft.answer === `${rating}/${selectedEditor.max}`}
                                  onChange={() => changeDraft(selected.id, { answer: `${rating}/${selectedEditor.max}` })}
                                />
                                <span>{rating}</span>
                              </label>
                            ))}
                          </div>
                        ) : (
                          <textarea
                            aria-label={selected.response ? 'Answer' : 'Comment'}
                            value={selectedDraft.answer}
                            onChange={(event) => changeDraft(selected.id, { answer: event.target.value })}
                          />
                        )}
                        {selected.response && (
                          <label className="tile-review-note-field">
                            <span>Optional note</span>
                            <textarea
                              aria-label="Optional note"
                              value={selectedDraft.note}
                              onChange={(event) => changeDraft(selected.id, { note: event.target.value })}
                            />
                          </label>
                        )}
                      </fieldset>
                      <div className="tile-review-attachments">
                        <div className="tile-review-section-head">
                          <strong>Attachments</strong>
                          <label className={`tile-review-add-image${selectedBusy || selectedDraft.conflict ? ' is-disabled' : ''}`}>
                            <span>Add image</span>
                            <input
                              type="file"
                              accept="image/png,image/jpeg,image/gif,image/webp"
                              disabled={selectedBusy || selectedDraft.conflict}
                              aria-label="Add image attachment"
                              onChange={(event) => {
                                const file = event.target.files?.[0]
                                event.currentTarget.value = ''
                                if (file) void uploadAttachment(selected.id, file)
                              }}
                            />
                          </label>
                        </div>
                        {(selected.attachments?.length ?? 0) > 0 ? (
                          <div className="tile-review-attachment-grid">
                            {selected.attachments?.map((attachment) => (
                              <div key={attachment.id} className="tile-review-attachment">
                                <button
                                  type="button"
                                  className="tile-review-attachment-preview"
                                  onClick={() => setPreview({ id: attachment.id, name: attachment.name })}
                                  aria-label={`Preview ${attachment.name}`}
                                >
                                  <img src={pendingQueue.attachmentUrl(attachment.id)} alt="" />
                                  <span>{attachment.name}</span>
                                </button>
                                <button
                                  type="button"
                                  className="tile-review-attachment-remove"
                                  disabled={selectedBusy || selectedDraft.conflict}
                                  aria-label={`Remove ${attachment.name}`}
                                  onClick={() => void removeAttachment(selected.id, attachment.id)}
                                >
                                  ×
                                </button>
                              </div>
                            ))}
                          </div>
                        ) : <span className="tile-review-empty-attachments">No images attached</span>}
                      </div>
                      <footer className="tile-review-detail-actions">
                        <button
                          type="button"
                          className="tile-review-remove-item"
                          disabled={selectedBusy}
                          onClick={() => void removeOne(selected.id)}
                        >
                          Remove from queue
                        </button>
                        <span className="tile-review-detail-spacer" />
                        <button
                          type="button"
                          className="web-pane-action is-ghost"
                          disabled={!selectedDraft.dirty || selectedDraft.conflict || selectedBusy || !selectedDraft.answer}
                          onClick={() => void saveOne(selected.id)}
                        >
                          {selectedBusy ? 'Working…' : 'Save changes'}
                        </button>
                        <button
                          type="button"
                          className="web-pane-action"
                          disabled={selectedDraft.conflict || selectedBusy || !selectedDraft.answer}
                          onClick={() => void sendOne(selected.id)}
                        >
                          {selectedBusy ? 'Working…' : 'Send this'}
                        </button>
                      </footer>
                    </>
                  ) : (
                    <div className="tile-review-empty">Select an item to review.</div>
                  )}
                </div>
              </div>
              {queueError && <div className="tile-review-drawer-error" role="alert">{queueError}</div>}
            </section>
          )}
        </>
      )}
      {preview && (
        <div className="tile-review-preview-backdrop" onMouseDown={() => setPreview(null)}>
          <div
            className="tile-review-preview"
            role="dialog"
            aria-modal="true"
            aria-label={`Preview ${preview.name}`}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header>
              <strong>{preview.name}</strong>
              <button type="button" aria-label="Close attachment preview" autoFocus onClick={() => setPreview(null)}>×</button>
            </header>
            <img src={pendingQueue.attachmentUrl(preview.id)} alt={preview.name} />
          </div>
        </div>
      )}
      {state !== 'streaming' && (
        <div className={`web-pane-overlay${state === 'error' || state === 'closed' ? ' is-stalled' : ''}`}>
          {state === 'connecting' ? (
            <span className="web-pane-overlay-note">Starting chromium stream…</span>
          ) : state === 'error' ? (
            <>
              <span className="web-pane-overlay-note">{detail}</span>
              <div className="web-pane-confirm-actions">
                <button
                  type="button"
                  className="web-pane-action"
                  onClick={() => setConnectEpoch((current) => current + 1)}
                >
                  Retry
                </button>
              </div>
            </>
          ) : (
            <>
              <span className="web-pane-overlay-note">Stream closed.</span>
              <div className="web-pane-confirm-actions">
                <button
                  type="button"
                  className="web-pane-action"
                  onClick={() => setConnectEpoch((current) => current + 1)}
                >
                  Reconnect
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}
