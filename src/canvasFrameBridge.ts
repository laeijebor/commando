import { encodeCanvasPath } from '../shared/canvas-manifest'
import { canvasPageKey } from '../shared/canvas-feedback'
import { redlinePageKey } from '../shared/redline-response'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { redlinePendingSnapshotForPage } from '../shared/redline-response'
import type { WebPanePendingSnapshot } from '../shared/protocol'
import { readCanvasHit, type CanvasHit } from './canvasComments'
import type { CanvasFrame } from '../shared/canvas-manifest'
import { readCanvasLabels, type CanvasLabelReports } from './canvasLabels'
import { readCanvasHotspots, type CanvasHotspotReports } from './canvasHotspots'

export function canvasFrameUrl(baseUrl: string, frame: CanvasFrame, revision = 0): string {
  const query = new URLSearchParams({ 'canvas-frame': frame.id })
  if (revision) query.set('canvas-reload', String(revision))
  return baseUrl + encodeCanvasPath(frame.src) + '?' + query
}

export type CanvasFrameInput = { type: 'goto'; target: string } | { type: 'escape' } | { type: 'zoom'; deltaY: number; deltaMode: number; x: number; y: number }
export function readCanvasFrameInput(data: Record<string, unknown>): CanvasFrameInput | null {
  if (data.type === 'goto' && typeof data.target === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(data.target)) return { type: 'goto', target: data.target }
  if (data.type === 'escape') return { type: 'escape' }
  if (data.type === 'zoom' && [data.deltaY, data.x, data.y].every((v) => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= 1_000_000) && [0, 1, 2].includes(data.deltaMode as number)) return { type: 'zoom', deltaY: data.deltaY as number, deltaMode: data.deltaMode as number, x: data.x as number, y: data.y as number }
  return null
}

export function useCanvasFrameBridge(frames: CanvasFrame[], baseUrl: string, revisions: Record<string, number>, onRedline?: (frameId: string, payload: unknown, pageUrl: string) => void, input?: { live: string | null; onInput: (frameId: string, input: CanvasFrameInput) => void }) {
  const relay = useRef(onRedline)
  const interaction = useRef(input)
  const pending = useRef<WebPanePendingSnapshot>({ notes: [], knownUpTo: 0, dropped: 0 })
  const requests = useRef(new Map<string, { frameId: string; url: string; finish: (hit: CanvasHit | null) => void }>())
  const requestId = useRef(0)
  useLayoutEffect(() => { relay.current = onRedline; interaction.current = input })
  const iframes = useRef(new Map<string, HTMLIFrameElement>())
  const sources = useRef(new Map<string, string>())
  const [reports, setReports] = useState<CanvasLabelReports>({})
  const [hotspots, setHotspots] = useState<CanvasHotspotReports>({})
  useLayoutEffect(() => {
    const next = new Map(frames.map((frame) => [frame.id, canvasFrameUrl(baseUrl, frame, revisions[frame.id])]))
    const previous = sources.current
    const unchanged = ([id]: [string, unknown]) => next.has(id) && next.get(id) === previous.get(id)
    setReports((current) => Object.fromEntries(Object.entries(current).filter(unchanged)))
    setHotspots((current) => Object.fromEntries(Object.entries(current).filter(unchanged)))
    sources.current = next
    for (const request of requests.current.values()) if (next.get(request.frameId) !== request.url) request.finish(null)
  }, [frames, baseUrl, revisions])
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      const data = event.data
      if (!data || data.source !== 'commando-canvas-frame' || typeof data.frameId !== 'string') return
      const iframe = iframes.current.get(data.frameId)
      if (!iframe || !event.source || event.source !== iframe.contentWindow) return
      const url = sources.current.get(data.frameId)
      if (!url) return
      const frameInput = readCanvasFrameInput(data)
      if (frameInput && interaction.current?.live === data.frameId) {
        interaction.current?.onInput(data.frameId, frameInput)
        return
      }
      if (data.type === 'labels') {
        if (typeof data.frameId !== 'string' || data.frameId.length > 64) return
        const labels = readCanvasLabels(data.labels)
        if (labels) setReports((current) => ({ ...current, [data.frameId]: labels }))
        setHotspots((current) => ({ ...current, [data.frameId]: readCanvasHotspots(data.hotspots) }))
        iframe.contentWindow?.postMessage({ source: 'commando-canvas', type: 'redline-pending', snapshot: canvasPendingSnapshotForPage(pending.current, new URL(url, window.location.href).href) }, '*')
      } else if (data.type === 'hit') {
        const request = requests.current.get(data.requestId)
        if (request && request.frameId === data.frameId && request.url === url) request.finish(readCanvasHit(data))
      } else if (data.type === 'redline-queue') {
        relay.current?.(data.frameId, data.payload, new URL(url, window.location.href).href)
      }
    }
    window.addEventListener('message', receive)
    return () => { window.removeEventListener('message', receive); for (const request of requests.current.values()) request.finish(null) }
  }, [])
  const syncInteraction = useCallback(() => {
    for (const [id, iframe] of iframes.current) iframe.contentWindow?.postMessage({ source: 'commando-canvas', type: 'interaction', live: interaction.current?.live === id }, '*')
  }, [])
  useEffect(() => { syncInteraction() }, [input?.live, revisions, frames, syncInteraction])
  const register = useCallback((id: string, node: HTMLIFrameElement | null) => {
    if (node) iframes.current.set(id, node)
    else iframes.current.delete(id)
  }, [])
  const hitTest = (frameId: string, point: { x: number; y: number }): Promise<CanvasHit | null> => {
    const iframe = iframes.current.get(frameId), url = sources.current.get(frameId)
    if (!iframe?.contentWindow || !url) return Promise.resolve(null)
    return new Promise((resolve) => {
      const id = `hit-${++requestId.current}`
      const finish = (hit: CanvasHit | null) => { window.clearTimeout(timer); requests.current.delete(id); resolve(hit) }
      const timer = window.setTimeout(() => finish(null), 2_000)
      requests.current.set(id, { frameId, url, finish })
      iframe.contentWindow!.postMessage({ source: 'commando-canvas', type: 'hit-test', requestId: id, ...point }, '*')
    })
  }
  const forwardPending = useCallback((snapshot: WebPanePendingSnapshot) => {
    pending.current = snapshot
    for (const [id, iframe] of iframes.current) {
      const url = sources.current.get(id)
      if (url) iframe.contentWindow?.postMessage({ source: 'commando-canvas', type: 'redline-pending', snapshot: canvasPendingSnapshotForPage(snapshot, new URL(url, window.location.href).href) }, '*')
    }
  }, [])
  return { reports, hotspots, register, hitTest, forwardPending, syncInteraction }
}

/** Filter by frame before using the shared sanitizer, whose ordinary page keys ignore queries. */
export function canvasPendingSnapshotForPage(snapshot: WebPanePendingSnapshot, url: string) {
  const page = canvasPageKey(url)
  return redlinePendingSnapshotForPage({ ...snapshot,
    notes: snapshot.notes.filter((note) => note.pageUrl && canvasPageKey(note.pageUrl) === page),
    sent: snapshot.sent?.page === page ? { ...snapshot.sent, page: redlinePageKey(url) } : undefined,
  }, url)
}
