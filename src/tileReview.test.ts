import { afterEach, describe, expect, it, vi } from 'vitest'
import { createInspectThrottle } from './tileReview'

afterEach(() => {
  vi.useRealTimers()
})

describe('createInspectThrottle', () => {
  it('fires immediately, then collapses to a trailing latest-wins call', () => {
    vi.useFakeTimers()
    const send = vi.fn()
    const throttle = createInspectThrottle(send, 50)
    throttle.schedule(1, 1)
    throttle.schedule(2, 2)
    throttle.schedule(3, 3)
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith(1, 1)
    vi.advanceTimersByTime(50)
    expect(send).toHaveBeenCalledTimes(2)
    expect(send).toHaveBeenLastCalledWith(3, 3)
  })

  it('dispose cancels the trailing call', () => {
    vi.useFakeTimers()
    const send = vi.fn()
    const throttle = createInspectThrottle(send, 50)
    throttle.schedule(1, 1)
    throttle.schedule(2, 2)
    throttle.dispose()
    vi.advanceTimersByTime(100)
    expect(send).toHaveBeenCalledTimes(1)
  })
})
