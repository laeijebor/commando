import { useEffect, useRef, type PointerEvent } from 'react'
import type { CanvasFrame, CanvasMove } from '../shared/canvas-manifest'
import { snapCanvasMove } from './canvasInteraction'

export function useCanvasFrameDrag(preview: (move: CanvasMove | null) => void, persist: (move: CanvasMove) => Promise<unknown>, cancel: () => void) {
  const drag = useRef<{ pointerId: number; x: number; y: number; frame: CanvasFrame; scale: number; move: CanvasMove | null } | null>(null)
  useEffect(() => () => { drag.current = null }, [])
  const finish = (event: PointerEvent<HTMLElement>, commit: boolean) => {
    const start = drag.current
    if (!start || start.pointerId !== event.pointerId) return
    drag.current = null
    if (commit && start.move) void persist(start.move)
    else if (start.move) { preview({ id: start.frame.id, x: start.frame.x, y: start.frame.y }); preview(null) }
  }
  return {
    reset: () => { drag.current = null },
    start: (event: PointerEvent<HTMLElement>, frame: CanvasFrame, scale: number) => {
      if (event.button !== 0) return
      event.stopPropagation(); event.preventDefault(); cancel()
      drag.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, frame, scale, move: null }
      event.currentTarget.setPointerCapture(event.pointerId)
    },
    move: (event: PointerEvent<HTMLElement>) => {
      const start = drag.current
      if (!start || start.pointerId !== event.pointerId) return
      const delta = { x: event.clientX - start.x, y: event.clientY - start.y }
      if (!start.move && Math.hypot(delta.x, delta.y) < 3) return
      start.move = { id: start.frame.id, ...snapCanvasMove(start.frame, delta, start.scale) }; preview(start.move)
    },
    end: (event: PointerEvent<HTMLElement>) => finish(event, true), cancel: (event: PointerEvent<HTMLElement>) => finish(event, false),
  }
}
