import { fetchPanePrs, type PanePrList } from '../daemon/paneApi'
import type { Host } from '../hosts/types'

export type PanePrResult = { data?: PanePrList; error?: string }
type Listener = (result: PanePrResult) => void
const PERIOD = 60_000
/** One bounded cache and timer for every visible consumer; requests are deduplicated. */
export class PanePrCache {
  private cache = new Map<string, { result: PanePrResult; at: number }>()
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
    if (cached) listener(cached.result)
    void this.load(key)
    if (!this.timer) this.timer = setInterval(() => { for (const id of this.watchers.keys()) void this.load(id) }, PERIOD)
    return () => {
      watcher.listeners.delete(listener)
      if (!watcher.listeners.size) this.watchers.delete(key)
      if (!this.watchers.size && this.timer) { clearInterval(this.timer); this.timer = undefined }
    }
  }
  /** Re-reads every watched pane list on `host` now, e.g. after a PR there was merged (the daemon drops its own copy then). */
  async refreshHost(host: Host): Promise<void> {
    const prefix = `${host.id}:${host.baseUrl}:`
    await Promise.all([...this.watchers.keys()].filter((key) => key.startsWith(prefix)).map(async (key) => {
      // Let a read already in flight finish, then read again: it may predate the change.
      await this.loading.get(key)
      this.cache.delete(key)
      await this.load(key, false)
    }))
  }
  private async load(key: string, background = true): Promise<void> {
    const watcher = this.watchers.get(key)
    if (!watcher || this.loading.has(key)) return
    const cached = this.cache.get(key)
    if (cached && Date.now() - cached.at < PERIOD) return
    // Register before invoking the fetch, so even synchronous fake transports deduplicate.
    const load = Promise.resolve().then(async () => {
      try {
        const list = await fetchPanePrs(watcher.host, watcher.paneId, { background })
        if (!list) throw new Error('PR lookup failed')
        this.publish(key, { data: list })
      } catch (reason) {
        const error = (reason instanceof Error ? reason.message : typeof reason === 'string' ? reason : '') || 'PR lookup failed'
        this.publish(key, { data: this.cache.get(key)?.result.data, error })
      }
      finally { this.loading.delete(key) }
    })
    this.loading.set(key, load)
    await load
  }
  private publish(key: string, result: PanePrResult): void {
    this.cache.delete(key)
    this.cache.set(key, { result, at: Date.now() })
    while (this.cache.size > this.maxEntries) this.cache.delete(this.cache.keys().next().value!)
    this.watchers.get(key)?.listeners.forEach((notify) => notify(result))
  }
  get size(): number { return this.cache.size }
}
export const panePrCache = new PanePrCache()
