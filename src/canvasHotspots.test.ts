import { describe, expect, it } from 'vitest'
import type { CanvasFrame } from '../shared/canvas-manifest'
import { canvasHotspotDots, readCanvasHotspots } from './canvasHotspots'

const rect = { x: 10, y: 20, w: 100, h: 40 }
const frames: CanvasFrame[] = [
  { id: 'home', title: 'Home', src: 'Home.html', x: 100, y: 50, w: 390, h: 844, interactive: true },
  { id: 'accounts', title: 'Accounts', src: 'Accounts.html', x: 600, y: 0, w: 390, h: 844 },
]

describe('readCanvasHotspots', () => {
  it('keeps valid hotspots and drops empty tips', () => {
    expect(readCanvasHotspots([{ rect, tip: 'Toggle theme' }, { rect, goto: 'accounts' }, { rect, tip: '' }])).toEqual([
      { rect, tip: 'Toggle theme', goto: undefined }, { rect, tip: undefined, goto: 'accounts' }, { rect, tip: undefined, goto: undefined },
    ])
  })
  it.each([
    ['missing payload', undefined], ['non-array', {}], ['too many', Array.from({ length: 501 }, () => ({ rect }))],
    ['negative size', [{ rect: { ...rect, w: -1 } }]], ['non-finite rect', [{ rect: { ...rect, x: Infinity } }]],
    ['long tip', [{ rect, tip: 'x'.repeat(501) }]], ['bad goto', [{ rect, goto: '../x' }]], ['non-object', [null]],
  ])('rejects %s', (_, value) => { expect(readCanvasHotspots(value)).toEqual([]) })
})

describe('canvasHotspotDots', () => {
  const camera = { x: 5, y: 7, scale: 0.5 }
  it('places a dot at the top-right corner of each hotspot in interactive frames only, skipping links to missing frames', () => {
    const dots = canvasHotspotDots(frames, { home: [{ rect, tip: 'Toggle theme' }, { rect, goto: 'accounts' }, { rect, goto: 'gone' }], accounts: [{ rect }] }, camera)
    expect(dots).toEqual([
      { key: 'home:0', x: 5 + (100 + 110) * 0.5, y: 7 + (50 + 20) * 0.5, tip: 'Toggle theme' },
      { key: 'home:1', x: 110, y: 42, tip: 'Opens “Accounts”' },
    ])
  })
  it('clips to the frame and skips hotspots that are scrolled away, hidden or too small to see', () => {
    const reports = { home: [
      { rect: { x: 300, y: -20, w: 200, h: 60 } }, // overflows right and top: clipped corner
      { rect: { x: 10, y: 900, w: 100, h: 40 } }, // scrolled below the frame
      { rect: { x: 10, y: 20, w: 0, h: 0 } }, // display: none
      { rect: { x: 10, y: 20, w: 100, h: 8 } }, // 4px tall at 50%
    ] }
    expect(canvasHotspotDots(frames, reports, camera)).toEqual([{ key: 'home:0', x: 5 + (100 + 390) * 0.5, y: 7 + 50 * 0.5, tip: undefined }])
  })
})
