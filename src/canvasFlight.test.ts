// @vitest-environment jsdom
import { useState } from 'react'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useCanvasFlight } from './canvasFlight'
import type { CanvasCamera } from './canvasCamera'

const start: CanvasCamera = { x: 0, y: 0, scale: 0.5 }
function setup(reduced = false) {
  const callbacks = new Map<number, FrameRequestCallback>()
  let sequence = 0
  vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => { callbacks.set(++sequence, callback); return sequence }))
  const cancel = vi.fn((id: number) => callbacks.delete(id))
  vi.stubGlobal('cancelAnimationFrame', cancel)
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: reduced })))
  vi.spyOn(performance, 'now').mockReturnValue(0)
  const viewport = document.createElement('div')
  Object.defineProperties(viewport, { clientWidth: { value: 800 }, clientHeight: { value: 600 } })
  const hook = renderHook(() => {
    const [camera, setCamera] = useState(start)
    return { camera, ...useCanvasFlight(camera, setCamera, { current: viewport }) }
  })
  const step = (time: number) => act(() => {
    const [id, callback] = callbacks.entries().next().value!
    callbacks.delete(id); callback(time)
  })
  return { ...hook, callbacks, step, cancel }
}
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
describe('canvas flight', () => {
  const target = { x: 100, y: 200, w: 80, h: 60 }
  it('eases to the target over 300ms and finishes at the exact camera', () => {
    const { result, step, callbacks } = setup()
    act(() => result.current.flyTo(target))
    step(150)
    expect(result.current.camera).toEqual({ x: 227.5, y: 61.25, scale: 0.9375 })
    step(300)
    expect(result.current.camera).toEqual({ x: 260, y: 70, scale: 1 })
    expect(callbacks.size).toBe(0)
  })
  it('jumps immediately when reduced motion is preferred', () => {
    const { result, callbacks } = setup(true)
    act(() => result.current.flyTo(target))
    expect(result.current.camera).toEqual({ x: 260, y: 70, scale: 1 })
    expect(callbacks.size).toBe(0)
  })
  it('cancels pending animation for user input, a new flight and unmount', () => {
    const { result, callbacks, cancel, unmount } = setup()
    act(() => result.current.flyTo(target))
    act(() => result.current.cancel())
    expect(callbacks.size).toBe(0)
    act(() => result.current.flyTo(target))
    act(() => result.current.flyTo({ ...target, x: 500 }))
    expect(callbacks.size).toBe(1)
    unmount()
    expect(callbacks.size).toBe(0)
    expect(cancel).toHaveBeenCalledTimes(3)
  })
})
