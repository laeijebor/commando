import { ChevronDown, ChevronRight, Globe, LayoutDashboard, ListChecks, PenLine, Presentation, RotateCcw, X, type LucideIcon } from 'lucide-react'
import { useState } from 'react'

import type { ClosedWebPane, ClosedWebPaneKind } from '../shared/protocol'

/** Longer lists start collapsed so they don't push the plan out of view. */
const COLLAPSE_AFTER = 5

const KINDS: Record<ClosedWebPaneKind, { icon: LucideIcon; label: string }> = {
  canvas: { icon: LayoutDashboard, label: 'Canvas' },
  slides: { icon: Presentation, label: 'Slides' },
  guide: { icon: ListChecks, label: 'Guide' },
  redline: { icon: PenLine, label: 'Redline' },
  page: { icon: Globe, label: 'Page' },
}

function closedAgo(closedAt: number, now = Date.now()): string {
  const minutes = Math.floor(Math.max(0, now - closedAt) / 60_000)
  if (minutes < 1) return 'closed just now'
  if (minutes < 60) return `closed ${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `closed ${hours}h ago`
  return `closed ${Math.floor(hours / 24)}d ago`
}

export function WorklogClosedTabs({ tabs, paneLabel, connected, onReopen, onForget }: {
  tabs: readonly ClosedWebPane[]
  paneLabel: string
  connected: boolean
  onReopen: (id: string) => Promise<void>
  onForget: (id: string) => Promise<void>
}) {
  const [collapsed, setCollapsed] = useState(tabs.length > COLLAPSE_AFTER)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState('')
  if (!tabs.length) return null

  const run = async (id: string, action: (id: string) => Promise<void>, failure: string) => {
    setBusy(id)
    setError('')
    try { await action(id) }
    catch (cause) { setError(cause instanceof Error ? cause.message : failure) }
    finally { setBusy(null) }
  }

  return (
    <section className="pane-worklog-closed-tabs" aria-label={`Closed tabs for ${paneLabel}`}>
      <button
        type="button"
        className="pane-worklog-section-toggle"
        onClick={() => setCollapsed((current) => !current)}
        aria-expanded={!collapsed}
        aria-label={`${collapsed ? 'Expand' : 'Collapse'} closed tabs for ${paneLabel}`}
      >
        <span><strong>Closed tabs</strong><small>{tabs.length}</small></span>
        {collapsed ? <ChevronRight aria-hidden="true" /> : <ChevronDown aria-hidden="true" />}
      </button>
      {!collapsed ? (
        <div className="pane-worklog-reference-list">
          {tabs.map((tab) => {
            const { icon: Icon, label } = KINDS[tab.kind]
            const disabled = !connected || busy !== null
            return (
              <div className="pane-worklog-reference pane-worklog-reference-session pane-worklog-closed-tab" key={tab.id}>
                <button
                  type="button"
                  className="pane-worklog-reference-main"
                  disabled={disabled}
                  aria-label={`Reopen ${tab.title}`}
                  title={tab.url ? `Reopen ${tab.url}` : 'Reopen beside this pane'}
                  onClick={() => void run(tab.id, onReopen, 'Could not reopen the tab')}
                >
                  <span className="pane-worklog-reference-icon"><Icon aria-hidden="true" /></span>
                  <span><strong>{tab.title}</strong><small>{label} · {closedAgo(tab.closedAt)}</small></span>
                  <span className="pane-worklog-closed-tab-reopen"><RotateCcw aria-hidden="true" />Reopen</span>
                </button>
                <button
                  type="button"
                  className="pane-worklog-reference-copy"
                  disabled={disabled}
                  aria-label={`Forget ${tab.title}`}
                  title="Remove from closed tabs"
                  onClick={() => void run(tab.id, onForget, 'Could not forget the tab')}
                >
                  <X aria-hidden="true" />
                </button>
              </div>
            )
          })}
        </div>
      ) : null}
      {error ? <small className="pane-worklog-closed-tabs-error" role="alert">{error}</small> : null}
    </section>
  )
}
