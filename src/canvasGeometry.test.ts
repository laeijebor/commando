import { describe, expect, it } from 'vitest'
import { canvasConnector, canvasLabelBounds, flyToCanvasRect, projectCanvasRect } from './canvasGeometry'

describe('canvas geometry', () => {
  const frame = { x: -100, y: 240 }, rect = { x: 20, y: 30, w: 80, h: 60 }
  it('projects frame-local rectangles through translation and scale', () => {
    expect(canvasLabelBounds(frame, rect)).toEqual({ x: -80, y: 270, w: 80, h: 60 })
    expect(projectCanvasRect(frame, rect, { x: 10, y: -20, scale: 0.5 })).toEqual({ x: -30, y: 115, w: 40, h: 30 })
    expect(projectCanvasRect(frame, rect, { x: 90, y: 40, scale: 2 })).toEqual({ x: -70, y: 580, w: 160, h: 120 })
  })
  it('centres targets, fits with padding and caps at 100%', () => {
    expect(flyToCanvasRect({ x: 100, y: 200, w: 80, h: 60 }, { w: 800, h: 600 })).toEqual({ scale: 1, x: 260, y: 70 })
    const large = { x: -50, y: -100, w: 1400, h: 1000 }, camera = flyToCanvasRect(large, { w: 800, h: 600 }, 50)
    expect(camera.scale).toBe(0.5)
    expect(projectCanvasRect({ x: 0, y: 0 }, large, camera)).toEqual({ x: 50, y: 50, w: 700, h: 500 })
    expect(flyToCanvasRect({ x: 0, y: 0, w: 20000, h: 20000 }, { w: 500, h: 500 }).scale).toBeLessThan(0.1)
  })
  it('connects to the nearest target edge, horizontally and vertically', () => {
    const note = { x: 500, y: 0, w: 100, h: 100 }
    expect(canvasConnector(note, { x: 0, y: 0, w: 300, h: 200 }).end).toEqual({ x: 300, y: 50 })
    const target = canvasLabelBounds({ x: 0, y: 0 }, { x: 10, y: 20, w: 30, h: 40 })
    expect(canvasConnector(note, target).end).toEqual({ x: 40, y: 50 })
    expect(canvasConnector({ x: 10, y: 500, w: 30, h: 100 }, target).end).toEqual({ x: 25, y: 60 })
    expect(canvasConnector(note, target).path).toContain(' C ')
  })
})
