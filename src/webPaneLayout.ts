import type { WebPane, WebPanePlacement } from '../shared/protocol'
import type {
  WindowLayoutNode,
  WindowLayoutPane,
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

function resolvePlacement(
  placement: WebPanePlacement,
  anchor: { cols: number; rows: number },
): 'right' | 'below' {
  if (placement !== 'auto') return placement
  // Terminal cells are ~2x taller than wide; split along the anchor's longer
  // pixel edge so neither half becomes a sliver.
  return anchor.cols >= anchor.rows * 2 ? 'right' : 'below'
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

function splitAnchor(anchor: WindowLayoutPane, webPane: WebPane): WindowLayoutNode {
  const placement = resolvePlacement(webPane.placement, anchor)
  if (placement === 'right') {
    const anchorCols = Math.max(1, Math.ceil(anchor.cols / 2))
    const webCols = Math.max(1, anchor.cols - anchorCols)
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
  const anchorRows = Math.max(1, Math.ceil(anchor.rows / 2))
  const webRows = Math.max(1, anchor.rows - anchorRows)
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
