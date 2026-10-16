/**
 * When the user last looked at each pane, by daemon clock so it compares with
 * `AgentStatus.settledAt`. Kept in memory: after a restart every new turn
 * ending is unseen, which is what the sidebar should show anyway. Entries are
 * never pruned: a reused pane id's next turn ends after its old seen time.
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
}
