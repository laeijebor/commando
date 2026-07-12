import { type KeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode, useEffect, useState } from 'react'
import type { GroupLayoutPreset } from '../shared/protocol'

type SplitDirection = 'row' | 'column'

type LayoutNode =
  | { kind: 'pane'; index: number }
  | { kind: 'split'; direction: SplitDirection; children: LayoutNode[] }

type SplitWeights = Record<string, number[]>

const STORAGE_KEY = 'commando.pane-split-weights'
const DEFAULT_PANE_HEIGHT = 254
const SPLITTER_SIZE = 8
const MIN_PANE_WIDTH = 160
const MIN_PANE_HEIGHT = 140

function chunks<T>(values: T[], size: number): T[][] {
  const result: T[][] = []
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size))
  return result
}

const split = (direction: SplitDirection, children: LayoutNode[]): LayoutNode =>
  children.length === 1 ? children[0] : { kind: 'split', direction, children }

export function buildPaneLayout(preset: GroupLayoutPreset, paneCount: number): LayoutNode | null {
  if (paneCount < 1) return null
  const panes = Array.from({ length: paneCount }, (_, index): LayoutNode => ({ kind: 'pane', index }))
  if (paneCount === 1) return panes[0]

  switch (preset) {
    case 'equal-grid':
      if (paneCount <= 3) return split('row', panes)
      if (paneCount === 4) {
        return split('column', [split('row', panes.slice(0, 2)), split('row', panes.slice(2))])
      }
      return split('column', chunks(panes, 3).map((row) => split('row', row)))
    case 'full-then-halves':
      return split('column', [panes[0], ...chunks(panes.slice(1), 2).map((row) => split('row', row))])
    case 'two-full-two-halves':
      return split('column', [panes[0], panes[1], ...chunks(panes.slice(2), 2).map((row) => split('row', row))])
    case 'lead-and-stack':
      if (paneCount === 2) return split('row', panes)
      if (paneCount === 3) return split('row', [panes[0], split('column', panes.slice(1))])
      return split('column', [
        split('row', [panes[0], split('column', panes.slice(1, 3))]),
        ...chunks(panes.slice(3), 3).map((row) => split('row', row)),
      ])
  }
}

function defaultHeight(node: LayoutNode): number {
  if (node.kind === 'pane') return DEFAULT_PANE_HEIGHT
  const heights = node.children.map(defaultHeight)
  return node.direction === 'row'
    ? Math.max(...heights)
    : heights.reduce((total, height) => total + height, SPLITTER_SIZE * (heights.length - 1))
}

function storedWeights(layoutKey: string): SplitWeights {
  try {
    const stored = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '{}') as Record<string, unknown>
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return {}
    const value = stored[layoutKey]
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
    return Object.fromEntries(Object.entries(value).flatMap(([path, weights]) =>
      Array.isArray(weights) && weights.every((weight) => typeof weight === 'number' && weight > 0)
        ? [[path, weights]]
        : [],
    ))
  } catch {
    return {}
  }
}

function persistWeights(layoutKey: string, weights: SplitWeights): void {
  try {
    const stored = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '{}') as Record<string, unknown>
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return
    stored[layoutKey] = weights
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(stored))
  } catch {
    // Splitters remain usable for the current mount when storage is unavailable.
  }
}

export function ResizablePaneLayout({
  layoutKey,
  preset,
  panes,
}: {
  layoutKey: string
  preset: GroupLayoutPreset
  panes: ReactNode[]
}) {
  const [weights, setWeights] = useState<SplitWeights>(() => storedWeights(layoutKey))
  const root = buildPaneLayout(preset, panes.length)

  useEffect(() => persistWeights(layoutKey, weights), [layoutKey, weights])
  if (!root) return null

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

    const move = (pointerEvent: globalThis.PointerEvent) => {
      const pointer = direction === 'row' ? pointerEvent.clientX : pointerEvent.clientY
      const rawDelta = pointer - start
      const delta = Math.min(Math.max(rawDelta, minimum - beforeSize), afterSize - minimum)
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
  }

  const renderNode = (node: LayoutNode, path: string): ReactNode => {
    if (node.kind === 'pane') return panes[node.index]
    const splitWeights = weights[path]
    return (
      <div className={`pane-split pane-split-${node.direction}`} data-split-path={path}>
        {node.children.flatMap((child, index) => {
          const childPath = `${path}.${index}`
          const childElement = (
            <div
              className="pane-split-child"
              style={{ flexGrow: splitWeights?.[index] ?? 1 }}
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
              title="Drag to resize adjacent panes. Double-click to reset."
              onPointerDown={(event) => beginResize(event, node.direction, path)}
              onKeyDown={(event) => resizeFromKeyboard(event, node.direction, path)}
              onDoubleClick={() => setWeights((current) => {
                const next = { ...current }
                delete next[path]
                return next
              })}
              key={`${path}.splitter.${index}`}
            />,
          ]
        })}
      </div>
    )
  }

  return (
    <div className="pane-layout-root" style={{ height: defaultHeight(root) }}>
      {renderNode(root, 'root')}
    </div>
  )
}
