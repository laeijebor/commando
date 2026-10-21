import type { CanvasBounds } from './canvasCamera'

/** Gap between stacked notes, the clearance a flipped note needs from other frames, and a new gutter's distance. */
const GAP = 16, CLEARANCE = 40, GUTTER = 80

export type CanvasNoteInput = {
  id: string; x: number; y: number; w: number; h: number; fixed?: boolean
  /** Target frame and, when its label has reported, the label's world rect. */
  frame?: CanvasBounds; label?: CanvasBounds
}
export type CanvasNotePlacement = CanvasBounds & { side?: 'left' | 'right' }

const overlaps = (a: CanvasBounds, b: CanvasBounds) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
const sideOf = (box: CanvasBounds, frame: CanvasBounds) => box.x + box.w <= frame.x ? 'left' as const : box.x >= frame.x + frame.w ? 'right' as const : undefined
/** No other frame within CLEARANCE of a note column at x beside the frame. */
const clear = (x: number, w: number, frame: CanvasBounds, frames: readonly CanvasBounds[]) => {
  const band = { x: x - CLEARANCE, y: frame.y, w: w + CLEARANCE * 2, h: frame.h }
  return !frames.some((other) => other !== frame && overlaps(band, other))
}

/**
 * Lays notes out like margin comments. Notes beside their target frame line up with
 * the label they point at, move to the frame side nearest it when there is room, and
 * keep their target order within a column so connectors don't cross. Notes in one
 * column never overlap: each moves the least it can (isotonic regression), then steps
 * past fixed notes. Fixed notes never move; other notes keep their authored x, and
 * notes without a label to line up with aim for their authored y.
 */
export function layoutCanvasNotes(notes: readonly CanvasNoteInput[], frames: readonly CanvasBounds[]): Map<string, CanvasNotePlacement> {
  const placed = notes.map((note, index) => {
    let box: CanvasNotePlacement = { x: note.x, y: note.y, w: note.w, h: note.h }
    if (!note.frame) return { note, index, box, centre: note.y + note.h / 2 }
    const { frame, label } = note
    let side = sideOf(box, frame)
    if (note.fixed) return { note, index, box: { ...box, side }, centre: note.y + note.h / 2 }
    if (side && label) {
      const labelSide = label.x + label.w / 2 < frame.x + frame.w / 2 ? 'left' : 'right'
      if (labelSide !== side) {
        // Mirror across the frame at the same distance, if no other frame is in the way.
        const gap = side === 'left' ? frame.x - (box.x + box.w) : box.x - (frame.x + frame.w)
        const x = labelSide === 'left' ? frame.x - gap - box.w : frame.x + frame.w + gap
        if (clear(x, box.w, frame, frames)) { box = { ...box, x }; side = labelSide }
      }
    }
    box.side = side
    return { note, index, box, centre: side && label ? label.y + label.h / 2 : note.y + note.h / 2 }
  })
  // Columns: notes whose horizontal extents overlap share one vertical stack.
  const columns: Array<typeof placed> = []
  let right = -Infinity
  for (const item of [...placed].sort((a, b) => a.box.x - b.box.x)) {
    if (item.box.x < right) { columns.at(-1)!.push(item); right = Math.max(right, item.box.x + item.box.w) }
    else { columns.push([item]); right = item.box.x + item.box.w }
  }
  for (const column of columns) {
    const obstacles = column.filter((item) => item.note.fixed).map((item) => item.box)
    const movable = column.filter((item) => !item.note.fixed).sort((a, b) => a.centre - b.centre || a.index - b.index)
    const tops = stack(movable.map((item) => ({ top: item.centre - item.box.h / 2, h: item.box.h })))
    let cursor = -Infinity
    movable.forEach((item, i) => {
      let y = Math.max(tops[i], cursor)
      const blocking = () => obstacles.find((o) => y < o.y + o.h + GAP && o.y < y + item.box.h + GAP)
      for (let blocker = blocking(); blocker; blocker = blocking()) y = blocker.y + blocker.h + GAP
      item.box.y = y; cursor = y + item.box.h + GAP
    })
  }
  return new Map(placed.map((item) => [item.note.id, item.box]))
}

/**
 * Where an auto-placed note should sit horizontally: unchanged when it is already
 * beside its frame, otherwise in a clear gutter, preferring its label's side (or the note's).
 */
export function canvasNoteGutterX(note: { x: number; w: number }, frames: readonly CanvasBounds[], frame?: CanvasBounds, label?: CanvasBounds): number {
  if (!frame || sideOf({ ...note, y: 0, h: 0 }, frame)) return note.x
  const anchor = label ? label.x + label.w / 2 : note.x + note.w / 2
  const left = frame.x - GUTTER - note.w, right = frame.x + frame.w + GUTTER
  const sides = anchor < frame.x + frame.w / 2 ? [left, right] : [right, left]
  return sides.find((x) => clear(x, note.w, frame, frames)) ?? left
}


/** Tops closest (least squares) to the wanted tops that keep order with GAP between items. */
export function stack(items: ReadonlyArray<{ top: number; h: number }>): number[] {
  // Shifting each target by the space its predecessors need turns "no overlap" into
  // "non-decreasing", solved exactly by pool-adjacent-violators.
  const offsets: number[] = []
  let offset = 0
  for (const item of items) { offsets.push(offset); offset += item.h + GAP }
  const blocks: Array<{ sum: number; count: number }> = []
  items.forEach((item, i) => {
    blocks.push({ sum: item.top - offsets[i], count: 1 })
    while (blocks.length > 1 && blocks.at(-2)!.sum / blocks.at(-2)!.count > blocks.at(-1)!.sum / blocks.at(-1)!.count) {
      const last = blocks.pop()!, previous = blocks.at(-1)!
      previous.sum += last.sum; previous.count += last.count
    }
  })
  return blocks.flatMap((block) => Array(block.count).fill(block.sum / block.count)).map((value, i) => value + offsets[i])
}

/**
 * Connector for a note beside its frame: a curve to the frame edge level with the
 * target, then a dashed run inside the frame to the label. Returns the end point.
 */
export function canvasNoteConnector(note: CanvasBounds, side: 'left' | 'right', frame: CanvasBounds, target: CanvasBounds) {
  const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))
  const y = clamp(target.y + target.h / 2, frame.y + 12, frame.y + frame.h - 12)
  const startY = clamp(y, note.y + 20, note.y + note.h - 20)
  const startX = side === 'left' ? note.x + note.w : note.x
  const edgeX = side === 'left' ? frame.x : frame.x + frame.w
  const endX = clamp(side === 'left' ? target.x : target.x + target.w, frame.x, frame.x + frame.w)
  const mid = (startX + edgeX) / 2
  return {
    outer: `M ${startX} ${startY} C ${mid} ${startY}, ${mid} ${y}, ${edgeX} ${y}`,
    inner: Math.abs(endX - edgeX) > 1 ? `M ${edgeX} ${y} L ${endX} ${y}` : null,
    end: { x: endX, y },
  }
}
