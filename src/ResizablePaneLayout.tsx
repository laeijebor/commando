import { type KeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode, useState } from 'react'
import type { WindowLayoutNode } from '../shared/window-layout'

type SplitDirection = 'row' | 'column'
type SplitWeights = Record<string, number[]>

const DEFAULT_PANE_HEIGHT = 254
const SPLITTER_SIZE = 1
const MIN_PANE_WIDTH = 160
const MIN_PANE_HEIGHT = 140

export function defaultLayoutHeight(node: WindowLayoutNode): number {
  if (node.kind === 'pane') return DEFAULT_PANE_HEIGHT
  const heights = node.children.map(defaultLayoutHeight)
  return node.direction === 'row'
    ? Math.max(...heights)
    : heights.reduce((total, height) => total + height, SPLITTER_SIZE * (heights.length - 1))
}

type AlignedSplit = {
  path: string
  beforeIndex: number
  afterIndex: number
  beforeSize: number
  afterSize: number
  initialSizes: number[]
}

/** tmux cell rounding can offset an intended shared boundary by about a cell. */
const BOUNDARY_ALIGN_TOLERANCE_PX = 10

/**
 * Finds every splitter in the layout that sits on the same boundary line as
 * the grabbed one (same orientation, same coordinate within tolerance), so a
 * drag moves the whole row/column edge like a table grid line.
 */
function collectAlignedBoundary(handle: HTMLElement, direction: SplitDirection): AlignedSplit[] {
  const root = handle.closest('.pane-layout-root')
  const axisCenter = (element: Element) => {
    const bounds = element.getBoundingClientRect()
    return direction === 'row' ? bounds.left + bounds.width / 2 : bounds.top + bounds.height / 2
  }
  const origin = axisCenter(handle)
  const splitters = root ? [...root.querySelectorAll('.pane-splitter')] : [handle]
  const boundary = new Map<string, AlignedSplit>()
  for (const splitter of splitters) {
    const parent = splitter.parentElement
    if (!parent?.classList.contains(`pane-split-${direction}`)) continue
    if (Math.abs(axisCenter(splitter) - origin) > BOUNDARY_ALIGN_TOLERANCE_PX) continue
    const path = parent.getAttribute('data-split-path')
    const before = splitter.previousElementSibling
    const after = splitter.nextElementSibling
    if (!path || boundary.has(path) || !before || !after) continue
    const children = [...parent.children].filter((child) =>
      child.classList.contains('pane-split-child'),
    )
    const dimension = (element: Element) => direction === 'row'
      ? element.getBoundingClientRect().width
      : element.getBoundingClientRect().height
    boundary.set(path, {
      path,
      beforeIndex: children.indexOf(before),
      afterIndex: children.indexOf(after),
      beforeSize: dimension(before),
      afterSize: dimension(after),
      initialSizes: children.map(dimension),
    })
  }
  return [...boundary.values()]
}

/**
 * Renders the tmux window's split tree. Structure and proportions come from
 * tmux's own layout; splitter drags override proportions locally and then
 * `onCommit` fires so the owner can write the new geometry back to tmux.
 */
export function ResizablePaneLayout({
  layoutKey,
  tree,
  panes,
  onCommit,
}: {
  layoutKey: string
  tree: WindowLayoutNode
  panes: ReadonlyMap<string, ReactNode>
  onCommit?: () => void
}) {
  const [weights, setWeights] = useState<SplitWeights>({})
  const [seenLayoutKey, setSeenLayoutKey] = useState(layoutKey)
  if (seenLayoutKey !== layoutKey) {
    // tmux geometry moved on; it is the source of truth once a snapshot lands.
    setSeenLayoutKey(layoutKey)
    setWeights({})
  }

  const scheduleCommit = () => {
    if (!onCommit) return
    window.requestAnimationFrame(() => onCommit())
  }

  const applyBoundaryDelta = (boundary: AlignedSplit[], direction: SplitDirection, rawDelta: number): boolean => {
    if (boundary.length === 0) return false
    const minimum = direction === 'row' ? MIN_PANE_WIDTH : MIN_PANE_HEIGHT
    const lower = Math.max(...boundary.map((split) => minimum - split.beforeSize))
    const upper = Math.min(...boundary.map((split) => split.afterSize - minimum))
    if (lower > upper) return false
    const delta = Math.min(Math.max(rawDelta, lower), upper)
    setWeights((current) => {
      const next = { ...current }
      for (const split of boundary) {
        const sizes = [...split.initialSizes]
        sizes[split.beforeIndex] = split.beforeSize + delta
        sizes[split.afterIndex] = split.afterSize - delta
        next[split.path] = sizes
      }
      return next
    })
    return true
  }

  const beginResize = (
    event: ReactPointerEvent<HTMLElement>,
    direction: SplitDirection,
  ) => {
    if (event.button !== 0) return
    event.preventDefault()
    const handle = event.currentTarget
    const start = direction === 'row' ? event.clientX : event.clientY
    const boundary = collectAlignedBoundary(handle, direction)
    if (boundary.length === 0) return
    const resizingClass = direction === 'row' ? 'is-resizing-pane-width' : 'is-resizing-pane-height'
    let moved = false

    const move = (pointerEvent: globalThis.PointerEvent) => {
      const pointer = direction === 'row' ? pointerEvent.clientX : pointerEvent.clientY
      moved = applyBoundaryDelta(boundary, direction, pointer - start) || moved
    }
    const stop = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', stop)
      window.removeEventListener('pointercancel', stop)
      document.body.classList.remove('is-resizing-pane-split')
      document.body.classList.remove(resizingClass)
      if (moved) scheduleCommit()
    }

    document.body.classList.add('is-resizing-pane-split')
    document.body.classList.add(resizingClass)
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', stop)
    window.addEventListener('pointercancel', stop)
  }

  const resizeFromKeyboard = (
    event: KeyboardEvent<HTMLElement>,
    direction: SplitDirection,
  ) => {
    const negative = direction === 'row' ? event.key === 'ArrowLeft' : event.key === 'ArrowUp'
    const positive = direction === 'row' ? event.key === 'ArrowRight' : event.key === 'ArrowDown'
    if (!negative && !positive) return
    event.preventDefault()
    const boundary = collectAlignedBoundary(event.currentTarget, direction)
    if (applyBoundaryDelta(boundary, direction, (negative ? -1 : 1) * (event.shiftKey ? 32 : 8))) {
      scheduleCommit()
    }
  }

  const equalize = (node: Extract<WindowLayoutNode, { kind: 'split' }>, path: string) => {
    setWeights((current) => ({ ...current, [path]: node.children.map(() => 1) }))
    scheduleCommit()
  }

  const renderNode = (node: WindowLayoutNode, path: string): ReactNode => {
    if (node.kind === 'pane') return panes.get(node.paneId) ?? null
    const splitWeights = weights[path]
    return (
      <div className={`pane-split pane-split-${node.direction}`} data-split-path={path}>
        {node.children.flatMap((child, index) => {
          const childPath = `${path}.${index}`
          const weight = splitWeights?.[index]
            ?? (node.direction === 'row' ? child.cols : child.rows)
          const childElement = (
            <div
              className="pane-split-child"
              style={{ flexGrow: weight }}
              key={childPath}
            >
              {renderNode(child, childPath)}
            </div>
          )
          if (index === node.children.length - 1) return [childElement]
          return [
            childElement,
            <div
              className="pane-splitter"
              role="separator"
              aria-label={node.direction === 'row' ? 'Resize pane widths' : 'Resize pane heights'}
              aria-orientation={node.direction === 'row' ? 'vertical' : 'horizontal'}
              tabIndex={0}
              title="Drag to resize adjacent panes. Double-click to equalize."
              onPointerDown={(event) => beginResize(event, node.direction)}
              onKeyDown={(event) => resizeFromKeyboard(event, node.direction)}
              onDoubleClick={() => equalize(node, path)}
              key={`${path}.splitter.${index}`}
            />,
          ]
        })}
      </div>
    )
  }

  return (
    <div className="pane-layout-root" style={{ minHeight: defaultLayoutHeight(tree) }}>
      {renderNode(tree, 'root')}
    </div>
  )
}
