import type { WebPane } from '@commando/protocol'
import type { GitDiffSummary, PanePrSummary } from '../daemon/paneApi'

export type PaneTab =
  | { id: 'body'; kind: 'body'; label: 'Chat' | 'Terminal' }
  | { id: 'worklog'; kind: 'worklog'; label: string }
  | { id: 'changes'; kind: 'changes'; label: string; additions: number; deletions: number }
  | { id: string; kind: 'pr'; label: string; pr: PanePrSummary; state: 'open' | 'draft' | 'merged' | 'closed' }
  | { id: string; kind: 'web'; label: string; tile: WebPane; content: 'browser' | 'simulator' | 'canvas' | 'guide' }

// Mirrors src/sidePanelState.ts combinedPanelTabs and shared/web-pane-placement.ts panelTabs.
export function paneTabs({ paneId, chat, webPanes, summary, prs = [], dismissed = {} }: {
  paneId: string; chat: boolean; webPanes: readonly WebPane[]; summary?: GitDiffSummary | null; prs?: readonly PanePrSummary[]; dismissed?: Readonly<Record<string, string>>
}): PaneTab[] {
  const tabs: PaneTab[] = [{ id: 'body', kind: 'body', label: chat ? 'Chat' : 'Terminal' }, { id: 'worklog', kind: 'worklog', label: 'Worklog' }]
  if (summary?.isRepo && summary.target != null && summary.files?.length) tabs.push({ id: 'changes', kind: 'changes', label: 'Changes', additions: summary.additions ?? 0, deletions: summary.deletions ?? 0 })
  const priority = { open: 0, merged: 1, closed: 2 }
  const counts = new Map<number, number>()
  prs.forEach((pr) => counts.set(pr.number, (counts.get(pr.number) ?? 0) + 1))
  for (const pr of [...prs].sort((a, b) => priority[a.state] - priority[b.state] || b.updatedAt.localeCompare(a.updatedAt))) {
    const key = `pr:${pr.repo.toLowerCase().replace('/', ':')}:${pr.number}`
    if (dismissed[key] === `${pr.state}|${pr.isDraft}|${pr.updatedAt}`) continue
    tabs.push({ id: key, kind: 'pr', label: `PR ${counts.get(pr.number)! > 1 ? `${pr.repo} ` : ''}#${pr.number}`, pr, state: pr.isDraft && pr.state === 'open' ? 'draft' : pr.state })
  }
  const web = webPanes.filter((tile) => tile.anchorPaneId === paneId && tile.dock !== 'split').sort((a, b) => (a.order ?? a.createdAt) - (b.order ?? b.createdAt) || a.createdAt - b.createdAt || a.id.localeCompare(b.id))
  for (const tile of web) {
    const content = tile.content?.kind ?? 'browser'
    let fallback: string = content === 'browser' ? 'Web' : content.charAt(0).toUpperCase() + content.slice(1)
    try { if (content === 'browser') fallback = new URL(tile.url).host || fallback } catch { /* Non-URL built-ins use their kind. */ }
    tabs.push({ id: tile.id, kind: 'web', label: tile.title || fallback, tile, content })
  }
  return tabs
}
