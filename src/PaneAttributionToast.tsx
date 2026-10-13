import { useCallback, useEffect, useRef, useState } from 'react'
import type { AgentStatus, TmuxPane } from '../shared/protocol'
import { parentLabel, type LineageSnapshot } from './chatLineage'
import './agent-chat.css'

const VISIBLE_MS = 6_000
const LINEAGE_GRACE_MS = 5_000

export function usePaneAttribution() {
  const firstSeen = useRef<Map<string, number | null> | null>(null)
  const announced = useRef(new Set<string>())
  const [expires, setExpires] = useState<Record<string, number>>({})
  const isRecentTarget = useCallback((targetId: string) => {
    const first = firstSeen.current?.get(targetId)
    return first != null && Date.now() - first <= LINEAGE_GRACE_MS
  }, [])
  const observe = useCallback((panes: readonly TmuxPane[]) => {
    if (firstSeen.current === null) {
      firstSeen.current = new Map(panes.map((pane) => [pane.targetId, null]))
      return
    }
    const now = Date.now()
    const added: Record<string, number> = {}
    for (const pane of panes) {
      if (!firstSeen.current.has(pane.targetId)) firstSeen.current.set(pane.targetId, now)
      if (pane.openedBy && isRecentTarget(pane.targetId) && !announced.current.has(pane.targetId)) {
        added[pane.targetId] = now + VISIBLE_MS
        announced.current.add(pane.targetId)
      }
    }
    if (Object.keys(added).length) setExpires((current) => ({ ...current, ...added }))
  }, [isRecentTarget])
  useEffect(() => {
    const times = Object.values(expires)
    if (!times.length) return
    const timer = window.setTimeout(() => {
      setExpires((current) => Object.fromEntries(Object.entries(current).filter(([, expiry]) => expiry > Date.now())))
    }, Math.max(0, Math.min(...times) - Date.now()))
    return () => window.clearTimeout(timer)
  }, [expires])
  return { observe, isRecentTarget, visibleTargets: new Set(Object.keys(expires)) }
}

export function PaneAttributionToast({ pane, snapshot, statuses }: { pane: TmuxPane; snapshot: LineageSnapshot; statuses: Record<string, AgentStatus> }) {
  return <div className="pane-attribution-toast" role="status" data-native-terminal-occluder=""><strong>{parentLabel(pane, snapshot, statuses)}</strong> opened this chat</div>
}
