import { expect, it } from 'vitest'
import { canvasFrameUrl } from './canvasFrameBridge'
const frame = { id: 'a', title: 'A', src: 'a deck/deck.html', slide: 'opening', x: 0, y: 0, w: 1280, h: 720 }
it('keeps paths encoded and adds extra queries before the slide hash', () => {
  expect(canvasFrameUrl('/base/', frame, 3, { theme: 'paper' })).toBe('/base/a%20deck/deck.html?theme=paper&canvas-frame=a&canvas-reload=3#opening')
  expect(canvasFrameUrl('/base/', { ...frame, slide: undefined })).toBe('/base/a%20deck/deck.html?canvas-frame=a')
})
