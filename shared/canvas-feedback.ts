import { CANVAS_STATUSES } from './canvas-manifest.js'
import type { CanvasNoteContext } from './protocol.js'

/** Reject malformed context rather than silently losing a pin's anchor. */
export function parseCanvasNoteContext(value: unknown): CanvasNoteContext | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  if (typeof raw.frameId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(raw.frameId)) return null
  const point = raw.point as Record<string, unknown> | undefined
  const coordinate = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= 1_000_000
  if (!point || !coordinate(point.x) || !coordinate(point.y)) return null
  const context: CanvasNoteContext = { frameId: raw.frameId, point: { x: point.x, y: point.y } }
  for (const key of ['threadId', 'label', 'labelId', 'frameTitle', 'section', 'ticket', 'status'] as const) {
    const v = raw[key]
    if (v === undefined) continue
    if (typeof v !== 'string' || !v.trim() || v.length > (key === 'frameTitle' ? 1_024 : 256)) return null
    context[key] = v
  }
  if (context.threadId !== undefined && !/^ct-[0-9a-f]{24}$/.test(context.threadId)) return null
  if (context.status !== undefined && !CANVAS_STATUSES.some((status) => status === context.status)) return null
  if (raw.focus !== undefined) {
    if (!Number.isSafeInteger(raw.focus) || (raw.focus as number) < 1 || (raw.focus as number) > 1_000_000) return null
    context.focus = raw.focus as number
  }
  if (raw.interactive !== undefined) {
    if (typeof raw.interactive !== 'boolean') return null
    context.interactive = raw.interactive
  }
  return context
}

/** Keep frame identity while ignoring reload/query churn; ordinary pages retain their identity. */
export function canvasPageKey(url: string): string {
  try {
    const parsed = new URL(url)
    if (['http:', 'https:'].includes(parsed.protocol)) {
      const frame = parsed.searchParams.get('canvas-frame')
      return `${parsed.origin}${parsed.pathname}${frame && /^[A-Za-z0-9_-]{1,64}$/.test(frame) ? `?canvas-frame=${frame}` : ''}`
    }
  } catch { /* Preserve the ordinary textual fallback. */ }
  return url.replace(/[?#].*$/, '')
}

/** Adapt canvas keys to the existing pathname-keyed durable answer store. */
export function canvasSentPageUrl(url: string): string {
  const key = canvasPageKey(url)
  const marker = key.indexOf('?canvas-frame=')
  return marker < 0 ? url : `${key.slice(0, marker)}/.commando-canvas-frame/${key.slice(marker + 14)}`
}
