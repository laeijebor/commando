import { useCallback, useEffect, useRef, useState } from 'react'
import type { AgentStatus, TmuxPane } from '../shared/protocol'
import { parentLabel, type LineageSnapshot } from './chatLineage'
import './agent-chat.css'

const VISIBLE_MS = 6_000

export function usePaneAttribution() {
  const seen = useRef<Set<string> | null>(null)
  const [expires, setExpires] = useState<Record<string, number>>({})
  const observe = useCallback((panes: readonly TmuxPane[]) => {
    if (seen.current === null) {
      seen.current = new Set(panes.map((pane) => pane.targetId))
      return
    }
    const added: Record<string, number> = {}
    for (const pane of panes) {
      if (!seen.current.has(pane.targetId) && pane.openedBy) added[pane.targetId] = Date.now() + VISIBLE_MS
      seen.current.add(pane.targetId)
    }
    if (Object.keys(added).length) setExpires((current) => ({ ...current, ...added }))
  }, [])
  useEffect(() => {
    const times = Object.values(expires)
    if (!times.length) return
    const timer = window.setTimeout(() => {
      setExpires((current) => Object.fromEntries(Object.entries(current).filter(([, expiry]) => expiry > Date.now())))
    }, Math.max(0, Math.min(...times) - Date.now()))
    return () => window.clearTimeout(timer)
  }, [expires])
  return { observe, visibleTargets: new Set(Object.keys(expires)) }
}

export function PaneAttributionToast({ pane, snapshot, statuses }: { pane: TmuxPane; snapshot: LineageSnapshot; statuses: Record<string, AgentStatus> }) {
  return <div className="pane-attribution-toast" role="status" data-native-terminal-occluder=""><strong>{parentLabel(pane, snapshot, statuses)}</strong> opened this chat</div>
}
