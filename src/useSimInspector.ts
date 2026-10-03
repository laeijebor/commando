import { useEffect, useRef, useState } from 'react'
import type { SimElement, SimSourceResult } from '../shared/sim-inspector'
import type { SimsApiClient } from './simsApi'
import type { Point } from './simGeometry'

type Session = { move: (point: Point) => void; select: (point: Point) => void; leave: () => void; close: () => void }

export function useSimInspector(api: SimsApiClient, udid: string, available: boolean) {
  const [enabled, setEnabled] = useState(false)
  const [element, setElement] = useState<SimElement | null>(null)
  const [selected, setSelected] = useState<SimElement | null>(null)
  const [source, setSource] = useState<SimSourceResult | null>(null)
  const [error, setError] = useState('')
  const session = useRef<Session | null>(null)
  const inspecting = enabled && available

  useEffect(() => {
    setElement(null); setSelected(null); setSource(null); setError('')
    if (!inspecting) { setEnabled(false); return }
    let disposed = false, inFlight = false, pinned = false, version = 0, last = -Infinity
    let pending: { point: Point; select: boolean; version: number } | null = null
    let timer: ReturnType<typeof setTimeout> | undefined
    const controller = new AbortController()
    let sourceController: AbortController | undefined
    const schedule = () => {
      if (disposed || inFlight || !pending || timer !== undefined) return
      const delay = Math.max(0, 80 - (Date.now() - last))
      if (delay) { timer = setTimeout(() => { timer = undefined; void run() }, delay) }
      else void run()
    }
    const run = async () => {
      if (disposed || inFlight || !pending) return
      const job = pending
      pending = null; inFlight = true; last = Date.now()
      try {
        const result = await api.inspect(udid, job.point.x, job.point.y, controller.signal)
        if (disposed || job.version !== version) return
        setElement(result.element); setError('')
        if (job.select) {
          pinned = !!result.element
          setSelected(result.element)
          if (result.element) {
            const lookup = new AbortController()
            sourceController = lookup
            void api.inspectSource(udid, job.point.x, job.point.y, lookup.signal).then((result) => {
              if (!disposed && job.version === version) setSource(result)
            }).catch((error: unknown) => {
              if (!disposed && job.version === version) setSource({ ok: false, reason: 'failed', message: error instanceof Error ? error.message : 'Source lookup failed' })
            })
          }
        }
      } catch (error) {
        if (!disposed && job.version === version) { pinned = false; setError(error instanceof Error ? error.message : 'Element lookup failed') }
      } finally { inFlight = false; schedule() }
    }
    const queue = (point: Point, select: boolean) => {
      if (select) {
        pinned = true; sourceController?.abort(); setSelected(null); setSource(null); setError('')
      } else if (pinned) return
      pending = { point, select, version: ++version }
      schedule()
    }
    const clear = () => {
      version++; pinned = false; pending = null; sourceController?.abort()
      clearTimeout(timer); timer = undefined
      setElement(null); setSelected(null); setSource(null); setError('')
    }
    session.current = { move: (point) => queue(point, false), select: (point) => queue(point, true),
      leave: () => { if (!pinned) clear() }, close: clear }
    return () => {
      disposed = true; session.current = null; controller.abort(); sourceController?.abort(); clearTimeout(timer)
    }
  }, [api, udid, inspecting])

  return { enabled: inspecting, setEnabled, element, selected, source, error,
    move: (point: Point) => session.current?.move(point), select: (point: Point) => session.current?.select(point),
    leave: () => session.current?.leave(), close: () => session.current?.close() }
}
