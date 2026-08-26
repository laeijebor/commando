import type { WebPane, WebPanePlacement } from '../shared/protocol'
import { resolveAutoPlacement } from '../shared/web-pane-placement'
import {
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

function splitApplied(
  webPane: WebPane,
  anchor: { cols: number; rows: number },
  placement: 'right' | 'below',
): boolean {
  if (webPane.layoutState === 'settled') return true
  if (webPane.layoutState !== 'pending' || !webPane.anchorSize) return false
  const current = placement === 'right' ? anchor.cols : anchor.rows
  const original = placement === 'right' ? webPane.anchorSize.cols : webPane.anchorSize.rows
  return current <= Math.max(1, Math.floor(original * 0.75))
}

function splitTarget(
  target: WindowLayoutNode,
  webPane: WebPane,
  placement: 'right' | 'below',
): WindowLayoutNode {
  if (placement === 'right') {
    const applied = splitApplied(webPane, target, placement)
    const [anchorCols, webCols] = applied
      ? [target.cols, target.cols]
      : splitExtent(target.cols)
    return {
      kind: 'split',
      direction: 'row',
      cols: anchorCols + webCols,
      rows: target.rows,
      left: target.left,
      top: target.top,
      children: [
        { ...target, cols: anchorCols },
        webLeaf(webPane, webCols, target.rows, target.left + anchorCols, target.top),
      ],
    }
  }
  const applied = splitApplied(webPane, target, placement)
  const [anchorRows, webRows] = applied
    ? [target.rows, target.rows]
    : splitExtent(target.rows)
  return {
    kind: 'split',
    direction: 'column',
    cols: target.cols,
    rows: anchorRows + webRows,
    left: target.left,
    top: target.top,
    children: [
      { ...target, rows: anchorRows },
      webLeaf(webPane, target.cols, webRows, target.left, target.top + anchorRows),
    ],
  }
}

type PanePath = {
  nodes: WindowLayoutNode[]
  childIndexes: number[]
}

function pathToPane(node: WindowLayoutNode, paneId: string): PanePath | null {
  if (node.kind === 'pane') {
    return node.paneId === paneId ? { nodes: [node], childIndexes: [] } : null
  }
  for (let index = 0; index < node.children.length; index += 1) {
    const childPath = pathToPane(node.children[index], paneId)
    if (childPath) return {
      nodes: [node, ...childPath.nodes],
      childIndexes: [index, ...childPath.childIndexes],
    }
  }
  return null
}

function replaceAtPath(
  node: WindowLayoutNode,
  childIndexes: readonly number[],
  replacement: WindowLayoutNode,
): WindowLayoutNode {
  if (childIndexes.length === 0 || node.kind === 'pane') return replacement
  const [index, ...rest] = childIndexes
  const children = [...node.children]
  children[index] = replaceAtPath(children[index], rest, replacement)
  return { ...node, children }
}

function insertOne(
  node: WindowLayoutNode,
  webPane: WebPane,
): { node: WindowLayoutNode; inserted: boolean } {
  const path = pathToPane(node, webPane.anchorPaneId)
  if (!path) return { node, inserted: false }
  const anchor = path.nodes[path.nodes.length - 1]
  if (anchor.kind !== 'pane') return { node, inserted: false }
  const placement = resolvePlacement(webPane.placement, anchor)
  const splitDirection = placement === 'right' ? 'row' : 'column'
  let targetDepth = path.nodes.length - 1
  // A perpendicular tmux ancestor constrains every leaf in its subtree to the
  // same cross-axis extent, so the synthetic split must wrap that subtree.
  while (targetDepth > 0) {
    const parent = path.nodes[targetDepth - 1]
    if (parent.kind === 'pane' || parent.direction === splitDirection) break
    targetDepth -= 1
  }
  const replacement = splitTarget(path.nodes[targetDepth], webPane, placement)
  return {
    node: replaceAtPath(node, path.childIndexes.slice(0, targetDepth), replacement),
    inserted: true,
  }
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
