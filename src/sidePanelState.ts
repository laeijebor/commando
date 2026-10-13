import type { WebPane } from '../shared/protocol'
import { panelTabs, isLegacyPrPanelKey, parsePrPanelKey, prPanelKey, type BuiltinPanelKey } from '../shared/web-pane-placement'
import type { GitDiffSummary } from './gitApi'
import type { PanePrSummary } from './prsApi'
export { panelTabs }

export function isNarrowPanel(width: number): boolean { return width <= 840 }
export const DEFAULT_DRAWER_HEIGHT = 60
export function clampDrawerHeight(height: number): number {
  return Number.isFinite(height) ? Math.max(25, Math.min(90, height)) : DEFAULT_DRAWER_HEIGHT
}
export function rememberedDrawerHeight(remembered: string | null): number {
  return remembered?.trim() ? clampDrawerHeight(Number(remembered)) : DEFAULT_DRAWER_HEIGHT
}

/** Cut panel controls out of the scrim's paint and hit-test region. */
export function panelScrimClipPath(bounds: Pick<DOMRect, 'left' | 'top' | 'right' | 'bottom'>, controls: readonly Pick<DOMRect, 'left' | 'top' | 'right' | 'bottom'>[]): string {
  const width = bounds.right - bounds.left
  const height = bounds.bottom - bounds.top
  const paths = [`M0 0H${width}V${height}H0Z`]
  for (const control of controls) {
    const left = Math.max(0, control.left - bounds.left)
    const top = Math.max(0, control.top - bounds.top)
    const right = Math.min(width, control.right - bounds.left)
    const bottom = Math.min(height, control.bottom - bounds.top)
    if (left < right && top < bottom) paths.push(`M${left} ${top}H${right}V${bottom}H${left}Z`)
  }
  return `path(evenodd, "${paths.join(' ')}")`
}

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
  prSignature?: string
  prState?: 'open' | 'draft' | 'merged' | 'closed'
  unseen?: boolean
  warning?: boolean
  additions?: number
  deletions?: number
}
export type PanelTab = WebPane | BuiltinPanelTab
export function isBuiltinTab(tab: PanelTab): tab is BuiltinPanelTab { return 'key' in tab }
export function panelTabKey(tab: PanelTab): string { return isBuiltinTab(tab) ? tab.key : tab.id }
export function builtinPanelTab(anchorPaneId: string, key: BuiltinPanelKey, label: string = key === 'session' ? 'Session' : key === 'changes' ? 'Changes' : `#${parsePrPanelKey(key)?.number}`): BuiltinPanelTab {
  return { id: `panel:${anchorPaneId}:${key}`, key, anchorPaneId, label }
}
export function hasPaneChanges(summary: GitDiffSummary | null): boolean {
  return Boolean(summary?.isRepo && summary.target != null && summary.files?.length)
}
export function orderedPanePrs(prs: readonly PanePrSummary[]): PanePrSummary[] {
  const priority = { open: 0, merged: 1, closed: 2 }
  return [...prs].sort((a, b) => priority[a.state] - priority[b.state] || b.updatedAt.localeCompare(a.updatedAt))
}
export function prTabSignature(pr: PanePrSummary): string {
  return `${pr.state}|${pr.isDraft}|${pr.updatedAt}`
}
export function visiblePanePrs(prs: readonly PanePrSummary[], dismissed: Readonly<Record<string, string>> = {}): PanePrSummary[] {
  return orderedPanePrs(prs).filter((pr) => dismissed[prPanelKey(pr.repo, pr.number)] !== prTabSignature(pr))
}
export function closedPanePrs(prs: readonly PanePrSummary[], dismissed: Readonly<Record<string, string>> = {}): PanePrSummary[] {
  return orderedPanePrs(prs).filter((pr) => dismissed[prPanelKey(pr.repo, pr.number)] === prTabSignature(pr))
}
export function primaryPanePr(prs: readonly PanePrSummary[]): PanePrSummary | undefined {
  return orderedPanePrs(prs)[0]
}
export function combinedPanelTabs(anchor: string, webTabs: readonly WebPane[], summary: GitDiffSummary | null, prs: readonly PanePrSummary[], sessionUnseen = false, sessionWarning = false, dismissed: Readonly<Record<string, string>> = {}): PanelTab[] {
  const tabs: PanelTab[] = [{ ...builtinPanelTab(anchor, 'session'), unseen: sessionUnseen, warning: sessionWarning }]
  if (hasPaneChanges(summary)) tabs.push({ ...builtinPanelTab(anchor, 'changes'), additions: summary?.additions ?? 0, deletions: summary?.deletions ?? 0 })
  const counts = new Map<number, number>()
  for (const pr of prs) counts.set(pr.number, (counts.get(pr.number) ?? 0) + 1)
  for (const pr of visiblePanePrs(prs, dismissed)) {
    tabs.push({ ...builtinPanelTab(anchor, prPanelKey(pr.repo, pr.number), `${counts.get(pr.number)! > 1 ? pr.repo : ''}#${pr.number}`),
      prSignature: prTabSignature(pr), prState: pr.state === 'open' && pr.isDraft ? 'draft' : pr.state })
  }
  return [...tabs, ...panelTabs(webTabs, anchor)]
}
export function resolveActivePanelTab(tabs: readonly PanelTab[], stored?: string, previous: readonly PanelTab[] = []): PanelTab | undefined {
  if (stored && isLegacyPrPanelKey(stored)) {
    const number = stored === 'pr' ? undefined : Number(stored.slice(3))
    const firstPr = tabs.find((tab) => {
      const pr = parsePrPanelKey(panelTabKey(tab))
      return pr && (number === undefined || pr.number === number)
    })
    if (firstPr) return firstPr
  }
  const identity = stored ? parsePrPanelKey(stored) : undefined
  if (identity) stored = prPanelKey(identity.repo, identity.number)
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

/** New ids and URL reopens share the agent-open focus policy. */
export function openedPanelTabs(tabs: readonly WebPane[], previous: ReadonlyMap<string, number>): WebPane[] {
  return tabs.filter((tab) => tab.dock !== 'split' &&
    (!previous.has(tab.id) || (tab.openRevision ?? 0) > previous.get(tab.id)!))
}
