import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'

type Recording = { recorder: MediaRecorder; stream: MediaStream; chunks: Blob[]; stopping: boolean }
export function useSimRecording(canvas: RefObject<HTMLCanvasElement | null>, enabled: boolean, udid: string, onError: (message: string) => void) {
  const session = useRef<Recording | null>(null)
  const mounted = useRef(false)
  const [elapsed, setElapsed] = useState<number | null>(null)
  const available = typeof MediaRecorder !== 'undefined' && typeof HTMLCanvasElement.prototype.captureStream === 'function'
  const stop = useCallback(() => {
    const current = session.current
    if (!current || current.stopping) return
    current.stopping = true
    if (current.recorder.state !== 'inactive') current.recorder.stop()
  }, [])
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; stop() }
  }, [stop])
  useEffect(() => {
    if (!enabled) stop()
    return stop
  }, [enabled, udid, stop])
  const toggle = () => {
    if (session.current) { stop(); return }
    if (!enabled || !available || !canvas.current) return
    let stream: MediaStream | undefined
    let timer: number | undefined
    try {
      const mimeType = MediaRecorder.isTypeSupported('video/mp4') ? 'video/mp4' : 'video/webm'
      stream = canvas.current.captureStream(30)
      const recorder = new MediaRecorder(stream, { mimeType })
      const current: Recording = { recorder, stream, chunks: [], stopping: false }
      recorder.ondataavailable = (event) => { if (event.data.size) current.chunks.push(event.data) }
      recorder.onstop = () => {
        window.clearInterval(timer)
        current.stream.getTracks().forEach((track) => track.stop())
        if (session.current === current) { session.current = null; if (mounted.current) setElapsed(null) }
        if (!current.chunks.length) return
        const type = recorder.mimeType || mimeType
        const url = URL.createObjectURL(new Blob(current.chunks, { type }))
        const link = document.createElement('a')
        link.href = url
        link.download = `simulator-${udid.slice(0, 8)}-${new Date().toISOString().replace(/[:.]/g, '-')}.${type.includes('mp4') ? 'mp4' : 'webm'}`
        link.click()
        window.setTimeout(() => URL.revokeObjectURL(url), 1_000)
      }
      recorder.onerror = () => { if (mounted.current) onError('Video recording failed'); stop() }
      session.current = current
      recorder.start(1_000)
      const started = Date.now()
      setElapsed(0)
      timer = window.setInterval(() => { if (mounted.current) setElapsed(Math.floor((Date.now() - started) / 1_000)) }, 1_000)
    } catch (error) {
      window.clearInterval(timer)
      stream?.getTracks().forEach((track) => track.stop())
      session.current = null
      onError(error instanceof Error ? error.message : 'Unable to start video recording')
    }
  }
  return { available, recording: elapsed !== null, elapsed: `${String(Math.floor((elapsed ?? 0) / 60)).padStart(2, '0')}:${String((elapsed ?? 0) % 60).padStart(2, '0')}`, toggle }
}
