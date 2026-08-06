/**
 * Resolves an 'auto' web pane placement to a concrete split direction from
 * the anchor pane's cell size. Terminal cells are ~2x taller than wide, so
 * split along the anchor's longer pixel edge so neither half becomes a
 * sliver.
 *
 * The decision must be made ONCE, from the anchor's unsplit geometry, and
 * then stored. Re-deriving it from live geometry oscillates: the applied
 * layout halves the anchor along the chosen axis, which can flip the choice
 * on the next measurement, forever (right ↔ below thrash).
 */
export function resolveAutoPlacement(anchor: {
  cols: number
  rows: number
}): 'right' | 'below' {
  return anchor.cols >= anchor.rows * 2 ? 'right' : 'below'
}
