/**
 * The wire shapes of `/ws/web-tiles/:id`, mirrored from `shared/tile-inspect.ts`
 * and `server/web-tile-relay.ts`.
 *
 * They are re-declared here rather than imported because only
 * `shared/protocol.ts` is wired through Metro, Jest and the tsconfig path
 * alias; these are a handful of plain data types, and re-validating what the
 * daemon sends is something the app has to do anyway.
 */

import type { WebPanePendingSnapshot } from '@commando/protocol'

export type TileInspectGrade = 'hover' | 'click'
export type TileInspectRect = { x: number; y: number; width: number; height: number }
export type TileInspectSuccess = {
  ok: true
  selector: string
  tag: string
  rect: TileInspectRect
  text?: string
  snippet?: string
}
export type TileInspectFailure = { ok: false; error: string }
export type TileInspectResult = TileInspectSuccess | TileInspectFailure
export type TileSelectorResolveItem = { noteId: number; selector: string }
export type TileSelectorAnchor = { noteId: number; rect: TileInspectRect }

/** Cap the daemon enforces on one `resolve_selectors` batch. */
export const MAX_SELECTOR_RESOLVE_ITEMS = 50

/** Screencast frame metadata, as CDP's `Page.screencastFrame` reports it. */
export type TileFrameMetadata = {
  deviceWidth?: number
  deviceHeight?: number
  pageScaleFactor?: number
  offsetTop?: number
  scrollOffsetX?: number
  scrollOffsetY?: number
  timestamp?: number
}

export type TileServerMessage =
  | { type: 'frame'; data: string; format?: string; metadata?: TileFrameMetadata }
  | { type: 'ready' }
  | { type: 'engine_error'; message?: string }
  | ({ type: 'pending' } & Partial<WebPanePendingSnapshot>)
  | { type: 'inspect_result'; id: string; ok?: boolean; error?: string; selector?: unknown; tag?: unknown; rect?: unknown; text?: unknown; snippet?: unknown }
  | { type: 'resolve_selectors_result'; id: string; ok?: boolean; error?: string; anchors?: unknown }
  | { type: 'selection_result'; id: string; ok?: boolean; error?: string; text?: unknown }

export type TileClientMessage =
  | { type: 'viewport'; width: number; height: number; deviceScaleFactor: number }
  | { type: 'input'; event: unknown }
  | { type: 'reload' }
  | { type: 'inspect'; id: string; x: number; y: number; grade: TileInspectGrade }
  | { type: 'resolve_selectors'; id: string; items: TileSelectorResolveItem[] }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/**
 * Tolerant parse: anything with a string `type` reaches the reducer, which
 * ignores what it does not know. A newer daemon must never knock the stream
 * over.
 */
export function parseTileServerMessage(raw: unknown): TileServerMessage | null {
  if (typeof raw !== 'string') return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!isRecord(parsed) || typeof parsed.type !== 'string') return null
  return parsed as TileServerMessage
}

function parseRect(value: unknown): TileInspectRect | null {
  if (!isRecord(value)) return null
  if (!finite(value.x) || !finite(value.y) || !finite(value.width) || !finite(value.height)) return null
  return { x: value.x, y: value.y, width: value.width, height: value.height }
}

/** Re-validates an `inspect_result` body; the page controls what is in it. */
export function parseTileInspectResult(message: Record<string, unknown>): TileInspectResult {
  if (message.ok !== true) {
    return { ok: false, error: typeof message.error === 'string' ? message.error : 'Inspect failed' }
  }
  const rect = parseRect(message.rect)
  if (typeof message.selector !== 'string' || message.selector.length === 0 || typeof message.tag !== 'string' || !rect) {
    return { ok: false, error: 'Chromium returned an unusable element' }
  }
  return {
    ok: true,
    selector: message.selector,
    tag: message.tag,
    rect,
    ...(typeof message.text === 'string' ? { text: message.text } : {}),
    ...(typeof message.snippet === 'string' ? { snippet: message.snippet } : {}),
  }
}

/** Re-validates the selector anchors a `resolve_selectors_result` carries. */
export function parseTileSelectorAnchors(value: unknown): TileSelectorAnchor[] {
  if (!Array.isArray(value)) return []
  const anchors: TileSelectorAnchor[] = []
  const seen = new Set<number>()
  for (const item of value) {
    if (anchors.length >= MAX_SELECTOR_RESOLVE_ITEMS || !isRecord(item)) continue
    const noteId = item.noteId
    const rect = parseRect(item.rect)
    if (
      typeof noteId !== 'number' || !Number.isSafeInteger(noteId) || noteId < 1 || seen.has(noteId) ||
      !rect || rect.width <= 0 || rect.height <= 0
    ) continue
    seen.add(noteId)
    anchors.push({ noteId, rect })
  }
  return anchors
}

/** A selector the daemon can look up; in-page redline answers carry a pseudo one. */
export function resolvableSelector(selector: string): boolean {
  return selector.length > 0 && !selector.startsWith('redline:')
}
