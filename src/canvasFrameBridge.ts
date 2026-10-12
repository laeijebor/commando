import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { CanvasFrame } from '../shared/canvas-manifest'
import { readCanvasLabels, type CanvasLabelReports } from './canvasLabels'

export function canvasFrameUrl(baseUrl: string, frame: CanvasFrame, revision = 0): string {
  const query = new URLSearchParams({ 'canvas-frame': frame.id })
  if (revision) query.set('canvas-reload', String(revision))
  return baseUrl + frame.src.split('/').map(encodeURIComponent).join('/') + '?' + query
}

export function useCanvasFrameBridge(frames: CanvasFrame[], baseUrl: string, revisions: Record<string, number>) {
  const iframes = useRef(new Map<string, HTMLIFrameElement>())
  const sources = useRef(new Map<string, string>())
  const [reports, setReports] = useState<CanvasLabelReports>({})
  useLayoutEffect(() => {
    const next = new Map(frames.map((frame) => [frame.id, canvasFrameUrl(baseUrl, frame, revisions[frame.id])]))
    const previous = sources.current
    setReports((current) => Object.fromEntries(Object.entries(current).filter(([id]) => next.has(id) && next.get(id) === previous.get(id))))
    sources.current = next
  }, [frames, baseUrl, revisions])
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      const data = event.data
      if (!data || data.source !== 'commando-canvas-frame' || data.type !== 'labels' || typeof data.frameId !== 'string') return
      const iframe = iframes.current.get(data.frameId)
      if (!iframe || !event.source || event.source !== iframe.contentWindow) return
      const labels = readCanvasLabels(data.labels)
      if (labels) setReports((current) => ({ ...current, [data.frameId]: labels }))
    }
    window.addEventListener('message', receive)
    return () => window.removeEventListener('message', receive)
  }, [])
  const register = (id: string, node: HTMLIFrameElement | null) => {
    if (node) iframes.current.set(id, node)
    else iframes.current.delete(id)
  }
  return { reports, register }
}
