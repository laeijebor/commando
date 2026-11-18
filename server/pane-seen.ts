import { isTimestamp, PaneStore } from './pane-times.js'

/**
 * When the user last looked at each pane, by daemon clock so it compares with
 * `AgentStatus.settledAt`. Saved to `path` when given, so a daemon restart
 * does not turn every finished turn back into unread. Entries are never
 * pruned within a tmux server: a reused pane id's next turn ends after its old
 * seen time.
 */
export class PaneSeen {
  private readonly seen: PaneStore<number>

  constructor(path?: string) { this.seen = new PaneStore(path, isTimestamp) }

  bindServer(serverId: string): boolean { return this.seen.bindServer(serverId) }

  /** Records the panes as seen now and returns the entries that changed. */
  mark(paneIds: Iterable<string>, now = Date.now()): Record<string, number> {
    const changed: Record<string, number> = {}
    for (const paneId of paneIds) {
      if ((this.seen.get(paneId) ?? -Infinity) >= now) continue
      this.seen.set(paneId, now)
      changed[paneId] = now
    }
    return changed
  }

  snapshot(): Record<string, number> {
    return this.seen.snapshot()
  }

  flush(): void { this.seen.flush() }
}
