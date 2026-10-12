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
