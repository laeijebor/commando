import { useEffect, useRef, useState } from 'react'
import type { WebPane } from '../shared/protocol'
import {
  shouldCaptureKey,
  tileKeyMessages,
  tileMouseMessage,
  tileWheelMessage,
} from './chromiumTileInput'

const VIEWPORT_THROTTLE_MS = 200
const MOUSEMOVE_THROTTLE_MS = 16

type StreamState = 'connecting' | 'streaming' | 'closed' | 'error'

/**
 * The chromium-engine tile body: renders the daemon's CDP screencast onto a
 * canvas and relays input back over `/ws/web-tiles/:id`. Pauses (closes the
 * stream) while the document is hidden so a background cockpit costs nothing.
 */
export function ChromiumTileCard({
  webPane,
  wsToken,
  reloadKey,
}: {
  webPane: WebPane
  wsToken: string
  reloadKey: number
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const socketRef = useRef<WebSocket | null>(null)
  const [state, setState] = useState<StreamState>('connecting')
  const [detail, setDetail] = useState('')
  const [connectEpoch, setConnectEpoch] = useState(0)
  const lastReloadKey = useRef(reloadKey)

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
        let message: { type?: string; data?: string; message?: string }
        try {
          message = JSON.parse(event.data) as typeof message
        } catch {
          return
        }
        if (message.type === 'frame' && typeof message.data === 'string') {
          drawFrame(message.data)
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

  const lastMove = useRef(0)

  return (
    <div ref={containerRef} className="chromium-tile" data-stream-state={state}>
      <canvas
        ref={canvasRef}
        className="chromium-tile-canvas"
        tabIndex={0}
        aria-label={`Chromium tile: ${webPane.url}`}
        onMouseDown={(event) => {
          event.currentTarget.focus()
          const message = tileMouseMessage(event.nativeEvent)
          if (message) send(message)
        }}
        onMouseUp={(event) => {
          const message = tileMouseMessage(event.nativeEvent)
          if (message) send(message)
        }}
        onMouseMove={(event) => {
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
          if (!shouldCaptureKey(event.key)) return
          event.preventDefault()
          event.stopPropagation()
          for (const message of tileKeyMessages(event.nativeEvent)) {
            send(message)
          }
        }}
        onKeyUp={(event) => {
          if (!shouldCaptureKey(event.key)) return
          event.preventDefault()
          event.stopPropagation()
          for (const message of tileKeyMessages(event.nativeEvent)) {
            send(message)
          }
        }}
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
