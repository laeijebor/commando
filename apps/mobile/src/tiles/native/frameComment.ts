import { canvasNoteContext } from '@commando/canvas-feedback'
import type { CanvasFrame, CanvasSection } from '@commando/canvas-manifest'
import type { CanvasNoteContext } from '@commando/protocol'

import type { PendingNoteDraft } from '../api'
import type { TileInspectSuccess } from '../protocol'
import type { NativeTileAnchor } from './bridge'

type Target = TileInspectSuccess & { anchor?: NativeTileAnchor }

/**
 * A frame comment's anchor, in the desktop's terms: frame-local CSS pixels.
 * The phone lays a frame out at its own width, so the tap's viewport position
 * is scaled by the frame's width over the phone's (one factor for both axes,
 * as the layout scales) and clamped to the frame. The label names the element
 * either way.
 */
export function frameCommentContext(frame: CanvasFrame, sections: CanvasSection[], target: Target): CanvasNoteContext {
  const raw = target.anchor?.point ?? { x: target.rect.x + target.rect.width / 2, y: target.rect.y + target.rect.height / 2 }
  const viewportWidth = target.anchor?.viewport?.width
  const scale = viewportWidth ? frame.w / viewportWidth : 1
  const clamp = (value: number, max: number) => Math.round(Math.min(max, Math.max(0, value * scale)))
  return canvasNoteContext(frame, sections, { x: clamp(raw.x, frame.w), y: clamp(raw.y, frame.h) }, target.anchor?.label, target.anchor?.labelId)
}

/**
 * The note a frame comment queues, matching what the desktop canvas sends:
 * the frame's own page URL (`?canvas-frame=<id>`, which the daemon keeps as
 * the thread's source for later replies), the element box in document
 * coordinates, and the canvas anchor.
 */
export function frameCommentNote(
  frame: CanvasFrame,
  sections: CanvasSection[],
  target: Target,
  pageUrl: string,
  comment: string,
): PendingNoteDraft {
  const scroll = target.anchor?.scroll ?? { x: 0, y: 0 }
  return {
    selector: target.selector,
    tag: target.tag,
    ...(target.text !== undefined ? { text: target.text } : {}),
    rect: { ...target.rect, x: target.rect.x + scroll.x, y: target.rect.y + scroll.y },
    comment,
    pageUrl: canvasFramePageUrl(pageUrl, frame.id),
    canvas: frameCommentContext(frame, sections, target),
  }
}

export function canvasFramePageUrl(pageUrl: string, frameId: string): string {
  try {
    const url = new URL(pageUrl)
    url.searchParams.set('canvas-frame', frameId)
    return url.toString()
  } catch {
    return pageUrl
  }
}
