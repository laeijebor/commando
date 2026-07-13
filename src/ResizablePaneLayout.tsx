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

  const resizeAdjacent = (
    handle: HTMLElement,
    direction: SplitDirection,
    path: string,
    delta: number,
  ) => {
    const before = handle.previousElementSibling as HTMLElement | null
    const after = handle.nextElementSibling as HTMLElement | null
    const parent = handle.parentElement
    if (!before || !after || !parent) return
    const children = [...parent.children].filter((child): child is HTMLElement =>
      child instanceof HTMLElement && child.classList.contains('pane-split-child'),
    )
    const dimension = (element: HTMLElement) => direction === 'row'
      ? element.getBoundingClientRect().width
      : element.getBoundingClientRect().height
    const minimum = direction === 'row' ? MIN_PANE_WIDTH : MIN_PANE_HEIGHT
    const beforeSize = dimension(before)
    const afterSize = dimension(after)
    const boundedDelta = Math.min(Math.max(delta, minimum - beforeSize), afterSize - minimum)
    if (boundedDelta === 0) return
    const next = children.map(dimension)
    const beforeIndex = children.indexOf(before)
    const afterIndex = children.indexOf(after)
    next[beforeIndex] = beforeSize + boundedDelta
    next[afterIndex] = afterSize - boundedDelta
    setWeights((current) => ({ ...current, [path]: next }))
  }

  const beginResize = (
    event: ReactPointerEvent<HTMLElement>,
    direction: SplitDirection,
    path: string,
  ) => {
    if (event.button !== 0) return
    event.preventDefault()
    const handle = event.currentTarget
    const start = direction === 'row' ? event.clientX : event.clientY
    const before = handle.previousElementSibling as HTMLElement | null
    const after = handle.nextElementSibling as HTMLElement | null
    const parent = handle.parentElement
    if (!before || !after || !parent) return
    const children = [...parent.children].filter((child): child is HTMLElement =>
      child instanceof HTMLElement && child.classList.contains('pane-split-child'),
    )
    const beforeSize = direction === 'row' ? before.getBoundingClientRect().width : before.getBoundingClientRect().height
    const afterSize = direction === 'row' ? after.getBoundingClientRect().width : after.getBoundingClientRect().height
    const initialSizes = children.map((child) => direction === 'row'
      ? child.getBoundingClientRect().width
      : child.getBoundingClientRect().height)
    const beforeIndex = children.indexOf(before)
    const afterIndex = children.indexOf(after)
    const minimum = direction === 'row' ? MIN_PANE_WIDTH : MIN_PANE_HEIGHT
    const resizingClass = direction === 'row' ? 'is-resizing-pane-width' : 'is-resizing-pane-height'
    let moved = false

    const move = (pointerEvent: globalThis.PointerEvent) => {
      const pointer = direction === 'row' ? pointerEvent.clientX : pointerEvent.clientY
      const rawDelta = pointer - start
      const delta = Math.min(Math.max(rawDelta, minimum - beforeSize), afterSize - minimum)
      moved = true
      const next = [...initialSizes]
      next[beforeIndex] = beforeSize + delta
      next[afterIndex] = afterSize - delta
      setWeights((current) => ({ ...current, [path]: next }))
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
    path: string,
  ) => {
    const negative = direction === 'row' ? event.key === 'ArrowLeft' : event.key === 'ArrowUp'
    const positive = direction === 'row' ? event.key === 'ArrowRight' : event.key === 'ArrowDown'
    if (!negative && !positive) return
    event.preventDefault()
    resizeAdjacent(event.currentTarget, direction, path, (negative ? -1 : 1) * (event.shiftKey ? 32 : 8))
    scheduleCommit()
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
              onPointerDown={(event) => beginResize(event, node.direction, path)}
              onKeyDown={(event) => resizeFromKeyboard(event, node.direction, path)}
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
