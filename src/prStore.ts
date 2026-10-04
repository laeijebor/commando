import { useCallback, useMemo, useRef, useSyncExternalStore } from 'react'

import type { PanePrList, PanePrSummary, PrList, PrScope, PrsApiClient, PrStateFilter } from './prsApi'

export const PR_FOREGROUND_INTERVAL_MS = 30_000
export const PR_BACKGROUND_INTERVAL_MS = 5 * 60_000
// The repo-wide list is the costliest query on busy repos.
export const PR_EVERYONE_INTERVAL_MS = 10 * 60_000

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
  interval: number
  lastFetchedAt: number
  retryAt: number
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

  repoSnapshot(repo: string, filter: PrStateFilter, scope: PrScope): PrStoreSnapshot<PrList> {
    return this.repos.get(this.repoKey(repo, filter, scope))?.snapshot ?? EMPTY_REPO
  }

  subscribePane(paneId: string, background: boolean, listener: () => void): () => void {
    const entry = this.paneEntry(paneId)
    return this.subscribe(entry, background, listener)
  }

  subscribeRepo(repo: string, filter: PrStateFilter, scope: PrScope, listener: () => void): () => void {
    const entry = this.repoEntry(repo, filter, scope)
    return this.subscribe(entry, false, listener)
  }

  refreshRepo(repo: string, filter: PrStateFilter, scope: PrScope): Promise<void> {
    return this.refresh(this.repoEntry(repo, filter, scope), true)
  }

  refreshPane(paneId: string): Promise<void> {
    return this.refresh(this.paneEntry(paneId), true)
  }

  private paneEntry(paneId: string): Entry<PanePrList> {
    let entry = this.panes.get(paneId)
    if (!entry) {
      entry = this.createEntry(() => this.api.pane(paneId), EMPTY_PANE, PR_FOREGROUND_INTERVAL_MS)
      this.panes.set(paneId, entry)
    }
    return entry
  }

  private repoEntry(repo: string, filter: PrStateFilter, scope: PrScope): Entry<PrList> {
    const key = this.repoKey(repo, filter, scope)
    let entry = this.repos.get(key)
    if (!entry) {
      entry = this.createEntry(
        (refresh) => this.api.list(repo, filter, { scope, ...(refresh ? { refresh: true } : {}) }),
        EMPTY_REPO,
        scope === 'everyone' ? PR_EVERYONE_INTERVAL_MS : PR_FOREGROUND_INTERVAL_MS,
      )
      this.repos.set(key, entry)
    }
    return entry
  }

  private repoKey(repo: string, filter: PrStateFilter, scope: PrScope): string {
    return `${repo}\0${filter}\0${scope}`
  }

  private createEntry<T>(load: (refresh: boolean) => Promise<T>, empty: PrStoreSnapshot<T>, interval: number): Entry<T> {
    return { snapshot: empty, listeners: new Set(), foreground: 0, background: 0, interval, lastFetchedAt: 0, retryAt: 0, inFlight: null, load }
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
        entry.retryAt = 0
      })
      .catch((cause: unknown) => {
        const retryAt = (cause as { retryAt?: unknown })?.retryAt
        entry.retryAt = typeof retryAt === 'number' ? retryAt : 0
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
      const interval = entry.foreground > 0 ? entry.interval : Math.max(entry.interval, PR_BACKGROUND_INTERVAL_MS)
      if (entry.foreground + entry.background > 0 && now - entry.lastFetchedAt >= interval && now >= entry.retryAt) {
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

type SessionPrSnapshot = {
  pullRequests: PanePrSummary[]
  loading: boolean
  error: string
  truncated: boolean
}
const EMPTY_SESSION_PRS: SessionPrSnapshot = { pullRequests: [], loading: false, error: '', truncated: false }

/** Distinct open PRs across panes, newest first, sharing existing polling entries. */
export function useSessionPrs(
  paneIds: readonly string[],
  api: Pick<PrsApiClient, 'pane'>,
  { enabled = true, background = true }: { enabled?: boolean; background?: boolean } = {},
) {
  const store = useMemo(() => storeFor(api as StoreApi), [api])
  const paneKey = JSON.stringify([...new Set(paneIds)].sort())
  const ids = useMemo(() => JSON.parse(paneKey) as string[], [paneKey])
  const cache = useRef<{ sources: PrStoreSnapshot<PanePrList>[]; snapshot: SessionPrSnapshot } | null>(null)
  const subscribe = useCallback((listener: () => void) => {
    if (!enabled) return () => undefined
    const unsubscribe = ids.map((id) => store.subscribePane(id, background, listener))
    return () => unsubscribe.forEach((stop) => stop())
  }, [background, enabled, ids, store])
  const getSnapshot = useCallback(() => {
    if (!enabled || ids.length === 0) return EMPTY_SESSION_PRS
    const sources = ids.map((id) => store.paneSnapshot(id))
    if (cache.current?.sources.length === sources.length && sources.every((source, index) => source === cache.current!.sources[index])) return cache.current.snapshot
    const prs = new Map<string, { pr: PanePrSummary; at: number }>()
    for (const source of sources) {
      for (const pr of source.list?.pullRequests ?? []) {
        const key = `${pr.repo.toLowerCase()}#${pr.number}`
        const at = source.list?.fetchedAt ?? 0
        if (!prs.has(key) || at > prs.get(key)!.at) prs.set(key, { pr, at })
      }
    }
    const snapshot = {
      pullRequests: [...prs.values()].map(({ pr }) => pr).filter((pr) => pr.state === 'open')
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.number - a.number || a.repo.localeCompare(b.repo)),
      loading: sources.some((source) => source.loading || (!source.list && !source.error)),
      error: sources.find((source) => source.error)?.error ?? '',
      truncated: sources.some((source) => source.list?.truncated),
    }
    cache.current = { sources, snapshot }
    return snapshot
  }, [enabled, ids, store])
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  const refresh = useCallback(() => enabled ? Promise.all(ids.map((id) => store.refreshPane(id))).then(() => undefined) : Promise.resolve(), [enabled, ids, store])
  return useMemo(() => ({ ...snapshot, refresh }), [snapshot, refresh])
}

export function useSessionPrCount(
  paneIds: readonly string[],
  api: Pick<PrsApiClient, 'pane'>,
  options: { enabled?: boolean } = {},
): number {
  return useSessionPrs(paneIds, api, options).pullRequests.length
}

export function useRepoPrs(
  repo: string,
  filter: PrStateFilter,
  api: Pick<PrsApiClient, 'list'>,
  { enabled = true, scope = 'mine' }: { enabled?: boolean; scope?: PrScope } = {},
): PrStoreSnapshot<PrList> & { refresh: () => Promise<void> } {
  const store = useMemo(() => storeFor(api as StoreApi), [api])
  const active = enabled && Boolean(repo)
  const subscribe = useCallback((listener: () => void) => (
    active ? store.subscribeRepo(repo, filter, scope, listener) : () => undefined
  ), [active, filter, repo, scope, store])
  const getSnapshot = useCallback(() => repo ? store.repoSnapshot(repo, filter, scope) : EMPTY_REPO, [filter, repo, scope, store])
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  const refresh = useCallback(() => active ? store.refreshRepo(repo, filter, scope) : Promise.resolve(), [active, filter, repo, scope, store])
  return useMemo(() => ({ ...snapshot, refresh }), [refresh, snapshot])
}
