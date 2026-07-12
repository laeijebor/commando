import type {
  GroupLayoutPreset,
  PaneLayoutCapacity,
} from '../shared/protocol.js'

type Direction = 'horizontal' | 'vertical'

type LayoutNode =
  | { kind: 'pane'; pane: PaneLayoutCapacity }
  | { kind: 'split'; direction: Direction; children: LayoutNode[] }

type Size = { width: number; height: number }

export type BuiltTmuxLayout = {
  cols: number
  rows: number
  layout: string
}

const MAX_TMUX_DIMENSION = 10_000
const MAX_LAYOUT_BYTES = 8_192

const pane = (value: PaneLayoutCapacity): LayoutNode => ({ kind: 'pane', pane: value })
const horizontal = (...children: LayoutNode[]): LayoutNode => ({
  kind: 'split',
  direction: 'horizontal',
  children,
})
const vertical = (...children: LayoutNode[]): LayoutNode => ({
  kind: 'split',
  direction: 'vertical',
  children,
})
const row = (children: LayoutNode[]): LayoutNode =>
  children.length === 1 ? children[0] : horizontal(...children)

function chunks<T>(values: T[], size: number): T[][] {
  const result: T[][] = []
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size))
  }
  return result
}

function topology(
  preset: GroupLayoutPreset,
  capacities: PaneLayoutCapacity[],
  stacked: boolean,
): LayoutNode {
  const panes = capacities.map(pane)
  if (panes.length === 0) throw new Error('Authoritative layout requires at least one pane')
  if (panes.length === 1) return panes[0]
  if (stacked) return vertical(...panes)

  switch (preset) {
    case 'equal-grid':
      if (panes.length <= 3) return horizontal(...panes)
      if (panes.length === 4) {
        return vertical(horizontal(...panes.slice(0, 2)), horizontal(...panes.slice(2)))
      }
      return vertical(...chunks(panes, 3).map(row))
    case 'full-then-halves':
      return vertical(panes[0], ...chunks(panes.slice(1), 2).map(row))
    case 'two-full-two-halves':
      return vertical(
        panes[0],
        panes[1],
        ...chunks(panes.slice(2), 2).map(row),
      )
    case 'lead-and-stack':
      if (panes.length === 2) return horizontal(...panes)
      if (panes.length === 3) return horizontal(panes[0], vertical(panes[1], panes[2]))
      return vertical(
        horizontal(panes[0], vertical(panes[1], panes[2])),
        ...chunks(panes.slice(3), 3).map(row),
      )
  }
}

function maximumSize(node: LayoutNode): Size {
  if (node.kind === 'pane') return { width: node.pane.cols, height: node.pane.rows }
  const sizes = node.children.map(maximumSize)
  return node.direction === 'horizontal'
    ? {
        width: sizes.reduce((total, size) => total + size.width, sizes.length - 1),
        height: Math.min(...sizes.map((size) => size.height)),
      }
    : {
        width: Math.min(...sizes.map((size) => size.width)),
        height: sizes.reduce((total, size) => total + size.height, sizes.length - 1),
      }
}

function minimumSize(node: LayoutNode): Size {
  if (node.kind === 'pane') return { width: 2, height: 1 }
  const sizes = node.children.map(minimumSize)
  return node.direction === 'horizontal'
    ? {
        width: sizes.reduce((total, size) => total + size.width, sizes.length - 1),
        height: Math.max(...sizes.map((size) => size.height)),
      }
    : {
        width: Math.max(...sizes.map((size) => size.width)),
        height: sizes.reduce((total, size) => total + size.height, sizes.length - 1),
      }
}

function allocate(total: number, minima: number[], maxima: number[]): number[] {
  const result = [...minima]
  let remaining = total - result.reduce((sum, value) => sum + value, 0)
  if (remaining < 0 || total > maxima.reduce((sum, value) => sum + value, 0)) {
    throw new Error('Browser pane capacities cannot form a valid tmux layout')
  }
  while (remaining > 0) {
    let changed = false
    for (let index = 0; index < result.length && remaining > 0; index += 1) {
      if (result[index] >= maxima[index]) continue
      result[index] += 1
      remaining -= 1
      changed = true
    }
    if (!changed) throw new Error('Browser pane capacities cannot form a valid tmux layout')
  }
  return result
}

function serialize(
  node: LayoutNode,
  width: number,
  height: number,
  left: number,
  top: number,
): string {
  const dimensions = `${width}x${height},${left},${top}`
  if (node.kind === 'pane') return `${dimensions},${node.pane.paneId.slice(1)}`

  const maxima = node.children.map(maximumSize)
  const minima = node.children.map(minimumSize)
  if (node.direction === 'horizontal') {
    const widths = allocate(
      width - (node.children.length - 1),
      minima.map((size) => size.width),
      maxima.map((size) => size.width),
    )
    let childLeft = left
    const children = node.children.map((child, index) => {
      const value = serialize(child, widths[index], height, childLeft, top)
      childLeft += widths[index] + 1
      return value
    })
    return `${dimensions}{${children.join(',')}}`
  }

  const heights = allocate(
    height - (node.children.length - 1),
    minima.map((size) => size.height),
    maxima.map((size) => size.height),
  )
  let childTop = top
  const children = node.children.map((child, index) => {
    const value = serialize(child, width, heights[index], left, childTop)
    childTop += heights[index] + 1
    return value
  })
  return `${dimensions}[${children.join(',')}]`
}

function checksum(body: string): string {
  let value = 0
  for (const byte of Buffer.from(body, 'ascii')) {
    value = ((value >>> 1) | ((value & 1) << 15)) & 0xffff
    value = (value + byte) & 0xffff
  }
  return value.toString(16).padStart(4, '0')
}

export function buildTmuxLayout(
  preset: GroupLayoutPreset,
  capacities: PaneLayoutCapacity[],
  stacked: boolean,
): BuiltTmuxLayout {
  const tree = topology(preset, capacities, stacked)
  const size = maximumSize(tree)
  const minimum = minimumSize(tree)
  if (
    size.width < minimum.width ||
    size.height < minimum.height ||
    size.width > MAX_TMUX_DIMENSION ||
    size.height > MAX_TMUX_DIMENSION
  ) {
    throw new Error('Browser pane capacities exceed tmux layout limits')
  }
  const body = serialize(tree, size.width, size.height, 0, 0)
  if (Buffer.byteLength(body, 'ascii') > MAX_LAYOUT_BYTES) {
    throw new Error('Generated tmux layout is too large')
  }
  return {
    cols: size.width,
    rows: size.height,
    layout: `${checksum(body)},${body}`,
  }
}
