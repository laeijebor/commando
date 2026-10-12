import { useCallback, useSyncExternalStore } from 'react'
import type { GitDiffApiClient, GitDiffSummary } from './gitApi'

const stores = new WeakMap<GitDiffApiClient, Map<string, Entry>>()
type Entry = { summary: GitDiffSummary | null; listeners: Set<() => void>; timer?: number; generation: number }

/** The footer and panel share one 15s summary poll per worktree. */
export function usePaneGitSummary(paneId: string, panePath: string, api: GitDiffApiClient, connected: boolean) {
  let entries = stores.get(api)
  if (!entries) { entries = new Map(); stores.set(api, entries) }
  const key = `${paneId}\0${panePath}`
  let entry = entries.get(key)
  if (!entry) { entry = { summary: null, listeners: new Set(), generation: 0 }; entries.set(key, entry) }
  const current = entry
  const subscribe = useCallback((listener: () => void) => {
    if (!connected) return () => undefined
    current.listeners.add(listener)
    if (current.listeners.size === 1) {
      const generation = ++current.generation
      const refresh = async () => {
        let summary: GitDiffSummary | null = null
        try { summary = await api.summary(paneId) } catch { return }
        if (current.generation !== generation) return
        current.summary = summary
        current.listeners.forEach((notify) => notify())
      }
      void refresh()
      current.timer = window.setInterval(() => { void refresh() }, 15_000)
    }
    return () => {
      current.listeners.delete(listener)
      if (!current.listeners.size) {
        window.clearInterval(current.timer)
        current.generation++
      }
    }
  }, [current, api, paneId, connected])
  return useSyncExternalStore(subscribe, () => current.summary)
}
