import { useSyncExternalStore } from 'react'
import { DEFAULT_DIFF_FILTERS, type DiffFilters, type DiffFiltersChange } from '../shared/diff-filters'
import { createOwnerJsonRequest } from './webPanesApi'

/**
 * The daemon's diff filters, shared by every diff view in this window. App
 * feeds it from the socket and supplies how to save a change; views read it
 * with `useDiffFilters` and save with `updateDiffFilters`.
 *
 * What views see is the last state the daemon confirmed, with any switch
 * flips still being saved laid on top. A flip leaves that overlay when its
 * save settles, so a failed save simply disappears, whatever the order.
 */
type Flip = Pick<DiffFiltersChange, 'hideTests' | 'hideGenerated'>
let confirmed: DiffFilters = DEFAULT_DIFF_FILTERS
let current: DiffFilters = DEFAULT_DIFF_FILTERS
const flips = new Map<number, Flip>()
let nextSave = 0
let save: ((change: DiffFiltersChange) => Promise<DiffFilters>) | null = null
/** Bumped on a host switch so answers from the old daemon are dropped. */
let generation = 0
const listeners = new Set<() => void>()

function publish(): void {
  current = [...flips.values()].reduce<DiffFilters>((view, flip) => ({ ...view, ...flip }), confirmed)
  for (const listener of listeners) listener()
}

export function currentDiffFilters(): DiffFilters { return current }

/** The daemon's state: socket updates arrive in daemon order, so they always apply. */
export function setDiffFilters(filters: DiffFilters): void {
  confirmed = filters
  publish()
}

/** How this window saves a change; null while it can't (no daemon). */
export function setDiffFiltersSaver(saver: typeof save): void { save = saver }

/** Forgets a daemon's filters (on a host switch) and ignores late answers from it. */
export function resetDiffFilters(): void {
  generation += 1
  flips.clear()
  setDiffFilters(DEFAULT_DIFF_FILTERS)
}

export function useDiffFilters(): DiffFilters {
  return useSyncExternalStore((listener) => {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  }, () => current)
}

/**
 * Saves a change; switch flips show at once. The daemon's answer becomes the
 * confirmed state only if nothing newer has arrived meanwhile (another
 * window's change, or a later save of ours), judged by revision.
 */
export async function updateDiffFilters(change: DiffFiltersChange): Promise<void> {
  if (!save) throw new Error('Not connected to Commando')
  const started = generation, id = ++nextSave
  const flip: Flip = {
    ...(change.hideTests !== undefined ? { hideTests: change.hideTests } : {}),
    ...(change.hideGenerated !== undefined ? { hideGenerated: change.hideGenerated } : {}),
  }
  if (Object.keys(flip).length) { flips.set(id, flip); publish() }
  try {
    const saved = await save(change)
    if (started === generation && saved.revision >= confirmed.revision) confirmed = saved
  } finally {
    flips.delete(id)
    publish()
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
