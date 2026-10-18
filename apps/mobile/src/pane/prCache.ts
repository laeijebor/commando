import { fetchPanePrs, type PanePrList } from '../daemon/paneApi'
import type { Host } from '../hosts/types'

type Listener = (list: PanePrList) => void
const PERIOD = 60_000
/** One bounded cache and timer for every visible consumer; requests are deduplicated. */
export class PanePrCache {
  private cache = new Map<string, { list: PanePrList; at: number }>()
  private watchers = new Map<string, { host: Host; paneId: string; listeners: Set<Listener> }>()
  private loading = new Map<string, Promise<void>>()
  private timer: ReturnType<typeof setInterval> | undefined
  constructor(private maxEntries = 128) {}
  subscribe(host: Host, paneId: string, listener: Listener): () => void {
    const key = `${host.id}:${host.baseUrl}:${paneId}`
    const watcher = this.watchers.get(key) ?? { host, paneId, listeners: new Set<Listener>() }
    watcher.listeners.add(listener)
    this.watchers.set(key, watcher)
    const cached = this.cache.get(key)
    if (cached) listener(cached.list)
    void this.load(key)
    if (!this.timer) this.timer = setInterval(() => { for (const id of this.watchers.keys()) void this.load(id) }, PERIOD)
    return () => {
      watcher.listeners.delete(listener)
      if (!watcher.listeners.size) this.watchers.delete(key)
      if (!this.watchers.size && this.timer) { clearInterval(this.timer); this.timer = undefined }
    }
  }
  private async load(key: string): Promise<void> {
    const watcher = this.watchers.get(key)
    if (!watcher || this.loading.has(key)) return
    const cached = this.cache.get(key)
    if (cached && Date.now() - cached.at < PERIOD) return
    // Register before invoking the fetch, so even synchronous fake transports deduplicate.
    const load = Promise.resolve().then(async () => {
      try {
        const list = await fetchPanePrs(watcher.host, watcher.paneId, { background: true })
        if (!list) return
        this.cache.delete(key)
        this.cache.set(key, { list, at: Date.now() })
        while (this.cache.size > this.maxEntries) this.cache.delete(this.cache.keys().next().value!)
        this.watchers.get(key)?.listeners.forEach((notify) => notify(list))
      } catch { /* The cached badge remains useful while offline. */ }
      finally { this.loading.delete(key) }
    })
    this.loading.set(key, load)
    await load
  }
  get size(): number { return this.cache.size }
}
export const panePrCache = new PanePrCache()
