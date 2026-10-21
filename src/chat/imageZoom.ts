/**
 * Zoom and pan for the enlarged image. The image is laid out at its fitted
 * size times `scale` (a real size, not a CSS transform, so an SVG redraws
 * sharp), centred in the viewport and moved by `x`/`y`.
 */
export type ImageZoom = { scale: number; x: number; y: number }
export type Size = { w: number; h: number }

export const FIT: ImageZoom = { scale: 1, x: 0, y: 0 }
export const MAX_ZOOM = 16

/** The size an image opens at: whole on screen, never enlarged past its own pixels. */
export function fitSize(natural: Size, room: Size): Size {
  if (natural.w <= 0 || natural.h <= 0) return { w: 0, h: 0 }
  const factor = Math.min(1, room.w / natural.w, room.h / natural.h)
  return { w: natural.w * factor, h: natural.h * factor }
}

/** Keeps a zoomed image covering the viewport where it is larger than it, and centred where it is not. */
export function clampPan(zoom: ImageZoom, fitted: Size, viewport: Size): ImageZoom {
  const limit = (length: number, room: number) => Math.max(0, (length * zoom.scale - room) / 2)
  // `+ 0` turns -0 into 0.
  const clamp = (value: number, max: number) => Math.min(max, Math.max(-max, value)) + 0
  return { scale: zoom.scale, x: clamp(zoom.x, limit(fitted.w, viewport.w)), y: clamp(zoom.y, limit(fitted.h, viewport.h)) }
}

/**
 * Zooms to `scale` keeping the image point under `point` (relative to the
 * viewport's centre) where it is, then clamps the pan.
 */
export function zoomAround(zoom: ImageZoom, scale: number, point: { x: number; y: number }, fitted: Size, viewport: Size): ImageZoom {
  const next = Math.min(MAX_ZOOM, Math.max(1, scale))
  const ratio = next / zoom.scale
  return clampPan({ scale: next, x: point.x - (point.x - zoom.x) * ratio, y: point.y - (point.y - zoom.y) * ratio }, fitted, viewport)
}

export function panBy(zoom: ImageZoom, dx: number, dy: number, fitted: Size, viewport: Size): ImageZoom {
  return clampPan({ ...zoom, x: zoom.x + dx, y: zoom.y + dy }, fitted, viewport)
}
