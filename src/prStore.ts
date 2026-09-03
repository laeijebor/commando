import { useCallback, useMemo, useSyncExternalStore } from 'react'

import type { PanePrList, PrList, PrsApiClient, PrStateFilter } from './prsApi'

export const PR_FOREGROUND_INTERVAL_MS = 30_000
export const PR_BACKGROUND_INTERVAL_MS = 5 * 60_000

type StoreApi = Pick<PrsApiClient, 'pane' | 'list'>

export type PrStoreSnapshot<T> = {
  list: T | null
  loading: boolean
  polling: boolean
  error: string
  errorCode: string
}

type Entry<T> = {
  snapshot: PrStoreSnapshot<T>
  listeners: Set<() => void>
  foreground: number
  background: number
  lastFetchedAt: number
  inFlight: Promise<void> | null
  load: (refresh: boolean) => Promise<T>
}

const EMPTY_PANE: PrStoreSnapshot<PanePrList> = { list: null, loading: false, polling: false, error: '', errorCode: '' }
const EMPTY_REPO: PrStoreSnapshot<PrList> = { list: null, loading: false, polling: false, error: '', errorCode: '' }
const stores = new WeakMap<object, PrStore>()

class PrStore {
  private readonly panes = new Map<string, Entry<PanePrList>>()
  private readonly repos = new Map<string, Entry<PrList>>()
  private timer: number | null = null
  private listeningForVisibility = false

  constructor(private readonly api: StoreApi) {}

  paneSnapshot(paneId: string): PrStoreSnapshot<PanePrList> {
    return this.panes.get(paneId)?.snapshot ?? EMPTY_PANE
  }

  repoSnapshot(repo: string, filter: PrStateFilter): PrStoreSnapshot<PrList> {
    return this.repos.get(this.repoKey(repo, filter))?.snapshot ?? EMPTY_REPO
  }

  subscribePane(paneId: string, background: boolean, listener: () => void): () => void {
    const entry = this.paneEntry(paneId)
    return this.subscribe(entry, background, listener)
  }

  subscribeRepo(repo: string, filter: PrStateFilter, listener: () => void): () => void {
    const entry = this.repoEntry(repo, filter)
    return this.subscribe(entry, false, listener)
  }

  refreshRepo(repo: string, filter: PrStateFilter): Promise<void> {
    return this.refresh(this.repoEntry(repo, filter), true)
  }

  private paneEntry(paneId: string): Entry<PanePrList> {
    let entry = this.panes.get(paneId)
    if (!entry) {
      entry = this.createEntry(() => this.api.pane(paneId), EMPTY_PANE)
      this.panes.set(paneId, entry)
    }
    return entry
  }

  private repoEntry(repo: string, filter: PrStateFilter): Entry<PrList> {
    const key = this.repoKey(repo, filter)
    let entry = this.repos.get(key)
    if (!entry) {
      entry = this.createEntry((refresh) => this.api.list(repo, filter, refresh ? { refresh: true } : undefined), EMPTY_REPO)
      this.repos.set(key, entry)
    }
    return entry
  }

  private repoKey(repo: string, filter: PrStateFilter): string {
    return `${repo}\0${filter}`
  }

  private createEntry<T>(load: (refresh: boolean) => Promise<T>, empty: PrStoreSnapshot<T>): Entry<T> {
    return { snapshot: empty, listeners: new Set(), foreground: 0, background: 0, lastFetchedAt: 0, inFlight: null, load }
  }

  private subscribe<T>(entry: Entry<T>, background: boolean, listener: () => void): () => void {
    entry.listeners.add(listener)
    if (background) entry.background += 1
    else entry.foreground += 1
    this.startScheduler()
    if (document.visibilityState !== 'hidden') void this.refresh(entry, false)
    return () => {
      entry.listeners.delete(listener)
      if (background) entry.background -= 1
      else entry.foreground -= 1
      this.stopSchedulerIfIdle()
    }
  }

  private refresh<T>(entry: Entry<T>, force: boolean): Promise<void> {
    if (entry.inFlight) return entry.inFlight
    const hasList = entry.snapshot.list !== null
    entry.snapshot = { ...entry.snapshot, loading: !hasList, polling: hasList, error: '', errorCode: '' }
    this.emit(entry)
    const operation = entry.load(force)
      .then((list) => {
        entry.snapshot = { list, loading: false, polling: false, error: '', errorCode: '' }
      })
      .catch((cause: unknown) => {
        entry.snapshot = {
          ...entry.snapshot,
          loading: false,
          polling: false,
          error: cause instanceof Error ? cause.message : 'Unable to load pull requests',
          errorCode: (cause as { code?: string })?.code ?? '',
        }
      })
      .finally(() => {
        entry.lastFetchedAt = Date.now()
        entry.inFlight = null
        this.emit(entry)
      })
    entry.inFlight = operation
    return operation
  }

  private emit<T>(entry: Entry<T>): void {
    for (const listener of entry.listeners) listener()
  }

  private activeEntries(): Entry<PanePrList | PrList>[] {
    return [...this.panes.values(), ...this.repos.values()] as Entry<PanePrList | PrList>[]
  }

  private tick = (): void => {
    if (document.visibilityState === 'hidden') return
    const now = Date.now()
    for (const entry of this.activeEntries()) {
      const interval = entry.foreground > 0 ? PR_FOREGROUND_INTERVAL_MS : PR_BACKGROUND_INTERVAL_MS
      if (entry.foreground + entry.background > 0 && now - entry.lastFetchedAt >= interval) {
        void this.refresh(entry, false)
      }
    }
  }

  private startScheduler(): void {
    if (this.timer === null) this.timer = window.setInterval(this.tick, PR_FOREGROUND_INTERVAL_MS)
    if (!this.listeningForVisibility) {
      document.addEventListener('visibilitychange', this.tick)
      this.listeningForVisibility = true
    }
  }

  private stopSchedulerIfIdle(): void {
    if (this.activeEntries().some((entry) => entry.foreground + entry.background > 0)) return
    if (this.timer !== null) window.clearInterval(this.timer)
    this.timer = null
    if (this.listeningForVisibility) document.removeEventListener('visibilitychange', this.tick)
    this.listeningForVisibility = false
  }
}

function storeFor(api: StoreApi): PrStore {
  const key = api as object
  let store = stores.get(key)
  if (!store) {
    store = new PrStore(api)
    stores.set(key, store)
  }
  return store
}

export function usePanePrs(
  paneId: string,
  api: Pick<PrsApiClient, 'pane'>,
  { background, enabled = true }: { background: boolean; enabled?: boolean },
): PanePrList | null {
  const store = useMemo(() => storeFor(api as StoreApi), [api])
  const subscribe = useCallback((listener: () => void) => (
    enabled ? store.subscribePane(paneId, background, listener) : () => undefined
  ), [background, enabled, paneId, store])
  const getSnapshot = useCallback(() => enabled ? store.paneSnapshot(paneId) : EMPTY_PANE, [enabled, paneId, store])
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot).list
}

export function useRepoPrs(
  repo: string,
  filter: PrStateFilter,
  api: Pick<PrsApiClient, 'list'>,
  { enabled = true }: { enabled?: boolean } = {},
): PrStoreSnapshot<PrList> & { refresh: () => Promise<void> } {
  const store = useMemo(() => storeFor(api as StoreApi), [api])
  const active = enabled && Boolean(repo)
  const subscribe = useCallback((listener: () => void) => (
    active ? store.subscribeRepo(repo, filter, listener) : () => undefined
  ), [active, filter, repo, store])
  const getSnapshot = useCallback(() => repo ? store.repoSnapshot(repo, filter) : EMPTY_REPO, [filter, repo, store])
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  const refresh = useCallback(() => active ? store.refreshRepo(repo, filter) : Promise.resolve(), [active, filter, repo, store])
  return useMemo(() => ({ ...snapshot, refresh }), [refresh, snapshot])
}
