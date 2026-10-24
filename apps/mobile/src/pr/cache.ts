import { useCallback, useEffect, useRef, useState } from 'react'

export type PrResource<T> = { value?: T; error?: string; at: number; loading: boolean }

type Listener = () => void

/**
 * One bounded, in-memory store for the PR screens' reads. Switching tabs,
 * leaving and reopening a PR, or showing it in the pane and the full screen at
 * once all share one copy and one in-flight request. Nothing polls: a read is
 * repeated only when a screen asks for it after `ttlMs`, or when the owner
 * pulls to refresh — the daemon's own GitHub caches and rate-limit pauses sit
 * behind every request.
 */
export class PrResourceCache {
  private entries = new Map<string, PrResource<unknown>>()
  private loading = new Map<string, Promise<void>>()
  private listeners = new Map<string, Set<Listener>>()

  constructor(private maxEntries = 24) {}

  peek<T>(key: string): PrResource<T> | undefined {
    return this.entries.get(key) as PrResource<T> | undefined
  }

  subscribe(key: string, listener: Listener): () => void {
    const set = this.listeners.get(key) ?? new Set<Listener>()
    set.add(listener)
    this.listeners.set(key, set)
    return () => {
      set.delete(listener)
      if (!set.size) this.listeners.delete(key)
    }
  }

  /** Reads `key` unless a fresh copy is held or a read is already running; a forced read waits for any running one first. */
  async load<T>(key: string, fetcher: () => Promise<T>, options: { ttlMs: number; force?: boolean }): Promise<void> {
    let running = this.loading.get(key)
    while (running) {
      await running
      if (!options.force) return
      // Another forced read may have started while this one waited; share it rather than racing it.
      const next = this.loading.get(key)
      if (next && next !== running) {
        await next
        return
      }
      running = next
    }
    const current = this.entries.get(key)
    if (!options.force && current && current.value !== undefined && Date.now() - current.at < options.ttlMs) return
    this.set(key, { ...(current ?? { at: 0 }), loading: true })
    const read = Promise.resolve().then(fetcher).then(
      (value) => { this.set(key, { value, at: Date.now(), loading: false }) },
      (reason: unknown) => {
        const error = (reason instanceof Error ? reason.message : typeof reason === 'string' ? reason : '') || 'Request failed'
        // Keep the last good copy on screen beside the error.
        this.set(key, { value: this.entries.get(key)?.value, error, at: Date.now(), loading: false })
      },
    ).finally(() => { if (this.loading.get(key) === read) this.loading.delete(key) })
    this.loading.set(key, read)
    await read
  }

  get size(): number { return this.entries.size }

  private set(key: string, entry: PrResource<unknown>): void {
    this.entries.delete(key)
    this.entries.set(key, entry)
    // Oldest first, skipping anything a screen still shows or is still reading.
    for (const candidate of [...this.entries.keys()]) {
      if (this.entries.size <= this.maxEntries) break
      if (!this.listeners.has(candidate) && !this.loading.has(candidate)) this.entries.delete(candidate)
    }
    this.listeners.get(key)?.forEach((notify) => notify())
  }
}

export const prResourceCache = new PrResourceCache()

/**
 * Subscribes to `key` and reads it while `enabled`. A null key, or a disabled
 * screen, reads nothing; the returned `refresh` forces a new read.
 */
export function usePrResource<T>(
  key: string | null,
  fetcher: (refresh: boolean) => Promise<T>,
  { enabled, ttlMs, cache = prResourceCache }: { enabled: boolean; ttlMs: number; cache?: PrResourceCache },
): { data?: T; error?: string; loading: boolean; refresh: () => Promise<void> } {
  const latest = useRef(fetcher)
  latest.current = fetcher
  const [, rerender] = useState(0)
  useEffect(() => {
    if (!key) return
    return cache.subscribe(key, () => rerender((value) => value + 1))
  }, [cache, key])
  useEffect(() => {
    if (!key || !enabled) return
    void cache.load(key, () => latest.current(false), { ttlMs })
  }, [cache, key, enabled, ttlMs])
  const refresh = useCallback(async () => {
    if (key) await cache.load(key, () => latest.current(true), { ttlMs, force: true })
  }, [cache, key, ttlMs])
  const entry = key ? cache.peek<T>(key) : undefined
  return {
    ...(entry?.value !== undefined ? { data: entry.value } : {}),
    ...(entry?.error ? { error: entry.error } : {}),
    loading: Boolean(entry?.loading) || (enabled && Boolean(key) && !entry),
    refresh,
  }
}
