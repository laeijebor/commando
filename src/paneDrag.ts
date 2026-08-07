/** What a drag in the pane grid is carrying. */
export type DraggedItem =
  | { kind: 'terminal'; groupId: string; paneId: string }
  | { kind: 'web'; groupId: string; webPaneId: string }

/**
 * Which placement a web-tile drop at (clientX, clientY) over a pane card
 * previews. The card splits along its top-left→bottom-right diagonal: the
 * upper-right triangle anchors the tile to the right, the lower-left
 * anchors it below — equivalently, whichever fractional coordinate is
 * larger wins, which is the "right half → right, bottom half → below"
 * rule with a deterministic corner tie-break.
 */
export function dropPlacementFor(
  rect: { left: number; top: number; width: number; height: number },
  clientX: number,
  clientY: number,
): 'right' | 'below' {
  if (rect.width <= 0 || rect.height <= 0) return 'right'
  const x = (clientX - rect.left) / rect.width
  const y = (clientY - rect.top) / rect.height
  return x >= y ? 'right' : 'below'
}
