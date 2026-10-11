import type { WebPane } from '../shared/protocol'
import { panelTabs, type BuiltinPanelKey } from '../shared/web-pane-placement'
import type { GitDiffSummary } from './gitApi'
import type { PanePrSummary } from './prsApi'
export { panelTabs }

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


export type BuiltinPanelTab = {
  id: string
  key: BuiltinPanelKey
  anchorPaneId: string
  label: string
  unseen?: boolean
  warning?: boolean
  additions?: number
  deletions?: number
}
export type PanelTab = WebPane | BuiltinPanelTab
export function isBuiltinTab(tab: PanelTab): tab is BuiltinPanelTab { return 'key' in tab }
export function panelTabKey(tab: PanelTab): string { return isBuiltinTab(tab) ? tab.key : tab.id }
export function builtinPanelTab(anchorPaneId: string, key: BuiltinPanelKey, label: string = key === 'session' ? 'Session' : key === 'changes' ? 'Changes' : 'PR'): BuiltinPanelTab {
  return { id: `panel:${anchorPaneId}:${key}`, key, anchorPaneId, label }
}
export function hasPaneChanges(summary: GitDiffSummary | null): boolean {
  return Boolean(summary?.isRepo && summary.target != null && summary.files?.length)
}
export function primaryPanePr(prs: readonly PanePrSummary[]): PanePrSummary | undefined {
  const priority = { open: 0, merged: 1, closed: 2 }
  return [...prs].sort((a, b) => priority[a.state] - priority[b.state] || b.updatedAt.localeCompare(a.updatedAt))[0]
}
export function combinedPanelTabs(anchor: string, webTabs: readonly WebPane[], summary: GitDiffSummary | null, prs: readonly PanePrSummary[], sessionUnseen = false, sessionWarning = false): PanelTab[] {
  const tabs: PanelTab[] = [{ ...builtinPanelTab(anchor, 'session'), unseen: sessionUnseen, warning: sessionWarning }]
  if (hasPaneChanges(summary)) tabs.push({ ...builtinPanelTab(anchor, 'changes'), additions: summary?.additions ?? 0, deletions: summary?.deletions ?? 0 })
  const pr = primaryPanePr(prs)
  if (pr) tabs.push(builtinPanelTab(anchor, 'pr', `PR #${pr.number}`))
  return [...tabs, ...panelTabs(webTabs, anchor)]
}
export function resolveActivePanelTab(tabs: readonly PanelTab[], stored?: string, previous: readonly PanelTab[] = []): PanelTab | undefined {
  const selected = tabs.find((tab) => panelTabKey(tab) === stored)
  if (selected) return selected
  const index = previous.findIndex((tab) => panelTabKey(tab) === stored)
  if (index >= 0) {
    const surviving = new Set(tabs.map(panelTabKey))
    const neighbour = previous.slice(index + 1).find((tab) => surviving.has(panelTabKey(tab)))
      ?? [...previous.slice(0, index)].reverse().find((tab) => surviving.has(panelTabKey(tab)))
    if (neighbour) return tabs.find((tab) => panelTabKey(tab) === panelTabKey(neighbour))
  }
  return tabs.find((tab) => panelTabKey(tab) === 'session') ?? tabs[0]
}
export function defaultPanelCollapsed(hasWebTabs: boolean, remembered: string | null, hasHadWebTabs = false): boolean {
  return remembered === 'true' ? true : remembered === 'false' ? false : !(hasWebTabs || hasHadWebTabs)
}
