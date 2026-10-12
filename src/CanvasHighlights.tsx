import type { CanvasFrame } from '../shared/canvas-manifest'
import type { CanvasCamera } from './canvasCamera'
import { projectCanvasRect } from './canvasGeometry'
import { resolveCanvasLabel, sameLabel, type CanvasLabelRef, type CanvasLabelReports } from './canvasLabels'

export function CanvasHighlights({ frames, reports, camera, selected, hovered }: {
  frames: CanvasFrame[]; reports: CanvasLabelReports; camera: CanvasCamera; selected: CanvasLabelRef | null; hovered: CanvasLabelRef | null
}) {
  return <div className="canvas-overlay" aria-hidden="true">{[selected, sameLabel(selected, hovered) ? null : hovered].map((ref, index) => {
    const frame = frames.find((frame) => frame.id === ref?.frameId), label = resolveCanvasLabel(ref, reports)
    if (!frame || !label) return null
    const rect = projectCanvasRect(frame, label.rect, camera)
    return <div key={index} className={`canvas-highlight${index ? ' is-hover' : ''}`} style={{ left: rect.x - 3, top: rect.y - 3, width: rect.w + 6, height: rect.h + 6 }}>
      {!index && <b>{label.name}</b>}
    </div>
  })}</div>
}
