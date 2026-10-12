export type CanvasCamera = { x: number; y: number; scale: number }
export type CanvasBounds = { x: number; y: number; w: number; h: number }
export const clampCanvasScale = (scale: number): number => Math.min(2, Math.max(0.1, scale))

export function zoomAt(camera: CanvasCamera, factor: number, point: { x: number; y: number }): CanvasCamera {
  const scale = clampCanvasScale(camera.scale * factor)
  return { scale, x: point.x - (point.x - camera.x) * scale / camera.scale, y: point.y - (point.y - camera.y) * scale / camera.scale }
}

export function fitCanvas(bounds: CanvasBounds, viewport: { w: number; h: number }, padding = 24): CanvasCamera {
  const scale = clampCanvasScale(Math.min(Math.max(1, viewport.w - padding * 2) / Math.max(1, bounds.w), Math.max(1, viewport.h - padding * 2) / Math.max(1, bounds.h)))
  return { scale, x: (viewport.w - bounds.w * scale) / 2 - bounds.x * scale, y: (viewport.h - bounds.h * scale) / 2 - bounds.y * scale }
}

export function unionCanvasBounds(boxes: readonly CanvasBounds[]): CanvasBounds {
  if (!boxes.length) return { x: 0, y: 0, w: 390, h: 844 }
  const x = Math.min(...boxes.map((b) => b.x)), y = Math.min(...boxes.map((b) => b.y))
  return { x, y, w: Math.max(...boxes.map((b) => b.x + b.w)) - x, h: Math.max(...boxes.map((b) => b.y + b.h)) - y }
}
