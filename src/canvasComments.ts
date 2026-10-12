import type { CanvasFrame, CanvasSection } from '../shared/canvas-manifest'
import type { CanvasNoteContext } from '../shared/protocol'
import { MAX_QUESTION_SNAPSHOT_BYTES, MAX_RESPONSE_PAYLOAD_BYTES, parseRedlinePageQuestionSnapshot, parseRedlinePageResponse } from '../shared/redline-response'
import { MAX_INSPECT_SELECTOR, MAX_INSPECT_TAG, MAX_INSPECT_TEXT } from '../shared/tile-inspect'
import type { CanvasBounds } from './canvasCamera'

export type CanvasHit = { selector: string; rect: CanvasBounds; label?: string; labelId?: string; tag: string; text?: string }
export type CanvasDraft = { comment?: string; canvas: CanvasNoteContext; hit: CanvasHit; pageUrl: string }

export function readCanvasHit(value: unknown): CanvasHit | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  const r = raw.rect as Record<string, unknown> | undefined
  if (typeof raw.selector !== 'string' || !raw.selector || raw.selector.length > MAX_INSPECT_SELECTOR ||
    !r || !['x', 'y', 'w', 'h'].every((key) => typeof r[key] === 'number' && Number.isFinite(r[key]) && Math.abs(r[key] as number) <= 1_000_000) ||
    (r.w as number) < 0 || (r.h as number) < 0) return null
  for (const key of ['label', 'labelId'] as const) if (raw[key] !== undefined && (typeof raw[key] !== 'string' || !raw[key] || (raw[key] as string).length > 256)) return null
  return { selector: raw.selector, rect: r as CanvasBounds,
    ...(typeof raw.label === 'string' ? { label: raw.label } : {}), ...(typeof raw.labelId === 'string' ? { labelId: raw.labelId } : {}),
    tag: typeof raw.tag === 'string' && raw.tag.length > 0 && raw.tag.length <= MAX_INSPECT_TAG ? raw.tag : 'element',
    ...(typeof raw.text === 'string' && raw.text.length <= MAX_INSPECT_TEXT ? { text: raw.text } : {}) }
}

/** Same envelope bounds and parser order as Chromium's Runtime.bindingCalled. Questions are ignored in M2b. */
export function canvasRedlineResponse(payload: unknown) {
  if (typeof payload !== 'string') return null
  const bytes = new TextEncoder().encode(payload).byteLength
  if (bytes > Math.max(MAX_QUESTION_SNAPSHOT_BYTES, MAX_RESPONSE_PAYLOAD_BYTES)) return null
  let value: unknown
  try { value = JSON.parse(payload) } catch { return null }
  if (parseRedlinePageQuestionSnapshot(value)) return null
  return bytes <= MAX_RESPONSE_PAYLOAD_BYTES ? parseRedlinePageResponse(value) : null
}

export function canvasNoteContext(frame: CanvasFrame, sections: CanvasSection[], point: { x: number; y: number }, label?: string, labelId?: string): CanvasNoteContext {
  const section = sections.find((section) => section.frames.includes(frame.id))
  return { frameId: frame.id, point, frameTitle: frame.title.slice(0, 1_024),
    ...(label ? { label } : {}), ...(labelId ? { labelId } : {}),
    ...(section ? { section: section.title.slice(0, 256), status: section.status, ...(section.ticket ? { ticket: section.ticket.slice(0, 256) } : {}) } : {}),
    ...(frame.focus !== undefined ? { focus: frame.focus } : {}), interactive: frame.interactive ?? false }
}
