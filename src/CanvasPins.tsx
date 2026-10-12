import type { CanvasFrame } from '../shared/canvas-manifest'
import type { CanvasNoteContext, CanvasThread, WebPanePendingNote } from '../shared/protocol'
import type { CanvasCamera } from './canvasCamera'
import type { CanvasDraft } from './canvasComments'

export type CanvasPin = { id: string; state: 'draft' | 'queued' | 'sent'; canvas: Pick<CanvasNoteContext, 'frameId' | 'point' | 'label' | 'labelId'> }
export function canvasPins(draft: CanvasDraft | null, queued: WebPanePendingNote[], threads: CanvasThread[]): CanvasPin[] {
  return [...threads.map((thread): CanvasPin => ({ id: thread.id, state: 'sent', canvas: thread })),
    ...queued.filter((note) => note.canvas).map((note): CanvasPin => ({ id: `pending:${note.id}`, state: 'queued', canvas: note.canvas! })),
    ...(draft ? [{ id: 'draft', state: 'draft' as const, canvas: draft.canvas }] : [])]
}
export function canvasPinPoint(pin: CanvasPin, frames: CanvasFrame[], camera: CanvasCamera) {
  const frame = frames.find((f) => f.id === pin.canvas.frameId)
  return frame ? { x: camera.x + (frame.x + pin.canvas.point.x) * camera.scale, y: camera.y + (frame.y + pin.canvas.point.y) * camera.scale } : null
}
export function CanvasPins({ pins, frames, camera, active, onOpen }: {
  pins: CanvasPin[]; frames: CanvasFrame[]; camera: CanvasCamera; active: string | null; onOpen: (id: string) => void
}) {
  return <div className="canvas-pins">{pins.map((pin, index) => {
    const point = canvasPinPoint(pin, frames, camera)
    return point && <button key={pin.id} type="button" className={`canvas-pin is-${pin.state}`} style={{ left: point.x, top: point.y }}
      aria-label={`${pin.state} comment ${index + 1}${pin.canvas.label ? ` on ${pin.canvas.label}` : ''}`} aria-pressed={active === pin.id}
      onClick={() => onOpen(pin.id)}>{index + 1}</button>
  })}</div>
}
