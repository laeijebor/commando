import { describe, expect, it } from 'vitest'
import type { CanvasFrame } from '../shared/canvas-manifest'
import { CANVAS_HISTORY_LIMIT, INERT_CANVAS, canvasInteraction, canvasWheelRoute, snapCanvasMove } from './canvasInteraction'
import { readCanvasFrameInput } from './canvasFrameBridge'

const frames: CanvasFrame[] = [{ id: 'a', title: 'A', src: 'a.html', x: 0, y: 0, w: 100, h: 100, interactive: true, focus: 1 },
  { id: 'b', title: 'B', src: 'b.html', x: 200, y: 0, w: 100, h: 100, interactive: true },
  { id: 'static', title: 'Static', src: 's.html', x: 400, y: 0, w: 100, h: 100 }]
describe('canvas interaction', () => {
  it('enters interactive frames, hints for static frames, and leaves on Esc/background/another frame', () => {
    const entered = canvasInteraction(INERT_CANVAS, { type: 'enter', id: 'a' }, frames)
    expect(entered.live).toBe('a')
    expect(canvasInteraction(entered, { type: 'enter', id: 'b' }, frames).live).toBe('b')
    expect(canvasInteraction(INERT_CANVAS, { type: 'enter', id: 'static' }, frames)).toMatchObject({ live: null, hint: 'Static frame' })
    expect(canvasInteraction(entered, { type: 'background' }, frames).live).toBeNull()
    expect(canvasInteraction(entered, { type: 'escape' }, frames)).toEqual(INERT_CANVAS)
  })
  it('starts Play at focus 1, falls back to first interactive, validates goto and retraces history including static targets', () => {
    let state = canvasInteraction(INERT_CANVAS, { type: 'play' }, frames)
    expect(state).toMatchObject({ live: 'a', current: 'a', playing: true, history: [] })
    expect(canvasInteraction(INERT_CANVAS, { type: 'play' }, frames.map((f) => ({ ...f, focus: undefined }))).live).toBe('a')
    expect(canvasInteraction(state, { type: 'goto', id: 'missing' }, frames)).toBe(state)
    expect(canvasInteraction(state, { type: 'goto', id: 'a' }, frames).history).toEqual([])
    state = canvasInteraction(state, { type: 'goto', id: 'b' }, frames)
    state = canvasInteraction(state, { type: 'goto', id: 'static' }, frames)
    expect(state).toMatchObject({ live: null, current: 'static', history: ['a', 'b'] })
    state = canvasInteraction(state, { type: 'back' }, frames)
    expect(state).toMatchObject({ live: 'b', current: 'b', history: ['a'] })
    expect(canvasInteraction(state, { type: 'play' }, frames)).toEqual(INERT_CANVAS)
    expect(canvasInteraction(state, { type: 'escape' }, frames)).toEqual(INERT_CANVAS)
    for (let n = 0; n < 100; n++) state = canvasInteraction(state, { type: 'goto', id: n % 2 ? 'a' : 'b' }, frames)
    expect(state.history).toHaveLength(CANVAS_HISTORY_LIMIT)
    expect(canvasInteraction(INERT_CANVAS, { type: 'play' }, [frames[2]])).toBe(INERT_CANVAS)
  })
  it('routes wheel to scrolling while live, zooms with modifiers and gives comments precedence', () => {
    expect(canvasWheelRoute(true, false, false, false)).toBe('frame')
    expect(canvasWheelRoute(true, false, true, false)).toBe('zoom')
    expect(canvasWheelRoute(true, false, false, true)).toBe('zoom')
    expect(canvasWheelRoute(true, true, false, false)).toBe('pan')
    expect(canvasWheelRoute(false, false, false, false)).toBe('pan')
  })
  it('validates bridge input bounds and snaps deltas in world pixels', () => {
    expect(readCanvasFrameInput({ type: 'goto', target: 'b' })).toEqual({ type: 'goto', target: 'b' })
    for (const target of [{}, 'bad/path', '', 'x'.repeat(65)]) expect(readCanvasFrameInput({ type: 'goto', target })).toBeNull()
    expect(readCanvasFrameInput({ type: 'zoom', deltaY: 10, deltaMode: 0, x: 4, y: 5 })).toMatchObject({ type: 'zoom' })
    expect(readCanvasFrameInput({ type: 'zoom', deltaY: Infinity, deltaMode: 0, x: 4, y: 5 })).toBeNull()
    expect(snapCanvasMove({ x: 3, y: -13 }, { x: 21, y: -20 }, 0.5)).toEqual({ x: 50, y: -50 })
  })
})
