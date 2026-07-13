import {
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useEffect,
  useState,
} from 'react'

type OuterSize = { widthPx?: number; heightPx?: number }
type ResizeAxes = { width: boolean; height: boolean }

export const MIN_OUTER_GROUP_SIZE = 280
const MAX_OUTER_GROUP_SIZE = 5_000
const KEYBOARD_RESIZE_STEP = 16

export function clampOuterGroupSize(value: number, maximum: number): number {
  return Math.round(Math.min(Math.max(value, MIN_OUTER_GROUP_SIZE), maximum))
}

export function ResizablePaneGroup({
  groupId,
  widthPx,
  heightPx,
  maximized,
  onCommit,
  children,
}: OuterSize & {
  groupId: string
  maximized: boolean
  onCommit: (size: OuterSize) => void
  children: ReactNode
}) {
  const [liveSize, setLiveSize] = useState<OuterSize>({ widthPx, heightPx })

  useEffect(() => setLiveSize({ widthPx, heightPx }), [heightPx, widthPx])

  const beginResize = (event: ReactPointerEvent<HTMLElement>, axes: ResizeAxes) => {
    if (event.button !== 0 || maximized) return
    event.preventDefault()
    event.stopPropagation()
    const group = event.currentTarget.closest<HTMLElement>('.pane-group')
    const canvas = group?.parentElement
    if (!group || !canvas) return
    const groupBounds = group.getBoundingClientRect()
    const canvasBounds = canvas.getBoundingClientRect()
    const startX = event.clientX
    const startY = event.clientY
    const maximumWidth = Math.max(
      MIN_OUTER_GROUP_SIZE,
      Math.min(MAX_OUTER_GROUP_SIZE, canvasBounds.right - groupBounds.left),
    )
    let nextWidth = groupBounds.width
    let nextHeight = groupBounds.height
    let moved = false

    const move = (pointerEvent: globalThis.PointerEvent) => {
      moved = true
      if (axes.width) {
        nextWidth = clampOuterGroupSize(
          groupBounds.width + pointerEvent.clientX - startX,
          maximumWidth,
        )
      }
      if (axes.height) {
        nextHeight = clampOuterGroupSize(
          groupBounds.height + pointerEvent.clientY - startY,
          MAX_OUTER_GROUP_SIZE,
        )
      }
      setLiveSize((current) => ({
        widthPx: axes.width ? nextWidth : current.widthPx,
        heightPx: axes.height ? nextHeight : current.heightPx,
      }))
    }
    const stop = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', stop)
      window.removeEventListener('pointercancel', stop)
      document.body.classList.remove('is-resizing-group-width')
      document.body.classList.remove('is-resizing-group-height')
      document.body.classList.remove('is-resizing-group-both')
      if (!moved) return
      onCommit({
        widthPx: axes.width ? nextWidth : liveSize.widthPx,
        heightPx: axes.height ? nextHeight : liveSize.heightPx,
      })
    }

    document.body.classList.add(
      axes.width && axes.height
        ? 'is-resizing-group-both'
        : axes.width
          ? 'is-resizing-group-width'
          : 'is-resizing-group-height',
    )
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', stop)
    window.addEventListener('pointercancel', stop)
  }

  const resizeFromKeyboard = (
    event: KeyboardEvent<HTMLElement>,
    axes: ResizeAxes,
  ) => {
    const group = event.currentTarget.closest<HTMLElement>('.pane-group')
    const canvas = group?.parentElement
    if (!group || !canvas || maximized) return
    const horizontal = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0
    const vertical = event.key === 'ArrowUp' ? -1 : event.key === 'ArrowDown' ? 1 : 0
    if ((!axes.width || horizontal === 0) && (!axes.height || vertical === 0)) return
    event.preventDefault()
    const groupBounds = group.getBoundingClientRect()
    const canvasBounds = canvas.getBoundingClientRect()
    const step = event.shiftKey ? KEYBOARD_RESIZE_STEP * 3 : KEYBOARD_RESIZE_STEP
    const next = {
      widthPx: axes.width && horizontal !== 0
        ? clampOuterGroupSize(
            groupBounds.width + horizontal * step,
            Math.max(MIN_OUTER_GROUP_SIZE, canvasBounds.right - groupBounds.left),
          )
        : liveSize.widthPx,
      heightPx: axes.height && vertical !== 0
        ? clampOuterGroupSize(groupBounds.height + vertical * step, MAX_OUTER_GROUP_SIZE)
        : liveSize.heightPx,
    }
    setLiveSize(next)
    onCommit(next)
  }

  const style: CSSProperties | undefined = maximized
    ? undefined
    : {
        width: liveSize.widthPx,
        height: liveSize.heightPx,
      }

  const reset = (axes: ResizeAxes) => {
    const next = {
      widthPx: axes.width ? undefined : liveSize.widthPx,
      heightPx: axes.height ? undefined : liveSize.heightPx,
    }
    setLiveSize(next)
    onCommit(next)
  }

  return (
    <section
      className={`pane-group${liveSize.widthPx && !maximized ? ' has-outer-width' : ''}${liveSize.heightPx && !maximized ? ' has-outer-height' : ''}`}
      style={style}
      data-group-id={groupId}
    >
      {children}
      {!maximized ? <>
        <div
          className="group-resize-handle group-resize-right"
          role="separator"
          aria-label="Resize workspace width"
          aria-orientation="vertical"
          tabIndex={0}
          onPointerDown={(event) => beginResize(event, { width: true, height: false })}
          onKeyDown={(event) => resizeFromKeyboard(event, { width: true, height: false })}
          onDoubleClick={() => reset({ width: true, height: false })}
        />
        <div
          className="group-resize-handle group-resize-bottom"
          role="separator"
          aria-label="Resize workspace height"
          aria-orientation="horizontal"
          tabIndex={0}
          onPointerDown={(event) => beginResize(event, { width: false, height: true })}
          onKeyDown={(event) => resizeFromKeyboard(event, { width: false, height: true })}
          onDoubleClick={() => reset({ width: false, height: true })}
        />
        <div
          className="group-resize-handle group-resize-corner"
          role="separator"
          aria-label="Resize workspace width and height"
          tabIndex={0}
          onPointerDown={(event) => beginResize(event, { width: true, height: true })}
          onKeyDown={(event) => resizeFromKeyboard(event, { width: true, height: true })}
          onDoubleClick={() => reset({ width: true, height: true })}
        />
      </> : null}
    </section>
  )
}
