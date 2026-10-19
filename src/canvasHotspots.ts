import type { CanvasFrame } from '../shared/canvas-manifest'
import type { CanvasBounds, CanvasCamera } from './canvasCamera'

/** A control that works inside an interactive frame; rect is in iframe viewport CSS pixels. */
export type CanvasHotspot = { rect: CanvasBounds; tip?: string; goto?: string }
export type CanvasHotspotReports = Record<string, CanvasHotspot[]>
export type CanvasHotspotDot = { key: string; x: number; y: number; tip?: string }

/** Treat the iframe payload as untrusted; a frame script without hotspot support reports none. */
export function readCanvasHotspots(value: unknown): CanvasHotspot[] {
  if (!Array.isArray(value) || value.length > 500) return []
  const hotspots: CanvasHotspot[] = []
  for (const item of value) {
    if (!item || typeof item !== 'object') return []
    const r = item.rect
    if (!r || !['x', 'y', 'w', 'h'].every((key) => typeof r[key] === 'number' && Number.isFinite(r[key]) && Math.abs(r[key]) <= 1_000_000) || r.w < 0 || r.h < 0) return []
    if ((item.tip !== undefined && (typeof item.tip !== 'string' || item.tip.length > 500)) ||
      (item.goto !== undefined && (typeof item.goto !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(item.goto)))) return []
    hotspots.push({ rect: { x: r.x, y: r.y, w: r.w, h: r.h }, tip: item.tip || undefined, goto: item.goto })
  }
  return hotspots
}

/**
 * Screen-space dots at the top-right corner of each visible hotspot in an interactive frame.
 * The frame script reports only the visible part of each control; anything outside the frame or too small at the current zoom gets no dot.
 */
export function canvasHotspotDots(frames: CanvasFrame[], reports: CanvasHotspotReports, camera: CanvasCamera): CanvasHotspotDot[] {
  const dots: CanvasHotspotDot[] = []
  for (const frame of frames) {
    if (!frame.interactive || !Object.hasOwn(reports, frame.id)) continue
    reports[frame.id].forEach(({ rect, tip, goto }, index) => {
      const left = Math.max(rect.x, 0), top = Math.max(rect.y, 0)
      const right = Math.min(rect.x + rect.w, frame.w), bottom = Math.min(rect.y + rect.h, frame.h)
      // Below ~14px the 10px dot would cover the control itself.
      if (right <= left || bottom <= top || Math.min(right - left, bottom - top) * camera.scale < 14) return
      const target = goto ? frames.find((f) => f.id === goto) : undefined
      dots.push({
        key: `${frame.id}:${index}`,
        x: camera.x + (frame.x + right) * camera.scale,
        y: camera.y + (frame.y + top) * camera.scale,
        tip: tip ?? (target ? `Opens “${target.title}”` : undefined),
      })
    })
  }
  return dots
}
