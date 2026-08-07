import { useEffect, useRef, useState } from 'react'
import type { WebPane, WebPaneFeedbackNote } from '../shared/protocol'
import { parseRedlinePageResponse } from '../shared/redline-response'
import type { TileInspectRect, TileInspectResult, TileInspectSuccess } from '../shared/tile-inspect'
import {
  shouldCaptureKey,
  tileKeyMessages,
  tileMouseMessage,
  tileWheelMessage,
} from './chromiumTileInput'
import {
  createInspectThrottle,
  queueNote,
  queuePageResponse,
  removeNote,
  removeSentNotes,
  toFeedbackNotes,
  type QueuedReviewNote,
} from './tileReview'

const VIEWPORT_THROTTLE_MS = 200
const MOUSEMOVE_THROTTLE_MS = 16
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
  response?: unknown
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
 * canvas and relays input back over `/ws/web-tiles/:id`. Pauses (closes the
 * stream) while the document is hidden so a background cockpit costs nothing.
 */
export function ChromiumTileCard({
  webPane,
  wsToken,
  reloadKey,
  reviewMode,
  onSubmitFeedback,
}: {
  webPane: WebPane
  wsToken: string
  reloadKey: number
  /** Review mode swaps input relay for element inspect + note queueing. */
  reviewMode: boolean
  onSubmitFeedback: (notes: WebPaneFeedbackNote[]) => Promise<void>
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
  const [queued, setQueued] = useState<QueuedReviewNote[]>([])
  const [sendState, setSendState] = useState<'idle' | 'sending' | { error: string }>('idle')
  const [hint, setHint] = useState<{ x: number; y: number } | null>(null)
  const nextInspectId = useRef(0)
  const nextNoteId = useRef(0)
  const lastHoverId = useRef('')
  const lastClickId = useRef('')
  const lastClickPoint = useRef({ x: 0, y: 0 })
  const reviewModeRef = useRef(reviewMode)
  reviewModeRef.current = reviewMode

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
    let disposed = false
    let socket: WebSocket | null = null
    let viewportTimer: number | undefined
    let observer: ResizeObserver | undefined

    const sendViewport = () => {
      const container = containerRef.current
      if (!container || !socket || socket.readyState !== WebSocket.OPEN) return
      const rect = container.getBoundingClientRect()
      if (rect.width < 1 || rect.height < 1) return
      socket.send(JSON.stringify({
        type: 'viewport',
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        deviceScaleFactor: Math.min(4, Math.max(1, window.devicePixelRatio || 1)),
      }))
    }

    const connect = () => {
      if (disposed || document.hidden) return
      setState('connecting')
      const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
      const tokenQuery = wsToken ? `?token=${encodeURIComponent(wsToken)}` : ''
      socket = new WebSocket(
        `${wsProtocol}//${window.location.host}/ws/web-tiles/${webPane.id}${tokenQuery}`,
      )
      socketRef.current = socket
      socket.addEventListener('open', () => {
        sendViewport()
      })
      socket.addEventListener('message', (event) => {
        if (typeof event.data !== 'string') return
        let message: TileSocketMessage
        try {
          message = JSON.parse(event.data) as TileSocketMessage
        } catch {
          return
        }
        if (message.type === 'frame' && typeof message.data === 'string') {
          drawFrame(message.data)
          return
        }
        if (message.type === 'inspect_result' && typeof message.id === 'string') {
          routeInspectResult(message.id, toInspectResult(message))
          return
        }
        if (message.type === 'page_response') {
          const response = parseRedlinePageResponse(message.response)
          if (response) {
            setQueued((current) => queuePageResponse(current, response, nextNoteId.current++))
          }
          return
        }
        if (message.type === 'ready') {
          // The engine target exists now — (re)assert the tile's viewport.
          sendViewport()
          return
        }
        if (message.type === 'engine_error') {
          setState('error')
          setDetail(message.message ?? 'Chromium engine failed')
        }
      })
      socket.addEventListener('close', (event) => {
        if (socketRef.current === socket) socketRef.current = null
        if (disposed || document.hidden) return
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

    const drawFrame = (base64: string) => {
      const image = new Image()
      image.onload = () => {
        const canvas = canvasRef.current
        if (!canvas) return
        if (canvas.width !== image.width || canvas.height !== image.height) {
          canvas.width = image.width
          canvas.height = image.height
        }
        canvas.getContext('2d')?.drawImage(image, 0, 0)
        setState((current) => (current === 'streaming' ? current : 'streaming'))
      }
      image.src = `data:image/png;base64,${base64}`
    }

    const onVisibility = () => {
      if (document.hidden) {
        socket?.close()
        socket = null
      } else if (!socketRef.current) {
        connect()
      }
    }

    connect()
    document.addEventListener('visibilitychange', onVisibility)
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
      document.removeEventListener('visibilitychange', onVisibility)
      observer?.disconnect()
      if (viewportTimer) window.clearTimeout(viewportTimer)
      socket?.close()
      if (socketRef.current === socket) socketRef.current = null
    }
  }, [webPane.id, webPane.url, wsToken, connectEpoch])

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

  const reviewActive = reviewMode && state === 'streaming'

  // A failed send leaves its message on screen until the next send; drop it as
  // soon as the queue changes so it cannot resurface against unrelated notes.
  const clearSendError = () =>
    setSendState((current) => (typeof current === 'object' ? 'idle' : current))

  const submitQueued = async () => {
    const batch = queued
    setSendState('sending')
    try {
      await onSubmitFeedback(toFeedbackNotes(batch, webPane.url, Date.now()))
      setQueued((current) => removeSentNotes(current, batch))
      setSendState('idle')
    } catch (error) {
      setSendState({ error: error instanceof Error ? error.message : 'Could not send notes' })
    }
  }

  const lastMove = useRef(0)

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
        onMouseDown={(event) => {
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
          if (message) send(message)
        }}
        onMouseUp={(event) => {
          if (reviewMode) return
          const message = tileMouseMessage(event.nativeEvent)
          if (message) send(message)
        }}
        onMouseMove={(event) => {
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
          if (message) send(message)
        }}
        onWheel={(event) => {
          send(tileWheelMessage(event.nativeEvent))
        }}
        onKeyDown={(event) => {
          if (reviewMode) return
          if (!shouldCaptureKey(event.key)) return
          event.preventDefault()
          event.stopPropagation()
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
                setQueued((current) =>
                  queueNote(current, card.inspect, comment.trim(), nextNoteId.current++),
                )
                clearSendError()
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
      {queued.length > 0 && (
        <div className="tile-review-pills">
          {queued.map((note) => (
            <span key={note.id} className="tile-review-pill" title={`${note.selector} — ${note.comment}`}>
              <strong>{note.tag}</strong>
              <span className="tile-review-pill-comment">{note.comment}</span>
              <button
                type="button"
                className="tile-review-pill-remove"
                aria-label={`Remove note about ${note.selector}`}
                onClick={() => {
                  setQueued((current) => removeNote(current, note.id))
                  clearSendError()
                }}
              >
                ×
              </button>
            </span>
          ))}
          <button
            type="button"
            className="web-pane-action"
            disabled={sendState === 'sending'}
            onClick={() => void submitQueued()}
          >
            {sendState === 'sending'
              ? 'Sending…'
              : `Send ${queued.length} note${queued.length === 1 ? '' : 's'}`}
          </button>
          {typeof sendState === 'object' && (
            <span className="tile-review-error" role="alert">{sendState.error}</span>
          )}
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
