/**
 * When the user last looked at each pane, by daemon clock so it compares with
 * `AgentStatus.settledAt`. Kept in memory: after a restart every new turn
 * ending is unseen, which is what the sidebar should show anyway.
 */
export class PaneSeen {
  private readonly seen = new Map<string, number>()

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
    return Object.fromEntries(this.seen)
  }

  /** Forgets panes that no longer exist, so a reused pane id starts unseen. */
  retain(paneIds: ReadonlySet<string>): void {
    for (const paneId of this.seen.keys()) {
      if (!paneIds.has(paneId)) this.seen.delete(paneId)
    }
  }
}
