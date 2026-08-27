import { useEffect, useState } from 'react'

export const DESKTOP_WINDOW_ACTIVITY_EVENT = 'commando:desktop-window-active'

declare global {
  interface Window {
    __commandoDesktopWindowActive?: boolean
  }
}

function pageIsVisible(): boolean {
  return document.visibilityState !== 'hidden'
}

function currentActivity(): boolean {
  if (!pageIsVisible()) return false
  if (typeof window.__commandoDesktopWindowActive === 'boolean') {
    return window.__commandoDesktopWindowActive
  }
  return document.hasFocus()
}

export function useDesktopWindowActivity(): boolean {
  const [active, setActive] = useState(currentActivity)

  useEffect(() => {
    const handleNativeActivity = (event: Event) => {
      const value = (event as CustomEvent<unknown>).detail
      if (typeof value !== 'boolean') return
      window.__commandoDesktopWindowActive = value
      setActive(value && pageIsVisible())
    }
    const handleFocus = () => setActive(currentActivity())
    const handleBlur = () => setActive(currentActivity())
    const handleVisibility = () => setActive(currentActivity())

    window.addEventListener(DESKTOP_WINDOW_ACTIVITY_EVENT, handleNativeActivity)
    window.addEventListener('focus', handleFocus)
    window.addEventListener('blur', handleBlur)
    document.addEventListener('visibilitychange', handleVisibility)
    return () => {
      window.removeEventListener(DESKTOP_WINDOW_ACTIVITY_EVENT, handleNativeActivity)
      window.removeEventListener('focus', handleFocus)
      window.removeEventListener('blur', handleBlur)
      document.removeEventListener('visibilitychange', handleVisibility)
    }
  }, [])

  return active
}
