import { useLayoutEffect, useRef, useState } from 'react'
import type { CanvasFrame } from '../shared/canvas-manifest'
import type { CanvasCamera } from './canvasCamera'
import { canvasHotspotDots, type CanvasHotspotReports } from './canvasHotspots'

const MARGIN = 8

/** Screen-space tooltip above (x, y), kept inside the canvas viewport. */
export function CanvasTip({ text, x, y }: { text: string; x: number; y: number }) {
  const ref = useRef<HTMLSpanElement>(null)
  const [place, setPlace] = useState<{ left: number; below: boolean } | null>(null)
  useLayoutEffect(() => {
    const node = ref.current, parent = node?.parentElement
    if (!node || !parent) return
    const half = node.offsetWidth / 2
    setPlace({ left: Math.max(half + MARGIN, Math.min(x, parent.clientWidth - half - MARGIN)), below: y - node.offsetHeight - 2 * MARGIN < 0 })
  }, [text, x, y])
  return <span ref={ref} className={`canvas-tip${place?.below ? ' is-below' : ''}`} role="tooltip"
    style={{ left: place?.left ?? x, top: y, visibility: place ? undefined : 'hidden' }}>{text}</span>
}

/** Pulsing dots marking the controls that work inside interactive frames. */
export function CanvasHotspots({ frames, reports, camera }: { frames: CanvasFrame[]; reports: CanvasHotspotReports; camera: CanvasCamera }) {
  const [hovered, setHovered] = useState<string | null>(null)
  const dots = canvasHotspotDots(frames, reports, camera)
  const tip = dots.find((dot) => dot.key === hovered && dot.tip)
  if (!dots.length) return null
  return <div className="canvas-overlay">
    {dots.map((dot) => <span key={dot.key} className={`canvas-hotspot${dot.tip ? ' has-tip' : ''}`} style={{ left: dot.x, top: dot.y }}
      role={dot.tip ? 'note' : undefined} aria-label={dot.tip} aria-hidden={dot.tip ? undefined : true}
      onPointerEnter={() => setHovered(dot.key)} onPointerLeave={() => setHovered(null)} />)}
    {tip && <CanvasTip key={tip.key} text={tip.tip!} x={tip.x} y={tip.y - 6} />}
  </div>
}
