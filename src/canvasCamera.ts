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

export const canvasTransform = (camera: CanvasCamera) => `translate(${camera.x}px, ${camera.y}px) scale(${camera.scale})`

/** The camera lives outside React state: a pan or zoom must not re-render the
 * whole canvas tree. Subscribers (the world transform, screen-space overlays)
 * update themselves; everything else reads `get()` when it needs the camera. */
export type CanvasCameraStore = {
  get: () => CanvasCamera
  set: (next: CanvasCamera | ((current: CanvasCamera) => CanvasCamera)) => void
  subscribe: (listener: () => void) => () => void
}
export function createCanvasCameraStore(initial: CanvasCamera): CanvasCameraStore {
  let camera = initial
  const listeners = new Set<() => void>()
  return {
    get: () => camera,
    set: (next) => {
      const value = typeof next === 'function' ? next(camera) : next
      if (value.x === camera.x && value.y === camera.y && value.scale === camera.scale) return
      camera = value
      for (const listener of [...listeners]) listener()
    },
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
  }
}
