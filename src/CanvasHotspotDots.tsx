import type { CanvasFrame } from '../shared/canvas-manifest'
import type { CanvasCamera } from './canvasCamera'
import { canvasHotspotDots, type CanvasHotspotReports } from './canvasHotspots'

/** Pulsing dots marking the controls that work inside interactive frames. */
export function CanvasHotspots({ frames, reports, camera }: { frames: CanvasFrame[]; reports: CanvasHotspotReports; camera: CanvasCamera }) {
  const dots = canvasHotspotDots(frames, reports, camera)
  if (!dots.length) return null
  return <div className="canvas-overlay canvas-hotspots">{dots.map((dot) => <span key={dot.key} className={`canvas-hotspot${dot.tip ? ' has-tip' : ''}`}
    style={{ left: dot.x, top: dot.y }} role={dot.tip ? 'note' : undefined} aria-label={dot.tip} aria-hidden={dot.tip ? undefined : true}>
    {dot.tip && <span className="canvas-tip">{dot.tip}</span>}
  </span>)}</div>
}
