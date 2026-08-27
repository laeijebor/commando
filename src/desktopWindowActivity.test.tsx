// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DESKTOP_WINDOW_ACTIVITY_EVENT,
  useDesktopWindowActivity,
} from './desktopWindowActivity'

afterEach(() => {
  delete window.__commandoDesktopWindowActive
  vi.restoreAllMocks()
})

describe('desktop window activity', () => {
  it('uses native key-window events as the authoritative state', () => {
    window.__commandoDesktopWindowActive = false
    const view = renderHook(() => useDesktopWindowActivity())
    expect(view.result.current).toBe(false)

    act(() => {
      window.dispatchEvent(new CustomEvent(DESKTOP_WINDOW_ACTIVITY_EVENT, { detail: true }))
    })
    expect(view.result.current).toBe(true)

    act(() => {
      window.dispatchEvent(new CustomEvent(DESKTOP_WINDOW_ACTIVITY_EVENT, { detail: false }))
    })
    expect(view.result.current).toBe(false)
  })

  it('stays active when focus moves from the web view to a native terminal', () => {
    window.__commandoDesktopWindowActive = true
    const view = renderHook(() => useDesktopWindowActivity())
    expect(view.result.current).toBe(true)

    act(() => window.dispatchEvent(new Event('blur')))
    expect(view.result.current).toBe(true)

    act(() => {
      window.dispatchEvent(new CustomEvent(DESKTOP_WINDOW_ACTIVITY_EVENT, { detail: false }))
    })
    expect(view.result.current).toBe(false)
  })

  it('uses DOM focus when no native key-window state is available', () => {
    const hasFocus = vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    const view = renderHook(() => useDesktopWindowActivity())
    expect(view.result.current).toBe(true)

    hasFocus.mockReturnValue(false)
    act(() => window.dispatchEvent(new Event('blur')))
    expect(view.result.current).toBe(false)

    hasFocus.mockReturnValue(true)
    act(() => window.dispatchEvent(new Event('focus')))
    expect(view.result.current).toBe(true)
  })

  it('ignores malformed native activity messages', () => {
    window.__commandoDesktopWindowActive = false
    const view = renderHook(() => useDesktopWindowActivity())

    act(() => {
      window.dispatchEvent(new CustomEvent(DESKTOP_WINDOW_ACTIVITY_EVENT, { detail: 'true' }))
    })

    expect(view.result.current).toBe(false)
  })
})
