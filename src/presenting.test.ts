// @vitest-environment jsdom

import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import {
  DESKTOP_WINDOW_PRESENTING_EVENT,
  PRESENTING_ATTRIBUTE,
  isPresenting,
  startPresentingTracking,
  subscribeToPresenting,
} from './presenting'

let stopTracking: (() => void) | null = null

function hidePage(hidden: boolean): void {
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue(hidden ? 'hidden' : 'visible')
}

afterEach(() => {
  stopTracking?.()
  stopTracking = null
  delete window.__commandoDesktopWindowPresenting
  vi.restoreAllMocks()
})

describe('presenting', () => {
  it('presents by default in a visible page with no desktop shell', () => {
    expect(isPresenting()).toBe(true)
  })

  it('stops presenting when the page is hidden', () => {
    hidePage(true)
    expect(isPresenting()).toBe(false)
  })

  it('treats the desktop occlusion signal as authoritative while visible', () => {
    window.__commandoDesktopWindowPresenting = false
    expect(isPresenting()).toBe(false)

    window.__commandoDesktopWindowPresenting = true
    expect(isPresenting()).toBe(true)
  })

  it('stays hidden when the page is hidden even if the shell reports presenting', () => {
    hidePage(true)
    window.__commandoDesktopWindowPresenting = true
    expect(isPresenting()).toBe(false)
  })

  it('keeps presenting when the window loses focus', () => {
    // Commando is watched while you work elsewhere, so blur must not park the
    // attention HUD the way it parks `useDesktopWindowActivity`.
    stopTracking = startPresentingTracking()
    window.dispatchEvent(new Event('blur'))
    expect(isPresenting()).toBe(true)
    expect(document.documentElement.getAttribute(PRESENTING_ATTRIBUTE)).toBe('true')
  })

  it('reflects the state onto the document element for the CSS gate', () => {
    stopTracking = startPresentingTracking()
    expect(document.documentElement.getAttribute(PRESENTING_ATTRIBUTE)).toBe('true')

    window.dispatchEvent(new CustomEvent(DESKTOP_WINDOW_PRESENTING_EVENT, { detail: false }))
    expect(document.documentElement.getAttribute(PRESENTING_ATTRIBUTE)).toBe('false')

    window.dispatchEvent(new CustomEvent(DESKTOP_WINDOW_PRESENTING_EVENT, { detail: true }))
    expect(document.documentElement.getAttribute(PRESENTING_ATTRIBUTE)).toBe('true')
  })

  it('notifies subscribers only when the state changes', () => {
    const listener = vi.fn()
    stopTracking = startPresentingTracking()
    const unsubscribe = subscribeToPresenting(listener)

    window.dispatchEvent(new CustomEvent(DESKTOP_WINDOW_PRESENTING_EVENT, { detail: false }))
    window.dispatchEvent(new CustomEvent(DESKTOP_WINDOW_PRESENTING_EVENT, { detail: false }))
    expect(listener.mock.calls).toEqual([[false]])

    window.dispatchEvent(new CustomEvent(DESKTOP_WINDOW_PRESENTING_EVENT, { detail: true }))
    expect(listener.mock.calls).toEqual([[false], [true]])

    unsubscribe()
    window.dispatchEvent(new CustomEvent(DESKTOP_WINDOW_PRESENTING_EVENT, { detail: false }))
    expect(listener.mock.calls).toEqual([[false], [true]])
  })

  it('ignores malformed desktop presenting messages', () => {
    stopTracking = startPresentingTracking()
    window.dispatchEvent(new CustomEvent(DESKTOP_WINDOW_PRESENTING_EVENT, { detail: 'false' }))
    expect(isPresenting()).toBe(true)
  })

  it('follows page visibility changes while tracking', () => {
    const listener = vi.fn()
    stopTracking = startPresentingTracking()
    const unsubscribe = subscribeToPresenting(listener)
    onTestFinished(unsubscribe)

    hidePage(true)
    document.dispatchEvent(new Event('visibilitychange'))
    expect(listener).toHaveBeenLastCalledWith(false)
    expect(document.documentElement.getAttribute(PRESENTING_ATTRIBUTE)).toBe('false')

    hidePage(false)
    document.dispatchEvent(new Event('visibilitychange'))
    expect(listener).toHaveBeenLastCalledWith(true)
  })
})
