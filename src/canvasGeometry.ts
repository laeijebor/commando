import type { CanvasBounds, CanvasCamera } from './canvasCamera'

export function canvasLabelBounds(frame: { x: number; y: number }, rect: CanvasBounds): CanvasBounds {
  return { ...rect, x: frame.x + rect.x, y: frame.y + rect.y }
}
export function projectCanvasRect(frame: { x: number; y: number }, rect: CanvasBounds, camera: CanvasCamera): CanvasBounds {
  const bounds = canvasLabelBounds(frame, rect)
  return { x: camera.x + bounds.x * camera.scale, y: camera.y + bounds.y * camera.scale, w: bounds.w * camera.scale, h: bounds.h * camera.scale }
}
export function flyToCanvasRect(bounds: CanvasBounds, viewport: { w: number; h: number }, padding = 48): CanvasCamera {
  const scale = Math.min(1, Math.max(1, viewport.w - padding * 2) / Math.max(1, bounds.w), Math.max(1, viewport.h - padding * 2) / Math.max(1, bounds.h))
  return { scale, x: viewport.w / 2 - (bounds.x + bounds.w / 2) * scale, y: viewport.h / 2 - (bounds.y + bounds.h / 2) * scale }
}
function nearestEdge(box: CanvasBounds, point: { x: number; y: number }) {
  const x = Math.max(box.x, Math.min(box.x + box.w, point.x)), y = Math.max(box.y, Math.min(box.y + box.h, point.y))
  return [{ x: box.x, y }, { x: box.x + box.w, y }, { x, y: box.y }, { x, y: box.y + box.h }]
    .sort((a, b) => Math.hypot(a.x - point.x, a.y - point.y) - Math.hypot(b.x - point.x, b.y - point.y))[0]
}
export function canvasConnector(note: CanvasBounds, target: CanvasBounds) {
  const end = nearestEdge(target, { x: note.x + note.w / 2, y: note.y + note.h / 2 })
  const start = nearestEdge(note, end)
  const dx = end.x - start.x, dy = end.y - start.y
  const horizontal = end.x === target.x || end.x === target.x + target.w
  const bend = horizontal ? Math.max(60, Math.abs(dx) / 2) * Math.sign(dx || 1) : Math.max(60, Math.abs(dy) / 2) * Math.sign(dy || 1)
  const path = horizontal
    ? `M ${start.x} ${start.y} C ${start.x + bend} ${start.y}, ${end.x - bend} ${end.y}, ${end.x} ${end.y}`
    : `M ${start.x} ${start.y} C ${start.x} ${start.y + bend}, ${end.x} ${end.y - bend}, ${end.x} ${end.y}`
  return { path, end }
}
