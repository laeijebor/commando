import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

const WRITE_DELAY_MS = 2_000

/**
 * Per-pane values kept in a JSON file so they survive daemon restarts. Pane ids
 * only mean something within one tmux server (a new server numbers panes from
 * `%0` again), so the file records the server it belongs to and is discarded
 * when another one is bound. Nothing loaded is read back until `bindServer`
 * confirms the server, and nothing is saved before it. Writes are batched; a missing or damaged file starts empty.
 */
export class PaneStore<T> {
  private readonly values = new Map<string, T>()
  private loadedServerId: string | undefined
  private serverId: string | undefined
  private timer: NodeJS.Timeout | undefined

  constructor(private readonly path: string | undefined, valid: (value: unknown) => value is T) {
    if (!path) return
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as { serverId?: unknown; panes?: unknown }
      if (typeof parsed?.serverId !== 'string' || !parsed.panes || typeof parsed.panes !== 'object') return
      this.loadedServerId = parsed.serverId
      for (const [paneId, value] of Object.entries(parsed.panes)) {
        if (/^%\d+$/.test(paneId) && valid(value)) this.values.set(paneId, value)
      }
    } catch { /* First run, or a damaged file: start empty. */ }
  }

  /**
   * Confirms the tmux server. Returns true when the visible entries changed: the
   * first bind reveals what was loaded, and a different server drops them.
   */
  bindServer(serverId: string): boolean {
    if (this.serverId === serverId) return false
    const owner = this.serverId ?? this.loadedServerId
    if (owner !== undefined && owner !== serverId) this.values.clear()
    this.serverId = serverId
    this.scheduleWrite()
    return true
  }

  /** Loaded entries stay hidden until their server is confirmed. */
  private get visible(): boolean { return this.serverId !== undefined || this.loadedServerId === undefined }

  get(paneId: string): T | undefined { return this.visible ? this.values.get(paneId) : undefined }

  set(paneId: string, value: T): void {
    this.values.set(paneId, value)
    this.scheduleWrite()
  }

  snapshot(): Record<string, T> { return this.visible ? Object.fromEntries(this.values) : {} }

  flush(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    if (!this.path || !this.serverId) return
    try {
      mkdirSync(dirname(this.path), { recursive: true })
      const temporary = `${this.path}.${process.pid}.tmp`
      writeFileSync(temporary, JSON.stringify({ serverId: this.serverId, panes: Object.fromEntries(this.values) }))
      renameSync(temporary, this.path)
    } catch (error) {
      console.warn('[commando] could not save pane state', this.path, error)
    }
  }

  private scheduleWrite(): void {
    if (!this.path || this.timer) return
    this.timer = setTimeout(() => this.flush(), WRITE_DELAY_MS)
    this.timer.unref?.()
  }
}

export const isTimestamp = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
