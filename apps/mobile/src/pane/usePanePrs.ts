import { useEffect, useState } from 'react'
import type { Host } from '../hosts/types'
import { panePrCache, type PanePrResult } from './prCache'

export function usePanePrs(host: Host | undefined, paneIds: readonly string[], active: boolean): PanePrResult[] {
  const [lists, setLists] = useState<Record<string, PanePrResult>>({})
  const key = paneIds.join(',')
  useEffect(() => {
    setLists({})
    if (!host || !active) return
    const subscriptions = key.split(',').filter(Boolean).map((paneId) => panePrCache.subscribe(host, paneId, (result) => setLists((current) => ({ ...current, [paneId]: result }))))
    return () => subscriptions.forEach((unsubscribe) => unsubscribe())
  }, [host, key, active])
  return Object.values(lists)
}
