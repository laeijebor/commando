import type { LayoutSpec } from './protocol.js'

export type WindowLayoutPane = {
  kind: 'pane'
  paneId: string
  cols: number
  rows: number
  left: number
  top: number
}

export type WindowLayoutSplit = {
  kind: 'split'
  direction: 'row' | 'column'
  cols: number
  rows: number
  left: number
  top: number
  children: WindowLayoutNode[]
}

export type WindowLayoutNode = WindowLayoutPane | WindowLayoutSplit

export const MAX_LAYOUT_SPEC_DEPTH = 8
export const MAX_LAYOUT_SPEC_PANES = 32

/**
 * Parses a tmux `#{window_layout}` string (e.g. `bb62,208x50,0,0{104x50,0,0,0,103x50,105,0,1}`)
 * into the split tree tmux maintains for the window. Returns null on malformed input.
 */
export function parseWindowLayout(input: string): WindowLayoutNode | null {
  const match = /^[0-9a-f]{4},([\s\S]*)$/.exec(input)
  if (!match) return null
  const body = match[1]
  let index = 0

  const readInteger = (): number | null => {
    const start = index
    while (index < body.length && body[index] >= '0' && body[index] <= '9') index += 1
    if (index === start || index - start > 6) return null
    return Number(body.slice(start, index))
  }

  const expect = (character: string): boolean => {
    if (body[index] !== character) return false
    index += 1
    return true
  }

  const readNode = (depth: number): WindowLayoutNode | null => {
    if (depth > MAX_LAYOUT_SPEC_DEPTH) return null
    const cols = readInteger()
    if (cols === null || !expect('x')) return null
    const rows = readInteger()
    if (rows === null || !expect(',')) return null
    const left = readInteger()
    if (left === null || !expect(',')) return null
    const top = readInteger()
    if (top === null) return null
    if (cols < 1 || rows < 1) return null

    const next = body[index]
    if (next === '{' || next === '[') {
      const closing = next === '{' ? '}' : ']'
      const direction = next === '{' ? 'row' : 'column'
      index += 1
      const children: WindowLayoutNode[] = []
      for (;;) {
        const child = readNode(depth + 1)
        if (!child) return null
        children.push(child)
        if (body[index] === ',') {
          index += 1
          continue
        }
        if (expect(closing)) break
        return null
      }
      if (children.length < 2) return null
      return { kind: 'split', direction, cols, rows, left, top, children }
    }

    if (!expect(',')) return null
    const paneNumber = readInteger()
    if (paneNumber === null) return null
    return { kind: 'pane', paneId: `%${paneNumber}`, cols, rows, left, top }
  }

  const root = readNode(1)
  if (!root || index !== body.length) return null
  return root
}

export function layoutTreePanes(node: WindowLayoutNode): WindowLayoutPane[] {
  if (node.kind === 'pane') return [node]
  return node.children.flatMap(layoutTreePanes)
}

/**
 * Prunes the tree to the given panes, collapsing splits left with a single child.
 * Returns null when none of the requested panes exist in the tree.
 */
export function filterLayoutTree(
  node: WindowLayoutNode,
  keep: ReadonlySet<string>,
): WindowLayoutNode | null {
  if (node.kind === 'pane') return keep.has(node.paneId) ? node : null
  const children = node.children
    .map((child) => filterLayoutTree(child, keep))
    .filter((child): child is WindowLayoutNode => child !== null)
  if (children.length === 0) return null
  if (children.length === 1) return children[0]
  return { ...node, children }
}

/**
 * Converts a layout tree into the wire spec, optionally overriding leaf sizes
 * (e.g. with cell capacities measured from the DOM).
 */
export function layoutSpecFromTree(
  node: WindowLayoutNode,
  sizes?: ReadonlyMap<string, { cols: number; rows: number }>,
): LayoutSpec {
  if (node.kind === 'pane') {
    const size = sizes?.get(node.paneId)
    return {
      kind: 'pane',
      paneId: node.paneId,
      cols: size?.cols ?? node.cols,
      rows: size?.rows ?? node.rows,
    }
  }
  return {
    kind: 'split',
    direction: node.direction,
    children: node.children.map((child) => layoutSpecFromTree(child, sizes)),
  }
}

export function layoutSpecPaneIds(spec: LayoutSpec): string[] {
  if (spec.kind === 'pane') return [spec.paneId]
  return spec.children.flatMap(layoutSpecPaneIds)
}

/**
 * Stable key for the structure of a layout (split nesting and pane identity,
 * ignoring sizes). Two layouts with the same key differ only in geometry.
 */
export function layoutShapeKey(node: WindowLayoutNode | LayoutSpec): string {
  if (node.kind === 'pane') return node.paneId
  return `${node.direction === 'row' ? '{' : '['}${node.children.map(layoutShapeKey).join(',')}${node.direction === 'row' ? '}' : ']'}`
}
