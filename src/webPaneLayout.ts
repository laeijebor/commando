import type { WebPane, WebPanePlacement } from '../shared/protocol'
import { resolveAutoPlacement } from '../shared/web-pane-placement'
import {
  layoutTreePanes,
  type WindowLayoutNode,
  type WindowLayoutPane,
} from '../shared/window-layout'

/**
 * Web pane tiles live only in the rendered layout tree: their leaves carry the
 * web pane id (`w-…`) in the paneId slot, which can never collide with a tmux
 * pane id (`%N`). Every path that writes a layout back to tmux re-derives its
 * tree from tmux's own layout string, so these leaves are structurally unable
 * to leak into a LayoutSpec — this module only builds the display tree.
 */
export function isWebPaneLeafId(id: string): boolean {
  return id.startsWith('w-')
}

/**
 * The daemon resolves 'auto' to a concrete direction when a pane opens, so
 * this fallback only fires for records from an older daemon. Deriving the
 * direction from the anchor's live geometry is what caused layout thrash:
 * the applied layout halves the anchor along the chosen axis, which can
 * flip the next derivation forever.
 */
function resolvePlacement(
  placement: WebPanePlacement,
  anchor: { cols: number; rows: number },
): 'right' | 'below' {
  if (placement !== 'auto') return placement
  return resolveAutoPlacement(anchor)
}

function webLeaf(
  webPane: WebPane,
  cols: number,
  rows: number,
  left: number,
  top: number,
): WindowLayoutPane {
  return { kind: 'pane', paneId: webPane.id, cols, rows, left, top }
}

function splitExtent(extent: number): [anchor: number, web: number] {
  const anchor = Math.max(1, Math.ceil(extent / 2))
  return [anchor, Math.max(1, extent - anchor)]
}

function splitAnchor(anchor: WindowLayoutPane, webPane: WebPane): WindowLayoutNode {
  const placement = resolvePlacement(webPane.placement, anchor)
  if (placement === 'right') {
    const [anchorCols, webCols] = splitExtent(anchor.cols)
    return {
      kind: 'split',
      direction: 'row',
      cols: anchor.cols,
      rows: anchor.rows,
      left: anchor.left,
      top: anchor.top,
      children: [
        { ...anchor, cols: anchorCols },
        webLeaf(webPane, webCols, anchor.rows, anchor.left + anchorCols, anchor.top),
      ],
    }
  }
  const [anchorRows, webRows] = splitExtent(anchor.rows)
  return {
    kind: 'split',
    direction: 'column',
    cols: anchor.cols,
    rows: anchor.rows,
    left: anchor.left,
    top: anchor.top,
    children: [
      { ...anchor, rows: anchorRows },
      webLeaf(webPane, anchor.cols, webRows, anchor.left, anchor.top + anchorRows),
    ],
  }
}

/**
 * A tile shares its anchor's rendered footprint, so the terminal reports only
 * its share of that space. Restore the full footprint before writing measured
 * terminal capacities back to tmux; otherwise each measurement cycle would
 * halve the anchor again.
 */
export function restoreWebPaneAnchorSizes(
  tree: WindowLayoutNode,
  webPanes: readonly WebPane[],
  sizes: ReadonlyMap<string, { cols: number; rows: number }>,
): Map<string, { cols: number; rows: number }> {
  const anchors = new Map(layoutTreePanes(tree).map((pane) => [pane.paneId, pane]))
  const restored = new Map(
    [...sizes].map(([paneId, size]) => [paneId, { ...size }]),
  )

  for (const webPane of webPanes) {
    const anchor = anchors.get(webPane.anchorPaneId)
    const size = restored.get(webPane.anchorPaneId)
    if (!anchor || !size) continue
    const placement = resolvePlacement(webPane.placement, anchor)
    if (placement === 'right') {
      const [anchorCols] = splitExtent(anchor.cols)
      size.cols = Math.max(1, Math.round(size.cols * anchor.cols / anchorCols))
      anchors.set(anchor.paneId, { ...anchor, cols: anchorCols })
    } else {
      const [anchorRows] = splitExtent(anchor.rows)
      size.rows = Math.max(1, Math.round(size.rows * anchor.rows / anchorRows))
      anchors.set(anchor.paneId, { ...anchor, rows: anchorRows })
    }
  }

  return restored
}

function insertOne(
  node: WindowLayoutNode,
  webPane: WebPane,
): { node: WindowLayoutNode; inserted: boolean } {
  if (node.kind === 'pane') {
    if (node.paneId !== webPane.anchorPaneId) return { node, inserted: false }
    return { node: splitAnchor(node, webPane), inserted: true }
  }
  for (let index = 0; index < node.children.length; index += 1) {
    const attempt = insertOne(node.children[index], webPane)
    if (attempt.inserted) {
      const children = [...node.children]
      children[index] = attempt.node
      return { node: { ...node, children }, inserted: true }
    }
  }
  return { node, inserted: false }
}

/** When the anchor is not in the visible tree, dock the tile to the right edge. */
function appendAtRoot(tree: WindowLayoutNode, webPane: WebPane): WindowLayoutNode {
  const webCols = Math.max(1, Math.round(tree.cols / 3))
  return {
    kind: 'split',
    direction: 'row',
    cols: tree.cols + webCols,
    rows: tree.rows,
    left: tree.left,
    top: tree.top,
    children: [tree, webLeaf(webPane, webCols, tree.rows, tree.left + tree.cols, tree.top)],
  }
}

/**
 * Builds the display tree for a window: each web pane splits its anchor leaf
 * (right/below/auto), falling back to a root-level dock when the anchor pane
 * is not part of the visible tree.
 */
export function insertWebPaneLeaves(
  tree: WindowLayoutNode,
  webPanes: readonly WebPane[],
): WindowLayoutNode {
  let current = tree
  for (const webPane of webPanes) {
    const attempt = insertOne(current, webPane)
    current = attempt.inserted ? attempt.node : appendAtRoot(current, webPane)
  }
  return current
}
