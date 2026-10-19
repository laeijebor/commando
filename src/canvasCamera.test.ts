import { describe, expect, it } from 'vitest'
import { canvasTransform, createCanvasCameraStore, fitCanvas, unionCanvasBounds, zoomAt } from './canvasCamera'

describe('canvas camera', () => {
  it.each([0.001, 0.8, 1.25, 100])('keeps the cursor world point fixed for zoom factor %s, including clamps', (factor) => {
    const before = { x: -70, y: 30, scale: 0.6 }, point = { x: 340, y: 180 }
    const after = zoomAt(before, factor, point)
    expect((point.x - after.x) / after.scale).toBeCloseTo((point.x - before.x) / before.scale)
    expect((point.y - after.y) / after.scale).toBeCloseTo((point.y - before.y) / before.scale)
    expect(after.scale).toBeGreaterThanOrEqual(0.1)
    expect(after.scale).toBeLessThanOrEqual(2)
  })
  it('fits a negative bounds box centered within padding', () => {
    const bounds = { x: -100, y: -50, w: 400, h: 200 }
    const camera = fitCanvas(bounds, { w: 800, h: 500 }, 40)
    expect(camera).toEqual({ scale: 1.8, x: 220, y: 160 })
    expect(camera.x + bounds.x * camera.scale).toBe(40)
    expect(camera.y + bounds.y * camera.scale).toBe(70)
  })
  it('handles empty and zero-sized content and clamps fit', () => {
    expect(unionCanvasBounds([])).toEqual({ x: 0, y: 0, w: 390, h: 844 })
    expect(unionCanvasBounds([{ x: -20, y: 0, w: 10, h: 20 }, { x: 0, y: -10, w: 30, h: 15 }])).toEqual({ x: -20, y: -10, w: 50, h: 30 })
    expect(fitCanvas({ x: 0, y: 0, w: 0, h: 0 }, { w: 800, h: 500 }).scale).toBe(2)
    expect(fitCanvas({ x: 0, y: 0, w: 90000, h: 90000 }, { w: 200, h: 200 }).scale).toBe(0.1)
  })
  it('stores the camera outside React and notifies only on change', () => {
    const store = createCanvasCameraStore({ x: 0, y: 0, scale: 1 }), seen: string[] = []
    const unsubscribe = store.subscribe(() => seen.push(canvasTransform(store.get())))
    store.set({ x: 0, y: 0, scale: 1 })
    store.set((current) => ({ ...current, x: current.x + 5 }))
    store.set({ x: 5, y: 0, scale: 1 })
    unsubscribe(); store.set({ x: 9, y: 9, scale: 2 })
    expect(seen).toEqual(['translate(5px, 0px) scale(1)'])
    expect(store.get()).toEqual({ x: 9, y: 9, scale: 2 })
  })
})
