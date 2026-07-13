import type { LayoutSpec } from '../shared/protocol.js'

type Size = { width: number; height: number }

export type BuiltTmuxLayout = {
  cols: number
  rows: number
  layout: string
}

const MAX_TMUX_DIMENSION = 10_000
const MAX_LAYOUT_BYTES = 8_192

function maximumSize(node: LayoutSpec): Size {
  if (node.kind === 'pane') return { width: node.cols, height: node.rows }
  const sizes = node.children.map(maximumSize)
  return node.direction === 'row'
    ? {
        width: sizes.reduce((total, size) => total + size.width, sizes.length - 1),
        height: Math.min(...sizes.map((size) => size.height)),
      }
    : {
        width: Math.min(...sizes.map((size) => size.width)),
        height: sizes.reduce((total, size) => total + size.height, sizes.length - 1),
      }
}

function minimumSize(node: LayoutSpec): Size {
  if (node.kind === 'pane') return { width: 2, height: 1 }
  const sizes = node.children.map(minimumSize)
  return node.direction === 'row'
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

/** Distributes `total` cells proportionally to `targets`, honoring per-child minima. */
function allocateProportional(total: number, targets: number[], minima: number[]): number[] {
  const targetSum = targets.reduce((sum, value) => sum + value, 0)
  if (total < minima.reduce((sum, value) => sum + value, 0) || targetSum <= 0) {
    throw new Error('Window is too small for the requested tmux layout')
  }
  const result = targets.map((target, index) =>
    Math.max(minima[index], Math.floor((target / targetSum) * total)),
  )
  let drift = total - result.reduce((sum, value) => sum + value, 0)
  for (let index = 0; drift !== 0; index = (index + 1) % result.length) {
    if (drift > 0) {
      result[index] += 1
      drift -= 1
    } else if (result[index] > minima[index]) {
      result[index] -= 1
      drift += 1
    }
  }
  return result
}

type SplitSpec = Extract<LayoutSpec, { kind: 'split' }>

function serialize(
  node: LayoutSpec,
  width: number,
  height: number,
  left: number,
  top: number,
  sizeChildren: (node: SplitSpec, span: number) => number[],
): string {
  const dimensions = `${width}x${height},${left},${top}`
  if (node.kind === 'pane') return `${dimensions},${node.paneId.slice(1)}`

  if (node.direction === 'row') {
    const widths = sizeChildren(node, width - (node.children.length - 1))
    let childLeft = left
    const children = node.children.map((child, index) => {
      const value = serialize(child, widths[index], height, childLeft, top, sizeChildren)
      childLeft += widths[index] + 1
      return value
    })
    return `${dimensions}{${children.join(',')}}`
  }

  const heights = sizeChildren(node, height - (node.children.length - 1))
  let childTop = top
  const children = node.children.map((child, index) => {
    const value = serialize(child, width, heights[index], left, childTop, sizeChildren)
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

function finalize(body: string, cols: number, rows: number): BuiltTmuxLayout {
  if (Buffer.byteLength(body, 'ascii') > MAX_LAYOUT_BYTES) {
    throw new Error('Generated tmux layout is too large')
  }
  return { cols, rows, layout: `${checksum(body)},${body}` }
}

/**
 * Serializes a spec whose leaf cols/rows are exact cell capacities. The window
 * is sized to fit them all; used by the authoritative browser-layout sync.
 */
export function buildTmuxLayout(spec: LayoutSpec): BuiltTmuxLayout {
  const size = maximumSize(spec)
  const minimum = minimumSize(spec)
  if (
    size.width < minimum.width ||
    size.height < minimum.height ||
    size.width > MAX_TMUX_DIMENSION ||
    size.height > MAX_TMUX_DIMENSION
  ) {
    throw new Error('Browser pane capacities exceed tmux layout limits')
  }
  const body = serialize(spec, size.width, size.height, 0, 0, (node, span) =>
    allocate(
      span,
      node.children.map((child) =>
        node.direction === 'row' ? minimumSize(child).width : minimumSize(child).height,
      ),
      node.children.map((child) =>
        node.direction === 'row' ? maximumSize(child).width : maximumSize(child).height,
      ),
    ),
  )
  return finalize(body, size.width, size.height)
}

/**
 * Serializes a spec scaled to an existing window size, treating leaf cols/rows
 * as relative weights; used by one-shot restructures that keep tmux dimensions.
 */
export function buildScaledTmuxLayout(
  spec: LayoutSpec,
  cols: number,
  rows: number,
): BuiltTmuxLayout {
  if (
    !Number.isSafeInteger(cols) ||
    !Number.isSafeInteger(rows) ||
    cols < 1 ||
    rows < 1 ||
    cols > MAX_TMUX_DIMENSION ||
    rows > MAX_TMUX_DIMENSION
  ) {
    throw new Error('Invalid tmux window dimensions')
  }
  const minimum = minimumSize(spec)
  if (cols < minimum.width || rows < minimum.height) {
    throw new Error('Window is too small for the requested tmux layout')
  }
  const body = serialize(spec, cols, rows, 0, 0, (node, span) =>
    allocateProportional(
      span,
      node.children.map((child) => {
        const size = maximumSize(child)
        return node.direction === 'row' ? size.width : size.height
      }),
      node.children.map((child) => {
        const size = minimumSize(child)
        return node.direction === 'row' ? size.width : size.height
      }),
    ),
  )
  return finalize(body, cols, rows)
}
