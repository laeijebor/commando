import { useState, type ReactNode } from 'react'
import { MessageSquare } from 'lucide-react'
import type { TmuxPane, WebPane } from '../shared/protocol'
import { cn } from './chat/cn'
import type { GitDiffApiClient } from './gitApi'
import { usePaneGitSummary } from './paneGitStore'
import type { PrsApiClient } from './prsApi'
import { usePanePrs } from './prStore'
import { panelTabIcon, tabLabel, type PanePanelData } from './SidePanel'
import { combinedPanelTabs, isBuiltinTab, type BuiltinPanelTab } from './sidePanelState'

/**
 * The read agent's chat with its pane's side-panel tabs (session log, changes,
 * PRs, web tiles, simulators) in a strip above it. A selected tab shows in the
 * chat's place. Like the side panel, the chat and every visited tab stay
 * mounted while hidden, so scroll positions and unsent drafts survive.
 */
export function CommanderPeekTabs({ pane, chat, webTabs, gitApi, prsApi, connected, sessionUnseen, sessionWarning, dismissedPrs, titles, simulatorNames, renderBuiltin, renderTab }: {
  pane: TmuxPane
  chat: ReactNode
  /** Web tabs docked in the pane's side panel. */
  webTabs: readonly WebPane[]
  gitApi: GitDiffApiClient
  prsApi: PrsApiClient
  connected: boolean
  sessionUnseen?: boolean
  sessionWarning?: boolean
  dismissedPrs?: Readonly<Record<string, string>>
  titles: Readonly<Record<string, string>>
  simulatorNames: Readonly<Record<string, string>>
  renderBuiltin: (tab: BuiltinPanelTab, visible: boolean, data: PanePanelData) => ReactNode
  renderTab: (tab: WebPane, visible: boolean) => ReactNode
}) {
  const summary = usePaneGitSummary(pane.id, pane.path, gitApi, connected)
  const list = usePanePrs(pane.id, prsApi, { background: false, enabled: connected })
  const prs = list?.targetId === pane.targetId ? list : null
  const tabs = combinedPanelTabs(pane.id, webTabs, summary, prs?.pullRequests ?? [], sessionUnseen, sessionWarning, dismissedPrs)
  const [selectedId, setSelectedId] = useState<string>()
  const [visited, setVisited] = useState<ReadonlySet<string>>(() => new Set())
  const select = (id: string) => {
    setSelectedId(id)
    setVisited((current) => current.has(id) ? current : new Set([...current, id]))
  }
  // A closed tab falls back to the chat.
  const active = tabs.find((tab) => tab.id === selectedId)
  const panelId = (key: string) => `peek-panel-${pane.id}-${key}`
  const tab = (key: string, selected: boolean, label: string, Icon: typeof MessageSquare, onSelect: () => void, title?: string) =>
    <button key={key} id={`peek-tab-${pane.id}-${key}`} type="button" role="tab" aria-selected={selected} aria-controls={panelId(key)} title={title ?? label} onClick={onSelect}
      className={cn('flex h-6 min-w-0 max-w-48 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground hover:bg-accent hover:text-foreground [&_svg]:size-3.5 [&_svg]:shrink-0',
        selected && 'bg-accent text-foreground')}>
      <Icon aria-hidden="true" /><span className="truncate">{label}</span>
    </button>
  return <>
    <div role="tablist" aria-label={`Tabs for ${pane.title || pane.command || `Pane ${pane.index}`}`} className="flex min-w-0 shrink-0 items-center gap-1 overflow-x-auto border-b border-border px-2 py-1">
      {tab('chat', !active, 'Chat', MessageSquare, () => setSelectedId(undefined))}
      {tabs.map((item) => {
        const label = isBuiltinTab(item) ? item.label
          : tabLabel(item, titles[item.id], item.content?.kind === 'simulator' ? simulatorNames[item.content.udid] : undefined)
        return tab(item.id, item.id === active?.id, label, panelTabIcon(item), () => select(item.id), isBuiltinTab(item) ? undefined : item.url || label)
      })}
    </div>
    <div id={panelId('chat')} role="tabpanel" aria-labelledby={`peek-tab-${pane.id}-chat`} className={cn('min-h-0 flex-1 flex-col', active ? 'hidden' : 'flex')}>{chat}</div>
    <div className="side-panel-content" hidden={!active}>
      {tabs.filter((item) => visited.has(item.id)).map((item) => {
        const visible = item.id === active?.id
        return <div key={item.id} id={panelId(item.id)} role="tabpanel" aria-labelledby={`peek-tab-${pane.id}-${item.id}`} className="side-panel-tab-body" hidden={!visible}>
          {isBuiltinTab(item) ? renderBuiltin(item, visible, { summary, prs }) : renderTab(item, visible)}
        </div>
      })}
    </div>
  </>
}
