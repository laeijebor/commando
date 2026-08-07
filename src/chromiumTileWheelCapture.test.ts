// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { attachTileWheelCapture } from './chromiumTileInput'

describe('attachTileWheelCapture', () => {
  it('forwards wheel deltas and prevents the cockpit page from scrolling', () => {
    const target = document.createElement('canvas')
    const send = vi.fn()
    attachTileWheelCapture(target, send)

    const event = new WheelEvent('wheel', { deltaX: 3, deltaY: 120, cancelable: true, bubbles: true })
    target.dispatchEvent(event)

    expect(send).toHaveBeenCalledWith(expect.objectContaining({ kind: 'wheel', deltaX: 3, deltaY: 120 }))
    expect(event.defaultPrevented).toBe(true)
  })

  it('registers non-passive so preventDefault is honored, and detaches on cleanup', () => {
    const target = document.createElement('canvas')
    const addSpy = vi.spyOn(target, 'addEventListener')
    const send = vi.fn()
    const detach = attachTileWheelCapture(target, send)
    expect(addSpy).toHaveBeenCalledWith('wheel', expect.any(Function), { passive: false })

    detach()
    target.dispatchEvent(new WheelEvent('wheel', { deltaY: 10, cancelable: true }))
    expect(send).not.toHaveBeenCalled()
  })
})
