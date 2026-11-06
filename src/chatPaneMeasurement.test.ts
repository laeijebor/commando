// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useChatPaneMeasurement } from './chatPaneMeasurement'

let observerCallbacks: Array<() => void> = []

function paneBody(width: number, height: number): HTMLDivElement {
  const element = document.createElement('div')
  Object.defineProperty(element, 'clientWidth', { configurable: true, get: () => width })
  Object.defineProperty(element, 'clientHeight', { configurable: true, get: () => height })
  document.body.appendChild(element)
  return element
}

beforeEach(() => {
  vi.useFakeTimers()
  observerCallbacks = []
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: () => void) { observerCallbacks.push(callback) }
    observe() {}
    disconnect() {}
  })
  // The terminal-font probe: 32 `W`s at 6px wide, 12px tall.
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    return this.textContent?.startsWith('WWW')
      ? ({ width: 192, height: 12 } as DOMRect)
      : ({ width: 0, height: 0 } as DOMRect)
  })
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

describe('useChatPaneMeasurement', () => {
  it('reports the terminal grid that fits the chat pane', () => {
    const ref = { current: paneBody(1200, 480) }
    const onResize = vi.fn()
    renderHook(() => useChatPaneMeasurement(ref, true, 'key', '80x24', onResize))

    act(() => { vi.runAllTimers() })

    expect(onResize).toHaveBeenCalledExactlyOnceWith(200, 40)
    expect(document.body.textContent).toBe('')
  })

  it('stays quiet while the pane is not the resize owner', () => {
    const ref = { current: paneBody(1200, 480) }
    const onResize = vi.fn()
    renderHook(() => useChatPaneMeasurement(ref, false, 'key', '80x24', onResize))

    act(() => { vi.runAllTimers() })

    expect(onResize).not.toHaveBeenCalled()
  })

  it('reports again under a new measurement key, but not for an unchanged size', () => {
    const ref = { current: paneBody(1200, 480) }
    const onResize = vi.fn()
    const { rerender } = renderHook(
      ({ measurementKey, tmuxSize }) => useChatPaneMeasurement(ref, true, measurementKey, tmuxSize, onResize),
      { initialProps: { measurementKey: 'grid', tmuxSize: '365x55' } },
    )
    act(() => { vi.runAllTimers() })
    act(() => {
      for (const callback of observerCallbacks) callback()
      vi.runAllTimers()
    })
    expect(onResize).toHaveBeenCalledTimes(1)

    // A split changes the layout shape, and with it the measurement key: the
    // layout is only sent once every pane has reported under the new key.
    rerender({ measurementKey: 'split', tmuxSize: '365x55' })
    act(() => { vi.runAllTimers() })

    expect(onResize).toHaveBeenCalledTimes(2)
    expect(onResize).toHaveBeenLastCalledWith(200, 40)
  })

  it('reports again when tmux resizes the pane from elsewhere', () => {
    const ref = { current: paneBody(1200, 480) }
    const onResize = vi.fn()
    const { rerender } = renderHook(
      ({ tmuxSize }) => useChatPaneMeasurement(ref, true, 'grid', tmuxSize, onResize),
      { initialProps: { tmuxSize: '200x40' } },
    )
    act(() => { vi.runAllTimers() })

    rerender({ tmuxSize: '365x110' })
    act(() => { vi.runAllTimers() })

    expect(onResize).toHaveBeenCalledTimes(2)
    expect(onResize).toHaveBeenLastCalledWith(200, 40)
  })
})
