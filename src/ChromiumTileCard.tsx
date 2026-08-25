import { useEffect, useRef, useState } from 'react'
import type { WebPane, WebPanePendingSnapshot } from '../shared/protocol'
import {
  parseTileSelectorAnchors,
  type TileInspectResult,
  type TileSelectorAnchor,
} from '../shared/tile-inspect'
import {
  attachTileWheelCapture,
  cdpModifiers,
  isCopyShortcut,
  shouldCaptureKey,
  tileKeyMessages,
  tileMouseMessage,
} from './chromiumTileInput'
import { getNativeWindowBridge, hasNativeClipboardHandler } from './nativeWindowBridge'
import type { PendingQueueApi } from './pendingQueueApi'
import { TileReviewLayer, type TileReviewSurface } from './TileReviewLayer'

export type { PendingQueueApi } from './pendingQueueApi'

const VIEWPORT_THROTTLE_MS = 200
const MOUSEMOVE_THROTTLE_MS = 16
const FIRST_FRAME_TIMEOUT_MS = 12_000

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
  rect?: { x: number; y: number; width: number; height: number }
  text?: string
  snippet?: string
  notes?: unknown
  revision?: number
  dropped?: number
  knownUpTo?: number
  anchors?: unknown
}

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
 * The chromium-engine tile body: renders the daemon's CDP screencast onto a
 * canvas and relays input back over `/ws/web-tiles/:id`.
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
  reviewMode: boolean
  pendingQueue: PendingQueueApi
  connected?: boolean
  keepStreamingWhenHidden?: boolean
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const socketRef = useRef<WebSocket | null>(null)
  const [state, setState] = useState<StreamState>('connecting')
  const [detail, setDetail] = useState('')
  const [connectEpoch, setConnectEpoch] = useState(0)
  const lastReloadKey = useRef(reloadKey)
  const nextInspectId = useRef(0)
  const nextSelectorResolveId = useRef(0)
  const nextSelectionId = useRef(0)
  const pendingSelectionId = useRef('')
  const inspectRequests = useRef(new Map<string, (result: TileInspectResult) => void>())
  const selectorRequests = useRef(new Map<string, {
    receive: (anchors: readonly TileSelectorAnchor[]) => void
    reject?: (error: Error) => void
  }>())
  const pendingListeners = useRef(new Set<(snapshot: WebPanePendingSnapshot) => void>())
  const activePointer = useRef<{
    id: number
    button: 'none' | 'left' | 'middle' | 'right'
    x: number
    y: number
  } | null>(null)
  const nativeWindowBridge = useRef(
    hasNativeClipboardHandler() ? getNativeWindowBridge() : null,
  ).current

  const reviewSurfaceRef = useRef<TileReviewSurface | null>(null)
  if (reviewSurfaceRef.current === null) {
    reviewSurfaceRef.current = {
      inspect: (x, y, grade, receive) => {
        const socket = socketRef.current
        if (!socket || socket.readyState !== WebSocket.OPEN) {
          receive({ ok: false, error: 'Review surface is unavailable' })
          return
        }
        const id = `${grade === 'hover' ? 'h' : 'c'}-${nextInspectId.current++}`
        inspectRequests.current.set(id, receive)
        socket.send(JSON.stringify({ type: 'inspect', id, x, y, grade }))
      },
      resolveSelectors: (items, receive, reject) => {
        const socket = socketRef.current
        if (!socket || socket.readyState !== WebSocket.OPEN) {
          reject?.(new Error('Review surface is unavailable'))
          return
        }
        const id = `r-${nextSelectorResolveId.current++}`
        selectorRequests.current.set(id, { receive, reject })
        socket.send(JSON.stringify({ type: 'resolve_selectors', id, items }))
      },
      subscribePending: (listener) => {
        pendingListeners.current.add(listener)
        return () => pendingListeners.current.delete(listener)
      },
    }
  }
  const reviewSurface = reviewSurfaceRef.current

  const cancelReviewRequests = () => {
    inspectRequests.current.clear()
    for (const request of selectorRequests.current.values()) {
      request.reject?.(new Error('Review surface disconnected'))
    }
    selectorRequests.current.clear()
  }

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
      connectedSocket.addEventListener('open', () => sendViewport(connectedSocket))
      connectedSocket.addEventListener('message', (event) => {
        if (socketRef.current !== connectedSocket || typeof event.data !== 'string') return
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
          const resolve = inspectRequests.current.get(message.id)
          if (!resolve) return
          inspectRequests.current.delete(message.id)
          resolve(toInspectResult(message))
          return
        }
        if (message.type === 'resolve_selectors_result' && typeof message.id === 'string') {
          const request = selectorRequests.current.get(message.id)
          if (!request) return
          selectorRequests.current.delete(message.id)
          if (message.ok !== true) {
            request.reject?.(new Error(message.error ?? 'Could not resolve selectors'))
            return
          }
          const anchors = parseTileSelectorAnchors(message.anchors)
          if (!anchors) {
            request.reject?.(new Error('Invalid selector anchors'))
            return
          }
          request.receive(anchors)
          return
        }
        if (message.type === 'selection_result' && typeof message.id === 'string') {
          routeSelectionResult(message)
          return
        }
        if (message.type === 'pending' && Array.isArray(message.notes)) {
          const snapshot: WebPanePendingSnapshot = {
            ...(typeof message.revision === 'number' ? { revision: message.revision } : {}),
            notes: message.notes,
            knownUpTo: typeof message.knownUpTo === 'number' ? message.knownUpTo : 0,
            dropped: typeof message.dropped === 'number' ? message.dropped : 0,
          }
          for (const listener of pendingListeners.current) listener(snapshot)
          return
        }
        if (message.type === 'ready') {
          sendViewport(connectedSocket)
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
        cancelReviewRequests()
        disarmStallWatchdog()
        if (disposed || (!keepStreamingWhenHidden && document.hidden)) return
        if (stalled || event.code === 4503) return
        setState('closed')
      })
    }

    const onVisibility = () => {
      if (keepStreamingWhenHidden) return
      if (document.hidden) {
        disarmStallWatchdog()
        if (socketRef.current === socket) {
          socketRef.current = null
          pendingSelectionId.current = ''
          cancelReviewRequests()
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
        cancelReviewRequests()
      }
    }
  }, [webPane.id, webPane.url, wsToken, connectEpoch, connected, keepStreamingWhenHidden])

  const send = (payload: unknown) => {
    const socket = socketRef.current
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'input', event: payload }))
    }
  }

  const requestSelectionCopy = () => {
    const socket = socketRef.current
    if (!socket || socket.readyState !== WebSocket.OPEN) return
    const id = `s-${nextSelectionId.current++}`
    pendingSelectionId.current = id
    socket.send(JSON.stringify({ type: 'selection', id }))
  }

  const lastMove = useRef(0)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    return attachTileWheelCapture(canvas, send)
  }, [])

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
          if (reviewMode) return
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
          if (reviewMode) return
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
          if (reviewMode || !shouldCaptureKey(event.key)) return
          event.preventDefault()
          event.stopPropagation()
          if (isCopyShortcut(event.nativeEvent) && (!nativeWindowBridge || event.metaKey)) {
            for (const message of tileKeyMessages(event.nativeEvent)) send(message)
            requestSelectionCopy()
            return
          }
          for (const message of tileKeyMessages(event.nativeEvent)) send(message)
        }}
        onKeyUp={(event) => {
          if (reviewMode || !shouldCaptureKey(event.key)) return
          event.preventDefault()
          event.stopPropagation()
          for (const message of tileKeyMessages(event.nativeEvent)) send(message)
        }}
      />
      <TileReviewLayer
        webPaneId={webPane.id}
        reviewMode={reviewMode}
        active={reviewMode && state === 'streaming'}
        containerRef={containerRef}
        inputRef={canvasRef}
        pendingQueue={pendingQueue}
        surface={reviewSurface}
      />
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
