import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

const WRITE_DELAY_MS = 2_000
const TILE_ID = /^[A-Za-z0-9_-]{1,128}$/

/**
 * When each tile was last on a screen, recorded as it comes on or goes off. Clients report the
 * tiles they render visibly. Tile ids outlive tmux servers and daemon restarts, so the times are
 * saved to `path` and pruned to tiles that are open or parked.
 */
export class TileViews {
  private readonly views = new Map<string, number>()
  private onScreen = new Set<string>()
  private timer: NodeJS.Timeout | undefined

  constructor(private readonly path?: string) {
    if (!path) return
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as { tiles?: unknown }
      if (!parsed?.tiles || typeof parsed.tiles !== 'object') return
      for (const [id, at] of Object.entries(parsed.tiles)) {
        if (TILE_ID.test(id) && typeof at === 'number' && Number.isFinite(at)) this.views.set(id, at)
      }
    } catch { /* First run, or a damaged file: start empty. */ }
  }

  /** Records the tiles that came on or went off screen since the last update. */
  update(onScreen: ReadonlySet<string>, now = Date.now()): void {
    let changed = false
    for (const id of new Set([...this.onScreen, ...onScreen])) {
      if (this.onScreen.has(id) === onScreen.has(id)) continue
      this.views.set(id, now)
      changed = true
    }
    this.onScreen = new Set(onScreen)
    if (changed) this.scheduleWrite()
  }

  /** Forgets tiles that have closed. */
  retain(liveIds: ReadonlySet<string>): void {
    let changed = false
    for (const id of this.views.keys()) {
      if (liveIds.has(id)) continue
      this.views.delete(id)
      changed = true
    }
    if (changed) this.scheduleWrite()
  }

  snapshot(): { viewedAt: Record<string, number>; viewing: string[] } {
    return { viewedAt: Object.fromEntries(this.views), viewing: [...this.onScreen] }
  }

  flush(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    if (!this.path) return
    try {
      mkdirSync(dirname(this.path), { recursive: true })
      const temporary = `${this.path}.${process.pid}.tmp`
      writeFileSync(temporary, `${JSON.stringify({ tiles: Object.fromEntries(this.views) })}\n`, { mode: 0o600 })
      renameSync(temporary, this.path)
    } catch (error) {
      console.error('[commando] failed to save tile views', error)
    }
  }

  private scheduleWrite(): void {
    if (!this.path || this.timer) return
    this.timer = setTimeout(() => this.flush(), WRITE_DELAY_MS)
    this.timer.unref?.()
  }
}
