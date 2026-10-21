import { describe, expect, it } from 'vitest'
import { FIT, MAX_ZOOM, clampPan, fitSize, panBy, zoomAround } from './imageZoom'

const viewport = { w: 1000, h: 800 }

describe('image zoom', () => {
  it('opens an image whole, and never larger than its own pixels', () => {
    expect(fitSize({ w: 2000, h: 500 }, { w: 1000, h: 800 })).toEqual({ w: 1000, h: 250 })
    expect(fitSize({ w: 400, h: 300 }, { w: 1000, h: 800 })).toEqual({ w: 400, h: 300 })
    expect(fitSize({ w: 0, h: 0 }, viewport)).toEqual({ w: 0, h: 0 })
  })

  it('keeps the point under the pointer still while zooming', () => {
    const fitted = { w: 1000, h: 500 }
    const zoomed = zoomAround(FIT, 2, { x: 200, y: 100 }, fitted, viewport)
    // That image point sat 200px right of centre at scale 1; at scale 2 it is still under the pointer.
    expect(zoomed).toEqual({ scale: 2, x: -200, y: -100 })
    expect((200 - zoomed.x) / zoomed.scale).toBe(200)
  })

  it('stays between fit and the maximum zoom', () => {
    expect(zoomAround(FIT, 0.5, { x: 0, y: 0 }, { w: 100, h: 100 }, viewport).scale).toBe(1)
    expect(zoomAround(FIT, 99, { x: 0, y: 0 }, { w: 100, h: 100 }, viewport).scale).toBe(MAX_ZOOM)
  })

  it('pans only as far as the zoomed image reaches, and centres what fits', () => {
    const fitted = { w: 1000, h: 250 }
    // 2000 x 500 at scale 2: 500px spare each side horizontally, none vertically.
    expect(panBy({ scale: 2, x: 0, y: 0 }, 900, 300, fitted, viewport)).toEqual({ scale: 2, x: 500, y: 0 })
    expect(clampPan({ scale: 1, x: 40, y: -40 }, fitted, viewport)).toEqual({ scale: 1, x: 0, y: 0 })
  })
})
