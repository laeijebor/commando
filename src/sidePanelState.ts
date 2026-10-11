import type { WebPane } from '../shared/protocol'
export { panelTabs } from '../shared/web-pane-placement'

/** Prefer client focus, then fall back to the current tmux pane. */
export function effectiveFocusedPane(
  focusedPaneId: string | null,
  paneIds: readonly string[],
  tmuxActivePaneId: string | undefined,
): string | undefined {
  return (focusedPaneId && paneIds.includes(focusedPaneId) ? focusedPaneId : undefined)
    ?? tmuxActivePaneId ?? paneIds[0]
}

export function activePanelTab(tabs: readonly WebPane[]): WebPane | undefined {
  return tabs.find((tab) => tab.activeTab) ?? tabs[0]
}
