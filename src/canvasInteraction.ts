import type { CanvasFrame } from '../shared/canvas-manifest'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'

export const CANVAS_HISTORY_LIMIT = 50
export type CanvasInteraction = { live: string | null; current: string | null; playing: boolean; history: string[]; hint: string | null }
export const INERT_CANVAS: CanvasInteraction = { live: null, current: null, playing: false, history: [], hint: null }
export type CanvasInteractionAction = { type: 'enter' | 'goto'; id: string } | { type: 'play' | 'back' | 'escape' | 'background' | 'clear-hint' }
export function canvasInteraction(state: CanvasInteraction, action: CanvasInteractionAction, frames: CanvasFrame[]): CanvasInteraction {
  if (action.type === 'escape') return INERT_CANVAS
  if (action.type === 'background') return { ...state, live: null }
  if (action.type === 'clear-hint') return { ...state, hint: null }
  if (action.type === 'play' && state.playing) return INERT_CANVAS
  const id = action.type === 'play' ? (frames.find((f) => f.focus === 1) ?? frames.find((f) => f.interactive))?.id
    : action.type === 'back' ? state.history.at(-1) : 'id' in action ? action.id : undefined
  const frame = frames.find((f) => f.id === id)
  if (!frame) return state
  if (action.type === 'enter' && !frame.interactive) return { ...state, hint: 'Static frame' }
  const playing = action.type === 'play' || state.playing
  const history = action.type === 'play' ? [] : action.type === 'back' ? state.history.slice(0, -1)
    : playing && state.current && state.current !== frame.id ? [...state.history, state.current].slice(-CANVAS_HISTORY_LIMIT) : state.history
  return { live: frame.interactive ? frame.id : null, current: frame.id, playing, history, hint: null }
}
export function snapCanvasMove(start: { x: number; y: number }, delta: { x: number; y: number }, scale: number) {
  return { x: Math.round((start.x + delta.x / scale) / 10) * 10, y: Math.round((start.y + delta.y / scale) / 10) * 10 }
}
export function canvasWheelRoute(live: boolean, commentMode: boolean, ctrlKey: boolean, metaKey: boolean): 'frame' | 'zoom' | 'pan' {
  return ctrlKey || metaKey ? 'zoom' : live && !commentMode ? 'frame' : 'pan'
}

export function useCanvasInteraction(frames: CanvasFrame[], navigate: (frame: CanvasFrame) => void) {
  const [state, setState] = useState(INERT_CANVAS)
  const current = useRef(state)
  useLayoutEffect(() => { current.current = state }, [state])
  const act = (action: CanvasInteractionAction) => {
    const previous = current.current, next = canvasInteraction(previous, action, frames)
    current.current = next; setState(next)
    if (next.current && next !== previous && ['play', 'goto', 'back'].includes(action.type)) {
      const frame = frames.find((f) => f.id === next.current)
      if (frame) navigate(frame)
    }
  }
  useEffect(() => {
    if (state.current && !frames.some((f) => f.id === state.current)) act({ type: 'escape' })
    else if (state.live && !frames.some((f) => f.id === state.live && f.interactive)) act({ type: 'background' })
  }, [frames, state.current, state.live])
  useEffect(() => {
    if (!state.hint) return
    const timer = setTimeout(() => act({ type: 'clear-hint' }), 1_500)
    return () => clearTimeout(timer)
  }, [state.hint])
  return { state, act, current }
}
/** WebKit's trackpad pinch (gesturechange) reports a scale cumulative since
 * gesturestart; zoomAt wants the step since the previous change. */
export function canvasGestureStep(previous: number, scale: number): number | null {
  return Number.isFinite(scale) && scale > 0 && Number.isFinite(previous) && previous > 0 ? scale / previous : null
}
