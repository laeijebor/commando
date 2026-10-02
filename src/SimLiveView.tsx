import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { createSimsApi, type SimsApiClient } from './simsApi'
import './sims-view.css'
import './sim-live.css'

/** Exactly one tile is active in App; the wall mounts only its focused overlay. */
export function SimLiveView({ udid, token, active = true, connected = true, api: providedApi }: {
  udid: string; token: string; active?: boolean; connected?: boolean; api?: SimsApiClient
}) {
  const api = useMemo(() => providedApi ?? createSimsApi(token), [providedApi, token])
  const canvas = useRef<HTMLCanvasElement>(null)
  const socket = useRef<WebSocket | null>(null)
  const dimensions = useRef({ width: 0, height: 0 })
  const pointer = useRef<{ id: number; x: number; y: number } | null>(null)
  const moveFrame = useRef<number | null>(null)
  const [snapshot, setSnapshot] = useState(!active || typeof VideoDecoder === 'undefined')
  const [image, setImage] = useState<string>()
  const [reason, setReason] = useState('')
  const [visible, setVisible] = useState(document.visibilityState === 'visible')
  const [revision, setRevision] = useState(0)
  const [focused, setFocused] = useState(false)
  const [ready, setReady] = useState(false)

  const send = (envelope: Record<string, unknown>) => {
    if (socket.current?.readyState === WebSocket.OPEN) socket.current.send(JSON.stringify(envelope))
  }
  const releasePointer = () => {
    if (moveFrame.current !== null) { cancelAnimationFrame(moveFrame.current); moveFrame.current = null }
    const held = pointer.current
    if (!held) return
    send({ type: 'touch1-up', x: held.x, y: held.y })
    pointer.current = null
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
    const fallback = (message: string) => {
      if (disposed || failed) return
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
              try { paint(frame, frame.displayWidth, frame.displayHeight); paintedVideo = true } finally { frame.close() }
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
    canvas.current?.focus()
    return () => {
      releasePointer()
      disposed = true
      if (socket.current === ws) socket.current = null
      ws.onmessage = null; ws.onclose = null; ws.onerror = null
      ws.close()
      if (decoder && decoder.state !== 'closed') decoder.close()
      for (const seed of seeds) { seed.onload = null; seed.onerror = null; seed.removeAttribute('src') }
      for (const seedUrl of urls) URL.revokeObjectURL(seedUrl)
    }
  }, [active, connected, udid, token, revision])

  useEffect(() => {
    if (active && !snapshot) canvas.current?.focus()
  }, [active, snapshot])

  useEffect(() => {
    const target = canvas.current
    if (!target || !active || snapshot || !ready) return
    const wheel = (event: WheelEvent) => {
      event.preventDefault()
      send({ type: 'scroll', deltaX: event.deltaX, deltaY: event.deltaY })
    }
    target.addEventListener('wheel', wheel, { passive: false })
    return () => target.removeEventListener('wheel', wheel)
  }, [active, snapshot, ready])

  useEffect(() => () => { if (image) URL.revokeObjectURL(image) }, [image])
  useEffect(() => {
    if (!snapshot || !visible) return
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
  }, [snapshot, visible, api, udid])

  const point = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    return { x: Math.max(0, Math.min(dimensions.current.width, (event.clientX - rect.left) / rect.width * dimensions.current.width)),
      y: Math.max(0, Math.min(dimensions.current.height, (event.clientY - rect.top) / rect.height * dimensions.current.height)) }
  }
  const inputEnabled = active && !snapshot && ready
  return <div className="sim-live">
    <div className="sims-actions sim-live-toolbar">
      <span className="sims-pill">{snapshot ? 'snapshot' : ready ? 'live' : 'connecting'}</span>
      <button type="button" disabled={!inputEnabled} onClick={() => send({ type: 'button', button: 'home' })}>Home</button>
      <button type="button" disabled={!inputEnabled} onClick={() => send({ type: 'button', button: 'lock' })}>Lock</button>
      <button type="button" onClick={() => {
        void api.open(udid).then((result) => { if (result.raised === false) setReason(result.reason ?? 'Simulator activated') }).catch((error: unknown) => setReason(error instanceof Error ? error.message : 'Unable to open Simulator'))
      }}>Open Simulator</button>
    </div>
    <div className="sim-live-screen">
      {snapshot ? (image ? <img src={image} alt="Simulator snapshot" /> : <span className="sims-empty">Waiting for snapshot…</span>) : null}
      <canvas ref={canvas} hidden={snapshot} className={focused ? 'is-focused' : ''} tabIndex={active && !snapshot ? 0 : -1} aria-label="Live simulator. Click to control; Escape releases keyboard focus"
        onFocus={() => setFocused(true)} onBlur={() => { setFocused(false); releasePointer() }}
        onPointerDown={(event) => {
          if (!inputEnabled || pointer.current || event.button !== 0) return
          event.preventDefault(); event.currentTarget.focus()
          const position = point(event)
          if (!Number.isFinite(position.x) || !Number.isFinite(position.y)) return
          pointer.current = { id: event.pointerId, ...position }
          event.currentTarget.setPointerCapture(event.pointerId)
          send({ type: 'touch1-down', ...position })
        }}
        onPointerMove={(event) => {
          if (!pointer.current || pointer.current.id !== event.pointerId) return
          const position = point(event)
          if (!Number.isFinite(position.x) || !Number.isFinite(position.y)) return
          pointer.current = { id: event.pointerId, ...position }
          if (moveFrame.current === null) moveFrame.current = requestAnimationFrame(() => {
            moveFrame.current = null
            if (pointer.current) send({ type: 'touch1-move', x: pointer.current.x, y: pointer.current.y })
          })
        }}
        onPointerUp={(event) => {
          if (pointer.current?.id !== event.pointerId) return
          const position = point(event)
          if (Number.isFinite(position.x) && Number.isFinite(position.y)) pointer.current = { id: event.pointerId, ...position }
          releasePointer()
        }}
        onPointerCancel={releasePointer} onPointerLeave={releasePointer} onLostPointerCapture={releasePointer}
        onKeyDown={(event) => {
          if (event.key === 'Escape') { event.preventDefault(); releasePointer(); event.currentTarget.blur(); return }
          if (!inputEnabled || document.activeElement !== event.currentTarget) return
          event.preventDefault(); event.stopPropagation()
          send({ type: 'key', code: event.code, modifiers: [event.shiftKey && 'shift', event.ctrlKey && 'control', event.altKey && 'option', event.metaKey && 'command'].filter(Boolean) })
        }} />
    </div>
    {reason ? <p className="sims-error" role="status">{reason}</p> : null}
  </div>
}
