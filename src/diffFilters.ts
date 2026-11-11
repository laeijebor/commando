import { useSyncExternalStore } from 'react'
import { DEFAULT_DIFF_FILTERS, type DiffFilters, type DiffFiltersChange } from '../shared/diff-filters'
import { createOwnerJsonRequest } from './webPanesApi'

/**
 * The daemon's diff filters, shared by every diff view in this window. App
 * feeds it from the socket and supplies how to save a change; views read it
 * with `useDiffFilters` and save with `updateDiffFilters`.
 */
let current: DiffFilters = DEFAULT_DIFF_FILTERS
let save: ((change: DiffFiltersChange) => Promise<DiffFilters>) | null = null
let latestSave = 0
const listeners = new Set<() => void>()

export function currentDiffFilters(): DiffFilters { return current }

export function setDiffFilters(filters: DiffFilters): void {
  current = filters
  for (const listener of listeners) listener()
}

/** How this window saves a change; null while it can't (no daemon). */
export function setDiffFiltersSaver(saver: typeof save): void { save = saver }

/** Forgets a daemon's filters (on a host switch) and ignores late answers from it. */
export function resetDiffFilters(): void {
  latestSave += 1
  setDiffFilters(DEFAULT_DIFF_FILTERS)
}

export function useDiffFilters(): DiffFilters {
  return useSyncExternalStore((listener) => {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  }, () => current)
}

/** Saves a change; the switches flip at once and settle on the daemon's answer to the newest save. */
export async function updateDiffFilters(change: DiffFiltersChange): Promise<void> {
  if (!save) throw new Error('Not connected to Commando')
  const id = ++latestSave
  const previous = current
  let optimistic: DiffFilters | undefined
  if (change.hideTests !== undefined || change.hideGenerated !== undefined) {
    optimistic = { ...current, ...(change.hideTests !== undefined ? { hideTests: change.hideTests } : {}), ...(change.hideGenerated !== undefined ? { hideGenerated: change.hideGenerated } : {}) }
    setDiffFilters(optimistic)
  }
  try {
    const saved = await save(change)
    if (id === latestSave) setDiffFilters(saved)
  } catch (error) {
    // Undo the flip only if nothing has replaced it since.
    if (optimistic && current === optimistic) setDiffFilters(previous)
    throw error
  }
}

export function createDiffFiltersApi(token: string, fetcher: typeof fetch = fetch) {
  const request = createOwnerJsonRequest(token, fetcher)
  return async (change: DiffFiltersChange): Promise<DiffFilters> => {
    const result = await request('/api/diff-filters', { method: 'PUT', body: JSON.stringify(change) }) as { ok?: boolean; filters?: DiffFilters; error?: string } | null
    if (!result?.ok || !result.filters) throw new Error(result?.error ?? 'Could not save diff filters')
    return result.filters
  }
}
