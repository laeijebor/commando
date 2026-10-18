import { useEffect, useRef, useState } from 'react'

const pending = new Map<string, Promise<unknown>>()
/** Poll only after the previous request finishes; focus changes share an in-flight read. */
export function usePollingQuery<T>(key: string, load: () => Promise<T>, active: boolean, intervalMs = 15_000): { data?: T; error?: unknown } {
  const loader = useRef(load)
  loader.current = load
  const [result, setResult] = useState<{ key: string; data?: T; error?: unknown }>({ key })
  useEffect(() => {
    if (!active) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const refresh = async () => {
      try {
        let request = pending.get(key) as Promise<T> | undefined
        if (!request) {
          const read = loader.current
          request = Promise.resolve().then(read)
          pending.set(key, request)
          void request.finally(() => { if (pending.get(key) === request) pending.delete(key) }).catch(() => undefined)
        }
        const data = await request
        if (!cancelled) setResult({ key, data })
      } catch (error) {
        if (!cancelled) setResult((current) => ({ key, data: current.key === key ? current.data : undefined, error }))
      } finally {
        if (!cancelled) timer = setTimeout(() => void refresh(), intervalMs)
      }
    }
    void refresh()
    return () => { cancelled = true; if (timer) clearTimeout(timer) }
  }, [key, active, intervalMs])
  return result.key === key ? result : {}
}
