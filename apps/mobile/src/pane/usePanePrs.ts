import { useEffect, useState } from 'react'
import type { PanePrList } from '../daemon/paneApi'
import type { Host } from '../hosts/types'
import { panePrCache } from './prCache'

export function usePanePrs(host: Host | undefined, paneIds: readonly string[], active: boolean): PanePrList[] {
  const [lists, setLists] = useState<Record<string, PanePrList>>({})
  const key = paneIds.join(',')
  useEffect(() => {
    setLists({})
    if (!host || !active) return
    const subscriptions = key.split(',').filter(Boolean).map((paneId) => panePrCache.subscribe(host, paneId, (list) => setLists((current) => ({ ...current, [paneId]: list }))))
    return () => subscriptions.forEach((unsubscribe) => unsubscribe())
  }, [host, key, active])
  return Object.values(lists)
}
