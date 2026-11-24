import { useEffect, useRef, useState } from 'react'

export function usePageVisible(): boolean {
  const [visible, setVisible] = useState(() => document.visibilityState !== 'hidden')
  useEffect(() => {
    const change = () => setVisible(document.visibilityState !== 'hidden')
    document.addEventListener('visibilitychange', change)
    return () => document.removeEventListener('visibilitychange', change)
  }, [])
  return visible
}

/** Repeats `load` every `intervalMs` while the page is visible; `key` restarts it. */
export function usePoll<T>(load: (() => Promise<T>) | null, intervalMs: number, key: unknown): { value?: T; error?: string } {
  const visible = usePageVisible()
  const [state, setState] = useState<{ key: unknown; value?: T; error?: string }>({ key })
  const loadRef = useRef(load)
  loadRef.current = load
  useEffect(() => {
    if (!visible || !loadRef.current) return
    let cancelled = false
    let busy = false
    const tick = () => {
      const run = loadRef.current
      if (busy || !run) return
      busy = true
      run()
        .then((value) => { if (!cancelled) setState({ key, value }) })
        // A failed refresh keeps this key's last value; another key's value is never shown under it.
        .catch((cause: unknown) => { if (!cancelled) setState((current) => ({ ...current.key === key ? current : {}, key, error: cause instanceof Error ? cause.message : 'Request failed' })) })
        .finally(() => { busy = false })
    }
    tick()
    const timer = window.setInterval(tick, intervalMs)
    return () => { cancelled = true; window.clearInterval(timer) }
  }, [visible, intervalMs, key, Boolean(load)])
  return state.key === key ? state : {}
}
