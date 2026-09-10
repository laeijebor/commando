export const DESKTOP_WINDOW_PRESENTING_EVENT = 'commando:desktop-window-presenting'
export const PRESENTING_ATTRIBUTE = 'data-commando-presenting'

declare global {
  interface Window {
    __commandoDesktopWindowPresenting?: boolean
  }
}

type PresentingListener = (presenting: boolean) => void

const listeners = new Set<PresentingListener>()
let tracking = false
let published: boolean | null = null

function pageIsVisible(): boolean {
  return document.visibilityState !== 'hidden'
}

/**
 * Whether Commando's UI can actually be seen right now. Perpetual work - the
 * status pulses, the native tiles' frame publishing - is gated on this so a
 * window nobody is looking at costs nothing.
 *
 * Deliberately not keyed on focus, unlike `useDesktopWindowActivity`: Commando
 * is meant to be watched while you work in another app, so a visible-but-not-key
 * window has to keep animating. Only two things count as not presenting - the
 * page being hidden (minimised, background tab), and the desktop shell
 * reporting its window fully occluded.
 */
export function isPresenting(): boolean {
  if (!pageIsVisible()) return false
  if (typeof window.__commandoDesktopWindowPresenting === 'boolean') {
    return window.__commandoDesktopWindowPresenting
  }
  return true
}

function reflect(): void {
  const presenting = isPresenting()
  // Drives the CSS that parks every running animation - see styles.css.
  document.documentElement.setAttribute(PRESENTING_ATTRIBUTE, presenting ? 'true' : 'false')
  if (presenting === published) return
  published = presenting
  for (const listener of [...listeners]) listener(presenting)
}

/** Subscribers are notified only while tracking is running. */
export function subscribeToPresenting(listener: PresentingListener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Called once from the app entry. Returns a disposer for tests. */
export function startPresentingTracking(): () => void {
  if (tracking) return () => {}
  tracking = true
  published = null

  const handleNativePresenting = (event: Event) => {
    const value = (event as CustomEvent<unknown>).detail
    if (typeof value !== 'boolean') return
    window.__commandoDesktopWindowPresenting = value
    reflect()
  }
  const handleVisibility = () => reflect()

  window.addEventListener(DESKTOP_WINDOW_PRESENTING_EVENT, handleNativePresenting)
  document.addEventListener('visibilitychange', handleVisibility)
  reflect()

  return () => {
    window.removeEventListener(DESKTOP_WINDOW_PRESENTING_EVENT, handleNativePresenting)
    document.removeEventListener('visibilitychange', handleVisibility)
    document.documentElement.removeAttribute(PRESENTING_ATTRIBUTE)
    tracking = false
    published = null
  }
}
