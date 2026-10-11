import type { WebPane } from '../shared/protocol'
export { panelTabs } from '../shared/web-pane-placement'

/** A tmux active-pane transition overrides stale client focus once. */
export function effectiveFocusedPane(
  focusedPaneId: string | null,
  paneIds: readonly string[],
  tmuxActivePaneId: string | undefined,
  previousTmuxActivePaneId: string | undefined,
): string | undefined {
  if (tmuxActivePaneId && previousTmuxActivePaneId && tmuxActivePaneId !== previousTmuxActivePaneId) {
    return tmuxActivePaneId
  }
  return (focusedPaneId && paneIds.includes(focusedPaneId) ? focusedPaneId : undefined)
    ?? tmuxActivePaneId ?? paneIds[0]
}

export function activePanelTab(tabs: readonly WebPane[]): WebPane | undefined {
  return tabs.find((tab) => tab.activeTab) ?? tabs[0]
}
