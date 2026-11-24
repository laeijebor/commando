import { isTimestamp, PaneStore } from './pane-times.js'

/**
 * When each pane was last on someone's screen, recorded as a client starts or
 * stops streaming it. A pane still streaming was viewed at its last record and
 * is on screen now; callers report that separately. Saved to `path` when given,
 * so the Panes list keeps its history across daemon restarts.
 */
export class PaneViews {
  private readonly views: PaneStore<number>

  constructor(path?: string) { this.views = new PaneStore(path, isTimestamp) }

  bindServer(serverId: string): boolean { return this.views.bindServer(serverId) }

  record(paneIds: Iterable<string>, now = Date.now()): void {
    for (const paneId of paneIds) this.views.set(paneId, now)
  }

  snapshot(): Record<string, number> { return this.views.snapshot() }

  flush(): void { this.views.flush() }
}
