export type CachedPrRead<T> = {
  value: T
  fetchedAt: number
  stale?: boolean
  retryAt?: number
  warning?: string
}

type Entry<T> = { snapshot?: CachedPrRead<T>; refresh?: Promise<CachedPrRead<T>> }

/** Bounded per-resource cache. Invalidated in-flight reads cannot repopulate it. */
export class PrReadCache<T> {
  private readonly entries = new Map<string, Entry<T>>()

  constructor(private readonly ttlMs: number, private readonly now: () => number, private readonly maxEntries = 100) {}

  peek(key: string): T | undefined { return this.entries.get(key)?.snapshot?.value }

  invalidate(prefix: string): void {
    for (const key of this.entries.keys()) if (key.startsWith(prefix)) this.entries.delete(key)
  }

  read(key: string, load: () => Promise<T>, refresh = false): Promise<CachedPrRead<T>> {
    let entry = this.entries.get(key)
    if (entry?.refresh) return entry.refresh
    if (!refresh && entry?.snapshot && this.now() - entry.snapshot.fetchedAt < this.ttlMs) {
      return Promise.resolve(entry.snapshot)
    }
    if (!entry) { entry = {}; this.entries.set(key, entry) }
    const current = entry
    current.refresh = load().then((value) => {
      const snapshot = { value, fetchedAt: this.now() }
      current.snapshot = snapshot
      return snapshot
    }).catch((cause: unknown) => {
      const error = cause as { code?: string; retryAt?: number; message?: string }
      if (error?.code === 'rate_limited' && current.snapshot) {
        return { ...current.snapshot, stale: true, retryAt: error.retryAt, warning: error.message }
      }
      throw cause
    }).finally(() => {
      current.refresh = undefined
      if (!current.snapshot && this.entries.get(key) === current) this.entries.delete(key)
      this.trim()
    })
    return current.refresh
  }

  private trim(): void {
    if (this.entries.size <= this.maxEntries) return
    const oldest = [...this.entries].filter(([, entry]) => !entry.refresh)
      .sort((a, b) => (a[1].snapshot?.fetchedAt ?? 0) - (b[1].snapshot?.fetchedAt ?? 0))
    for (const [key] of oldest) {
      if (this.entries.size <= this.maxEntries) break
      this.entries.delete(key)
    }
  }
}
