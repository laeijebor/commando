import { canvasNoteContext } from '@commando/canvas-feedback'
import type { CanvasFrame, CanvasSection } from '@commando/canvas-manifest'
import type { CanvasNoteContext } from '@commando/protocol'

import type { TileInspectSuccess } from '../protocol'
import type { NativeTileAnchor } from './bridge'

/**
 * A frame comment's anchor, as the desktop canvas builds it: the tap's
 * position in the frame (clamped to the frame's size, since the phone lays a
 * frame out at its own width) and the label around the element.
 */
export function frameCommentContext(
  frame: CanvasFrame,
  sections: CanvasSection[],
  target: TileInspectSuccess & { anchor?: NativeTileAnchor },
): CanvasNoteContext {
  const raw = target.anchor?.point ?? { x: target.rect.x + target.rect.width / 2, y: target.rect.y + target.rect.height / 2 }
  const point = { x: Math.round(Math.min(frame.w, Math.max(0, raw.x))), y: Math.round(Math.min(frame.h, Math.max(0, raw.y))) }
  return canvasNoteContext(frame, sections, point, target.anchor?.label, target.anchor?.labelId)
}
