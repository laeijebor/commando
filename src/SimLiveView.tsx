import { useEffect, useId, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { Camera, Circle, Home, Link, Lock, MoreHorizontal, PanelsTopLeft, RotateCw, ScanSearch, SunMoon } from 'lucide-react'
import { SIM_NETWORK_PROFILES, type SimAction, type SimOrientation } from '../shared/sim-actions'
import { createSimsApi, type SimsApiClient } from './simsApi'
import { fitCanvas, nativeToScreen, ORIENTATION_TURNS, rotateOrientation, screenBottomEdge, screenSize, screenToNative, type NativeEdge, type Point } from './simGeometry'
import { useSimRecording } from './useSimRecording'
import { useSimInspector } from './useSimInspector'
import { SimInspectorBox, SimInspectorPanel } from './SimInspector'
import './sims-view.css'
import './sim-live.css'

/** Height in points of the home-indicator band at the bottom of the screen. */
/** Baguette cannot report a device's orientation, so reopening a view resumes the one this page last set. */
export const lastOrientation = new Map<string, SimOrientation>()
const EDGE_BAND = 20
/** How long the daemon may take to answer a live connection before the view falls back to snapshots. */
const CONNECT_TIMEOUT_MS = 12_000
/** Points of wheel travel before the synthetic finger presses, and how long after the last wheel event it lifts. */
const WHEEL_SLOP = 12
const WHEEL_IDLE_MS = 120

/**
 * Exactly one tile is active in App; the wall mounts its focused overlay and at most one hover preview.
 * A preview accepts pointer input without taking keyboard focus and waits for decoded video.
 */
export function SimLiveView({ udid, token, active = true, connected = true, preview = false, onStreaming, api: providedApi }: {
  udid: string; token: string; active?: boolean; connected?: boolean; preview?: boolean; onStreaming?: (streaming: boolean) => void; api?: SimsApiClient
}) {
  const api = useMemo(() => providedApi ?? createSimsApi(token), [providedApi, token])
  const canvas = useRef<HTMLCanvasElement>(null)
  const screen = useRef<HTMLDivElement>(null)
  const socket = useRef<WebSocket | null>(null)
  const dimensions = useRef({ width: 0, height: 0 })
  const [nativeSize, setNativeSize] = useState({ width: 390, height: 844 })
  const [bounds, setBounds] = useState({ width: 0, height: 0 })
  const [viewOrientation, setOrientation] = useState<SimOrientation>(() => lastOrientation.get(udid) ?? 'portrait')
  const orientation = preview ? 'portrait' : viewOrientation
  // `second` is set for an Option-held two-finger gesture; `offset` is the vector between the fingers.
  const pointer = useRef<{ id: number; x: number; y: number; second?: Point; edge?: NativeEdge } | null>(null)
  const hover = useRef<Point | null>(null)
  const offset = useRef<Point>({ x: 0, y: 0 })
  const [fingers, setFingers] = useState<{ pressed: boolean; points: Point[] }>({ pressed: false, points: [] })
  const moveFrame = useRef<number | null>(null)
  const [snapshot, setSnapshot] = useState(!active || typeof VideoDecoder === 'undefined')
  const [image, setImage] = useState<string>()
  const [reason, setReason] = useState('')
  const [visible, setVisible] = useState(document.visibilityState === 'visible')
  const [revision, setRevision] = useState(0)
  const [focused, setFocused] = useState(false)
  const [ready, setReady] = useState(false)
  const [painted, setPainted] = useState(false)
  const toolbar = useRef<HTMLDivElement>(null)
  const moreButton = useRef<HTMLButtonElement>(null)
  const urlButton = useRef<HTMLButtonElement>(null)
  const returnFocus = useRef<HTMLButtonElement | null>(null)
  const pending = useRef(new Set<string>())
  const [busy, setBusy] = useState(new Set<string>())
  const [popover, setPopover] = useState<'more' | 'url' | null>(null)
  const [url, setUrl] = useState('')
  const [schemes, setSchemes] = useState<string[]>([])
  const schemesId = useId()
  const closePopover = () => {
    setPopover(null)
    const button = (popover === 'more' ? moreButton : urlButton).current
    if (button?.disabled) returnFocus.current = button
    else button?.focus()
  }
  const perform = async (key: string, work: () => Promise<void>) => {
    if (pending.current.has(key)) return
    pending.current.add(key); setBusy(new Set(pending.current)); setReason('')
    try { await work() } catch (error) { setReason(error instanceof Error ? error.message : 'Simulator action failed') }
    finally { pending.current.delete(key); setBusy(new Set(pending.current)) }
  }
  const deviceAction = (body: SimAction) => perform(body.action, async () => {
    const result = await api.action(udid, body)
    if (result.warning) setReason(result.warning)
  })
  const rotate = (direction: 1 | -1) => {
    if (!connected || preview) return
    const next = rotateOrientation(orientation, direction)
    return perform('orientation', async () => {
      await api.action(udid, { action: 'orientation', value: next })
      releasePointer(); hover.current = null; offset.current = { x: 0, y: 0 }
      setFingers({ pressed: false, points: [] }); setOrientation(next); lastOrientation.set(udid, next)
    })
  }

  useEffect(() => {
    const target = screen.current
    if (!target) return
    const measure = () => setBounds({ width: Math.max(0, target.clientWidth - 12), height: Math.max(0, target.clientHeight - 12) })
    measure()
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure)
      return () => window.removeEventListener('resize', measure)
    }
    const observer = new ResizeObserver(([entry]) => setBounds({ width: entry.contentRect.width, height: entry.contentRect.height }))
    observer.observe(target)
    return () => observer.disconnect()
  }, [preview])

  useEffect(() => {
    if (!popover && returnFocus.current && !returnFocus.current.disabled) {
      returnFocus.current.focus(); returnFocus.current = null
    }
  }, [popover, busy])

  useEffect(() => {
    if (!popover) return
    const outside = (event: PointerEvent) => { if (!toolbar.current?.contains(event.target as Node)) closePopover() }
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closePopover() }
    }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('keydown', escape, true)
    if (popover === 'more') toolbar.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus()
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape, true) }
  }, [popover])

  useEffect(() => {
    if (popover !== 'url') return
    let disposed = false
    setSchemes([])
    void api.schemes(udid).then((values) => { if (!disposed) setSchemes(values) })
      .catch((error: unknown) => { if (!disposed) setReason(error instanceof Error ? error.message : 'Unable to load URL schemes') })
    return () => { disposed = true }
  }, [popover, api, udid])

  const send = (envelope: Record<string, unknown>) => {
    if (socket.current?.readyState === WebSocket.OPEN) socket.current.send(JSON.stringify(envelope))
  }
  const releasePointer = () => {
    if (moveFrame.current !== null) { cancelAnimationFrame(moveFrame.current); moveFrame.current = null }
    const held = pointer.current
    if (!held) return
    send(held.second ? { type: 'touch2-up', x1: held.x, y1: held.y, x2: held.second.x, y2: held.second.y } : { type: 'touch1-up', x: held.x, y: held.y, edge: held.edge })
    pointer.current = null
    setFingers({ pressed: false, points: [] })
    if (canvas.current?.hasPointerCapture?.(held.id)) canvas.current.releasePointerCapture(held.id)
  }

  useEffect(() => {
    let timer: number | undefined
    const change = () => {
      const isVisible = document.visibilityState === 'visible'
      setVisible(isVisible)
      window.clearTimeout(timer)
      if (!isVisible) {
        releasePointer()
        canvas.current?.blur()
        timer = window.setTimeout(() => { socket.current?.close(); socket.current = null; setReady(false) }, 30_000)
      } else if (!socket.current && active) setRevision((value) => value + 1)
    }
    document.addEventListener('visibilitychange', change)
    return () => { window.clearTimeout(timer); document.removeEventListener('visibilitychange', change) }
    // The listener reads the current socket and pointer refs.
  }, [active])

  useEffect(() => {
    setReady(false)
    setPainted(false)
    dimensions.current = { width: 0, height: 0 }
    if (!active || !connected || typeof VideoDecoder === 'undefined') {
      setSnapshot(true)
      setReason(!active ? '' : !connected ? 'Daemon disconnected' : 'Live video is unavailable in this browser')
      return
    }
    if (document.visibilityState !== 'visible') return
    let disposed = false
    let failed = false
    let decoder: VideoDecoder | undefined
    let timestamp = 0
    let needsKey = true
    let paintedVideo = false
    const seeds = new Set<HTMLImageElement>()
    const urls = new Set<string>()
    setSnapshot(false)
    setReason('')
    const url = new URL(`/ws/api/sims/${encodeURIComponent(udid)}/live`, window.location.href)
    url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
    let ws: WebSocket
    try {
      const credential = encodeURIComponent(token).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
      ws = new WebSocket(url.toString(), token ? ['commando-live', `commando-auth.${credential}`] : ['commando-live'])
    } catch {
      setSnapshot(true)
      setReason('Live simulator connection unavailable')
      return
    }
    socket.current = ws
    ws.binaryType = 'arraybuffer'
    // A stream that never answers must not leave a blank 'connecting' view: give up visibly and offer a retry.
    const watchdog = window.setTimeout(() => { if (!dimensions.current.width) fallback('Live stream did not respond; showing snapshots') }, CONNECT_TIMEOUT_MS)
    const fallback = (message: string) => {
      window.clearTimeout(watchdog)
      if (disposed || failed) return
      console.warn(`[sim-live] ${udid}: ${message}`)
      failed = true
      releasePointer()
      setReady(false)
      setSnapshot(true)
      setReason(message)
      if (decoder && decoder.state !== 'closed') decoder.close()
      ws.close()
    }
    const paint = (source: CanvasImageSource, width: number, height: number) => {
      if (disposed || failed || !canvas.current) return
      const target = canvas.current
      if (target.width !== width) target.width = width
      if (target.height !== height) target.height = height
      target.getContext('2d')?.drawImage(source, 0, 0, width, height)
    }
    ws.onmessage = (event: MessageEvent<string | ArrayBuffer>) => {
      if (disposed || failed) return
      try {
        if (typeof event.data === 'string') {
          const meta = JSON.parse(event.data) as { type: string; width: number; height: number }
          if (meta.type === 'meta' && Number.isFinite(meta.width) && Number.isFinite(meta.height) && meta.width > 0 && meta.height > 0) {
            dimensions.current = { width: meta.width, height: meta.height }
            setNativeSize(dimensions.current)
            window.clearTimeout(watchdog)
            setReady(true)
          }
          return
        }
        const bytes = new Uint8Array(event.data)
        const payload = bytes.slice(1)
        if (bytes[0] === 1) {
          if (payload.length < 4) throw new Error('Invalid video description')
          if (decoder && decoder.state !== 'closed') decoder.close()
          decoder = new VideoDecoder({
            output: (frame) => {
              try { if (disposed || failed) return; paint(frame, frame.displayWidth, frame.displayHeight); paintedVideo = true; setPainted(true) } finally { frame.close() }
            },
            error: () => fallback('Live video could not be decoded'),
          })
          decoder.configure({ codec: `avc1.${[...payload.slice(1, 4)].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`, description: payload, optimizeForLatency: true })
          needsKey = true
        } else if (bytes[0] === 2 || bytes[0] === 3) {
          if (!decoder || decoder.state !== 'configured' || (needsKey && bytes[0] !== 2)) return
          needsKey = false
          decoder.decode(new EncodedVideoChunk({ type: bytes[0] === 2 ? 'key' : 'delta', timestamp: timestamp++ * (1_000_000 / 30), data: payload }))
        } else if (bytes[0] === 4) {
          const seed = new Image()
          const seedUrl = URL.createObjectURL(new Blob([payload], { type: 'image/jpeg' }))
          urls.add(seedUrl); seeds.add(seed)
          const cleanup = () => { URL.revokeObjectURL(seedUrl); urls.delete(seedUrl); seeds.delete(seed); seed.onload = null; seed.onerror = null }
          seed.onload = () => { if (!paintedVideo) paint(seed, seed.naturalWidth, seed.naturalHeight); cleanup() }
          seed.onerror = cleanup
          seed.src = seedUrl
        }
      } catch { fallback('Live video could not be decoded') }
    }
    ws.onerror = () => fallback('Live simulator connection unavailable')
    ws.onclose = (event) => {
      if (socket.current === ws) socket.current = null
      fallback(event.reason || 'Live simulator connection closed')
    }
    if (!preview) canvas.current?.focus()
    return () => {
      window.clearTimeout(watchdog)
      releasePointer()
      disposed = true
      if (socket.current === ws) socket.current = null
      ws.onmessage = null; ws.onclose = null; ws.onerror = null
      ws.close()
      if (decoder && decoder.state !== 'closed') decoder.close()
      for (const seed of seeds) { seed.onload = null; seed.onerror = null; seed.removeAttribute('src') }
      for (const seedUrl of urls) URL.revokeObjectURL(seedUrl)
    }
  }, [active, connected, udid, token, revision, preview])

  useEffect(() => {
    if (active && !snapshot && !preview) canvas.current?.focus()
  }, [active, snapshot, preview])

  const streaming = ready && !snapshot && (!preview || painted)
  const inspector = useSimInspector(api, udid, active && streaming && !preview)
  const recording = useSimRecording(canvas, active && streaming && !preview, udid, setReason)
  useEffect(() => {
    const target = canvas.current
    if (!target || !active || !streaming) return
    // Baguette's `scroll` message restarts backboardd on iOS 26.5, so the wheel drives a one-finger drag instead.
    let drag: { x: number; y: number; down: boolean; dx: number; dy: number } | null = null
    let idle: number | undefined
    const end = () => {
      window.clearTimeout(idle)
      if (drag?.down) send({ type: 'touch1-up', x: drag.x + drag.dx, y: drag.y + drag.dy })
      drag = null
    }
    const wheel = (event: WheelEvent) => {
      event.preventDefault()
      if (pointer.current) return
      const rect = screenRect(target), { width, height } = dimensions.current
      if (!width || !height || !rect.width) return
      drag ??= { ...clamp(screenToNative({ x: (event.clientX - rect.left) / rect.width, y: (event.clientY - rect.top) / rect.height }, dimensions.current, orientation)), down: false, dx: 0, dy: 0 }
      // Content follows the finger, so the drag runs opposite to the wheel delta. One wheel pixel is one
      // device point whatever the view's zoom, so a small wall card does not scroll faster than the full view.
      const displayed = screenSize(dimensions.current, orientation)
      const delta = screenToNative({ x: -event.deltaX / displayed.width, y: -event.deltaY / displayed.height }, dimensions.current, orientation)
      const origin = screenToNative({ x: 0, y: 0 }, dimensions.current, orientation)
      const next = { x: drag.x + drag.dx + delta.x - origin.x, y: drag.y + drag.dy + delta.y - origin.y }
      const held = clamp(next)
      drag.dx = held.x - drag.x; drag.dy = held.y - drag.y
      // Press only after real travel: a press and release in place would be a tap.
      if (!drag.down && Math.hypot(drag.dx, drag.dy) >= WHEEL_SLOP) { drag.down = true; send({ type: 'touch1-down', x: drag.x, y: drag.y }) }
      if (drag.down) send({ type: 'touch1-move', x: held.x, y: held.y })
      window.clearTimeout(idle)
      // At the screen edge the finger lifts so the next wheel event starts a fresh drag from the cursor.
      if (drag.down && (held.x !== next.x || held.y !== next.y)) end()
      else idle = window.setTimeout(end, WHEEL_IDLE_MS)
    }
    target.addEventListener('wheel', wheel, { passive: false })
    return () => { target.removeEventListener('wheel', wheel); end() }
  }, [active, streaming, orientation])

  useEffect(() => {
    if (!streaming) return
    onStreaming?.(true)
    return () => onStreaming?.(false)
    // Callers pass a state setter; a changing callback identity must not flap the flag.
  }, [streaming])

  useEffect(() => () => { if (image) URL.revokeObjectURL(image) }, [image])
  useEffect(() => {
    if (!snapshot || !visible || preview) return
    const controller = new AbortController()
    let busy = false
    const refresh = async () => {
      if (busy || controller.signal.aborted) return
      busy = true
      try {
        const blob = await api.snapshot(udid, controller.signal)
        if (!controller.signal.aborted) setImage(URL.createObjectURL(blob))
      } catch (error) { if (!controller.signal.aborted) setReason(error instanceof Error ? error.message : 'Snapshot unavailable') }
      finally { busy = false }
    }
    void refresh()
    const timer = window.setInterval(() => void refresh(), 2_000)
    return () => { controller.abort(); window.clearInterval(timer) }
  }, [snapshot, visible, api, udid, preview])

  const clamp = ({ x, y }: Point): Point => ({ x: Math.max(0, Math.min(dimensions.current.width, x)), y: Math.max(0, Math.min(dimensions.current.height, y)) })
  const screenRect = (target: HTMLCanvasElement) => {
    const rect = target.getBoundingClientRect()
    if (!preview) return rect
    // object-fit: cover centres horizontally and aligns the uncropped screen to the top.
    const scale = Math.max(rect.width / target.width, rect.height / target.height)
    const width = target.width * scale, height = target.height * scale
    return { left: rect.left + (rect.width - width) / 2, top: rect.top, width, height }
  }
  const point = (event: Pick<ReactPointerEvent<HTMLCanvasElement>, 'currentTarget' | 'clientX' | 'clientY'>) => {
    const rect = screenRect(event.currentTarget)
    return clamp(screenToNative({ x: (event.clientX - rect.left) / rect.width, y: (event.clientY - rect.top) / rect.height }, dimensions.current, orientation))
  }
  /** Like Simulator.app: the second finger mirrors the first through the screen centre; Shift moves both in parallel. */
  const secondFinger = (first: Point, parallel: boolean): Point => {
    if (!parallel) offset.current = { x: dimensions.current.width - 2 * first.x, y: dimensions.current.height - 2 * first.y }
    return clamp({ x: first.x + offset.current.x, y: first.y + offset.current.y })
  }
  /** Finger markers are positioned in viewport pixels so they need no wrapper sized to the canvas. */
  const showFingers = (pressed: boolean, points: Point[]) => {
    const rect = canvas.current ? screenRect(canvas.current) : undefined
    const { width, height } = dimensions.current
    if (!rect || !width || !height) return
    setFingers({ pressed, points: points.map((point) => {
      const { x, y } = nativeToScreen(point, dimensions.current, orientation)
      return { x: Math.round(rect.left + x * rect.width), y: Math.round(rect.top + y * rect.height) }
    }) })
  }
  const inputEnabled = active && streaming
  const toggleInspect = () => {
    releasePointer(); hover.current = null; setFingers({ pressed: false, points: [] })
    inspector.setEnabled(!inspector.enabled)
  }
  const press = (button: string) => send({ type: 'button', button })
  const saveScreenshot = () => {
    const save = (url: string, extension: 'png' | 'jpg') => {
      const link = document.createElement('a')
      link.href = url
      link.download = `simulator-${udid.slice(0, 8)}-${new Date().toISOString().replace(/[:.]/g, '-')}.${extension}`
      link.click()
    }
    // Fallback snapshots are JPEG; only the live canvas is encoded as PNG.
    if (snapshot) { if (image) save(image, 'jpg'); return }
    canvas.current?.toBlob((blob) => {
      if (!blob) return
      const url = URL.createObjectURL(blob)
      save(url, 'png')
      window.setTimeout(() => URL.revokeObjectURL(url), 1_000)
    }, 'image/png')
  }
  const canvasSize = fitCanvas(nativeSize, bounds, orientation)
  const screenStyle = preview ? undefined : {
    width: canvasSize.width, height: canvasSize.height,
    transform: `translate(-50%, -50%) rotate(${ORIENTATION_TURNS[orientation] * 90}deg)`,
  }
  const liveCanvas = <canvas ref={canvas} style={screenStyle} hidden={preview ? !streaming : snapshot} className={preview ? 'sim-live-preview' : focused ? 'is-focused' : ''}
        tabIndex={preview ? undefined : active && !snapshot ? 0 : -1} aria-label={preview ? 'Live simulator preview' : 'Live simulator. Click to control; Escape releases keyboard focus'}
        onFocus={preview ? undefined : () => setFocused(true)} onBlur={preview ? undefined : () => { setFocused(false); releasePointer() }}
        onPointerDown={(event) => {
          if (!inputEnabled || pointer.current || event.button !== 0) return
          event.preventDefault(); if (!preview) event.currentTarget.focus()
          if (inspector.enabled) return
          const position = point(event)
          if (!Number.isFinite(position.x) || !Number.isFinite(position.y)) return
          const second = event.altKey ? secondFinger(position, event.shiftKey) : undefined
          pointer.current = { id: event.pointerId, ...position, second }
          event.currentTarget.setPointerCapture(event.pointerId)
          // A press in the home-indicator band is an edge gesture, so iOS runs its live home and app-switcher animation.
          const fraction = nativeToScreen(position, dimensions.current, orientation)
          const edge = !second && (1 - fraction.y) * screenSize(dimensions.current, orientation).height <= EDGE_BAND ? screenBottomEdge(orientation) : undefined
          pointer.current.edge = edge
          send(second ? { type: 'touch2-down', x1: position.x, y1: position.y, x2: second.x, y2: second.y } : { type: 'touch1-down', ...position, edge })
          showFingers(true, second ? [position, second] : [position])
        }}
        onPointerMove={(event) => {
          const position = point(event)
          if (!Number.isFinite(position.x) || !Number.isFinite(position.y)) return
          if (inspector.enabled) { inspector.move(position); return }
          if (!pointer.current) {
            // Preview where both fingers will land while Option is held.
            hover.current = position
            if (inputEnabled && event.altKey) showFingers(false, [position, secondFinger(position, event.shiftKey)])
            else if (fingers.points.length) setFingers({ pressed: false, points: [] })
            return
          }
          if (pointer.current.id !== event.pointerId) return
          const second = pointer.current.second ? secondFinger(position, event.shiftKey) : undefined
          pointer.current = { ...pointer.current, ...position, second }
          showFingers(true, second ? [position, second] : [position])
          if (moveFrame.current === null) moveFrame.current = requestAnimationFrame(() => {
            moveFrame.current = null
            const held = pointer.current
            if (held) send(held.second ? { type: 'touch2-move', x1: held.x, y1: held.y, x2: held.second.x, y2: held.second.y } : { type: 'touch1-move', x: held.x, y: held.y, edge: held.edge })
          })
        }}
        onPointerUp={(event) => {
          if (pointer.current?.id !== event.pointerId) return
          const position = point(event)
          if (Number.isFinite(position.x) && Number.isFinite(position.y)) {
            pointer.current = { ...pointer.current, ...position, second: pointer.current.second ? secondFinger(position, event.shiftKey) : undefined }
          }
          releasePointer()
        }}
        onPointerCancel={releasePointer} onLostPointerCapture={releasePointer}
        onPointerLeave={() => { hover.current = null; releasePointer(); inspector.leave() }}
        onClick={(event) => {
          if (!inspector.enabled || event.button !== 0) return
          const position = point(event)
          if (Number.isFinite(position.x) && Number.isFinite(position.y)) inspector.select(position)
        }}
        onPaste={preview ? undefined : (event) => {
          const text = event.clipboardData.getData('text/plain')
          if (!inputEnabled || inspector.enabled || !text) return
          event.preventDefault()
          send({ type: 'paste', text: text.slice(0, 4096), press: true })
        }}
        onKeyUp={preview ? undefined : (event) => { if (event.key === 'Alt' && !pointer.current) setFingers({ pressed: false, points: [] }) }}
        onKeyDown={preview ? undefined : (event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            if (inspector.enabled) { event.stopPropagation(); inspector.setEnabled(false); return }
            releasePointer(); event.currentTarget.blur(); return
          }
          if (!inputEnabled || document.activeElement !== event.currentTarget) return
          if (event.metaKey && event.shiftKey && event.code === 'KeyI') { event.preventDefault(); event.stopPropagation(); toggleInspect(); return }
          if (inspector.enabled) { event.preventDefault(); event.stopPropagation(); return }
          // ⌘V falls through to the paste event so the host clipboard reaches the simulator.
          if (event.metaKey && event.code === 'KeyV') return
          event.preventDefault(); event.stopPropagation()
          if (event.key === 'Alt') {
            if (hover.current && !pointer.current) showFingers(false, [hover.current, secondFinger(hover.current, event.shiftKey)])
            return
          }
          if (event.metaKey && event.shiftKey && event.code === 'KeyH') { press('home'); return }
          if (event.metaKey && event.code === 'KeyL') { press('lock'); return }
          if (event.metaKey && (event.code === 'ArrowLeft' || event.code === 'ArrowRight')) { void rotate(event.code === 'ArrowRight' ? 1 : -1); return }
          if (event.metaKey && event.shiftKey && event.code === 'KeyA') { void deviceAction({ action: 'appearance', value: 'toggle' }); return }
          send({ type: 'key', code: event.code, modifiers: [event.shiftKey && 'shift', event.ctrlKey && 'control', event.altKey && 'option', event.metaKey && 'command'].filter(Boolean) })
        }} />
  const fingerMarkers = fingers.points.map((finger, index) => <span key={index} className={`sim-live-finger${fingers.pressed ? ' is-pressed' : ''}`} style={{ left: finger.x, top: finger.y }} aria-hidden="true" />)
  if (preview) return snapshot ? null : <>{liveCanvas}{fingerMarkers}</>
  // Container queries establish a containing block; viewport finger markers must stay outside it.
  return <><div className="sim-live" onKeyDown={(event) => {
    if (inspector.enabled && event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); inspector.setEnabled(false) }
  }}>
    <div ref={toolbar} className="sims-actions sim-live-toolbar">
      <span className="sims-pill">{snapshot ? 'snapshot' : ready ? 'live' : 'connecting'}</span>
      <button type="button" disabled={!inputEnabled} aria-label="Home" title="Home (⌘⇧H)" onClick={() => press('home')}><Home aria-hidden="true" /></button>
      <button type="button" disabled={!inputEnabled} aria-label="App Switcher" title="App Switcher" onClick={() => press('app-switcher')}><PanelsTopLeft aria-hidden="true" /></button>
      <button type="button" disabled={!inputEnabled} aria-label="Lock" title="Lock (⌘L)" onClick={() => press('lock')}><Lock aria-hidden="true" /></button>
      <button type="button" disabled={snapshot ? !image : !ready} aria-label="Screenshot" title="Save an image of the current screen" onClick={saveScreenshot}><Camera aria-hidden="true" /></button>
      <button type="button" disabled={!inputEnabled} aria-label="Inspect" aria-pressed={inspector.enabled} title="Inspect element (⌘⇧I)" onClick={toggleInspect}><ScanSearch aria-hidden="true" /></button>
      <button type="button" disabled={!connected || busy.has('orientation')} aria-label="Rotate right" title="Rotate right (⌘→)" onClick={() => void rotate(1)}><RotateCw aria-hidden="true" /></button>
      <button type="button" className={`sim-live-record${recording.recording ? ' is-recording' : ''}`} disabled={!recording.recording && (!inputEnabled || !recording.available)} aria-label={recording.recording ? 'Stop recording' : 'Record'} aria-pressed={recording.recording}
        title={`${recording.recording ? 'Stop and save recording' : 'Record live video'}${orientation !== 'portrait' ? ' (captures unrotated canvas pixels)' : ''}`} onClick={recording.toggle}><Circle aria-hidden="true" />{recording.recording ? <span>{recording.elapsed}</span> : null}</button>
      <button type="button" disabled={!connected || busy.has('appearance')} aria-label="Toggle Light/Dark" title="Toggle Light/Dark (⌘⇧A)" onClick={() => void deviceAction({ action: 'appearance', value: 'toggle' })}><SunMoon aria-hidden="true" /></button>
      <button ref={urlButton} type="button" disabled={!connected || busy.has('open-url')} aria-label="Open URL" title="Open URL / deep link" aria-expanded={popover === 'url'} onClick={() => popover === 'url' ? closePopover() : setPopover('url')}><Link aria-hidden="true" /></button>
      <button ref={moreButton} type="button" aria-label="More" title="More" aria-haspopup="menu" aria-expanded={popover === 'more'} onClick={() => popover === 'more' ? closePopover() : setPopover('more')}><MoreHorizontal aria-hidden="true" /></button>
      {popover === 'url' ? <form className="sim-live-popover sim-live-url" onSubmit={(event) => {
        event.preventDefault()
        if (!url || busy.has('open-url') || !connected) return
        void perform('open-url', async () => { await api.action(udid, { action: 'open-url', url }); closePopover() })
      }}>
        <label htmlFor={`${schemesId}-url`}>Open URL / deep link</label>
        <input id={`${schemesId}-url`} autoFocus type="text" value={url} maxLength={2048} list={schemesId} placeholder="myapp://" disabled={busy.has('open-url')} onChange={(event) => setUrl(event.target.value)} />
        <datalist id={schemesId}>{schemes.map((scheme) => <option key={scheme} value={`${scheme}://`} />)}</datalist>
        <button type="submit" disabled={!connected || !url || busy.has('open-url')}>Open</button>
      </form> : null}
      {popover === 'more' ? <div className="sim-live-popover sim-live-menu" role="menu" aria-label="Device actions" onKeyDown={(event) => {
        const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')]
        const index = items.indexOf(document.activeElement as HTMLButtonElement)
        if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
          event.preventDefault()
          items[event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus()
        } else if (event.key === 'Tab') setPopover(null)
      }}>
        {['up', 'down'].map((direction) => <button key={direction} type="button" role="menuitem" disabled={!inputEnabled} onClick={() => { press(`volume-${direction}`); closePopover() }}>Volume {direction}</button>)}
        {([-1, 1] as const).map((direction) => <button key={direction} type="button" role="menuitem" disabled={!connected || busy.has('orientation')} onClick={() => { closePopover(); void rotate(direction) }}>Rotate {direction === 1 ? 'right' : 'left'}</button>)}
        {([
          ['Shake', { action: 'shake' }],
          ['Clean status bar', { action: 'status-bar', mode: 'clean' }], ['Reset status bar', { action: 'status-bar', mode: 'clear' }],
          ['Text size larger', { action: 'text-size', step: 1 }], ['Text size smaller', { action: 'text-size', step: -1 }],
          ['Increase contrast on', { action: 'contrast', enabled: true }], ['Increase contrast off', { action: 'contrast', enabled: false }],
          ['Reduce motion on', { action: 'reduce-motion', enabled: true }], ['Reduce motion off', { action: 'reduce-motion', enabled: false }],
          ...SIM_NETWORK_PROFILES.map((profile): [string, SimAction] => [`Network: ${profile}`, { action: 'network', profile }]),
          ['Repair input', { action: 'heal' }],
        ] satisfies Array<[string, SimAction]>).map(([label, body]) => <button key={label} type="button" role="menuitem" disabled={!connected || busy.has(body.action)} onClick={() => {
          if (body.action === 'heal' && !window.confirm("This restarts the simulator's home screen")) return
          closePopover(); void deviceAction(body)
        }}>{label}</button>)}
        <p>Network conditions need an app relaunch and affect URLSession traffic.</p>
        <button type="button" role="menuitem" disabled={!connected || busy.has('open')} onClick={() => {
          closePopover(); void perform('open', async () => {
            const result = await api.open(udid)
            if (result.raised === false) setReason(result.reason ?? 'Simulator activated')
          })
        }}>Open in Simulator</button>
      </div> : null}
    </div>
    <div className="sim-live-body">
    <div ref={screen} className="sim-live-screen">
      {snapshot ? (image ? <img src={image} style={screenStyle} alt="Simulator snapshot" onLoad={(event) => {
        const { naturalWidth: width, naturalHeight: height } = event.currentTarget
        if (width && height) setNativeSize({ width, height })
      }} /> : <span className="sims-empty">Waiting for snapshot…</span>) : null}
      {liveCanvas}
      {inspector.enabled && inspector.element ? <SimInspectorBox element={inspector.element} size={nativeSize} canvasSize={canvasSize} orientation={orientation} /> : null}
    </div>
    {inspector.enabled && inspector.selected ? <SimInspectorPanel element={inspector.selected} source={inspector.source} onClose={inspector.close} /> : null}
    </div>
    {inputEnabled ? <p className="sim-live-hint">⌥ drag to pinch or rotate · ⌥⇧ drag for a two-finger pan · ⌘V pastes</p> : null}
    {reason ? <p className="sims-error" role="status">{reason}{snapshot && active && connected ? <> <button type="button" onClick={() => { setReason(''); setRevision((value) => value + 1) }}>Retry live</button></> : null}</p> : null}
    {inspector.enabled && inspector.error ? <p className="sims-error" role="status">{inspector.error}</p> : null}
  </div>{fingerMarkers}</>
}
