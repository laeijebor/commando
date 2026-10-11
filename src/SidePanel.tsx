import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { Globe, PanelRightClose, PanelRightOpen, Smartphone, Wrench, X } from 'lucide-react'
import type { WebPane, WebPaneEngine } from '../shared/protocol'
import { activePanelTab, panelTabs } from './sidePanelState'

function loadWidth(windowId: string): number {
  try {
    const width = Number(localStorage.getItem(`commando.side-panel.width.${windowId}`))
    if (width >= 20 && width <= 80) return width
  } catch { /* Storage can be disabled by the host. */ }
  return 50
}

function tabLabel(tab: WebPane, title?: string, simulatorName?: string): string {
  if (title) return title
  if (tab.content) return simulatorName ?? 'Simulator'
  try { return new URL(tab.url).host } catch { return 'Browser' }
}

export function SidePanel({
  windowId, tabs, focusedPaneId, maximizedTabId, gridMaximized = false, paneLabel, simulatorNames, titles,
  onSelect, onClose, onOpen, renderTab, children,
}: {
  windowId: string
  tabs: WebPane[]
  focusedPaneId?: string
  maximizedTabId?: string
  gridMaximized?: boolean
  paneLabel: string
  simulatorNames: Record<string, string>
  titles: Record<string, string>
  onSelect: (tab: WebPane) => void
  onClose: (id: string) => void
  onOpen: (url: string, anchor: string, engine: WebPaneEngine) => void
  renderTab: (tab: WebPane, visible: boolean) => ReactNode
  children: ReactNode
}) {
  const [width, setWidth] = useState(() => loadWidth(windowId))
  const [collapsed, setCollapsed] = useState(false)
  const [url, setUrl] = useState('')
  const [adding, setAdding] = useState<WebPaneEngine | null>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{ startX: number; width: number; workspaceWidth: number } | null>(null)
  const maximizedTab = tabs.find((tab) => tab.id === maximizedTabId)
  const expanded = Boolean(maximizedTab) || !collapsed
  const focusedTabs = panelTabs(tabs, maximizedTab?.anchorPaneId ?? focusedPaneId ?? '')
  const active = maximizedTab ?? activePanelTab(focusedTabs)
  useEffect(() => {
    try { localStorage.setItem(`commando.side-panel.width.${windowId}`, String(width)) } catch { /* Best effort. */ }
  }, [windowId, width])
  useEffect(() => { setAdding(null); setUrl('') }, [focusedPaneId])
  if (!tabs.length) return <>{children}</>
  const open = () => {
    if (!focusedPaneId || !adding || !url.trim()) return
    const raw = url.trim()
    onOpen(/^https?:\/\//i.test(raw) ? raw : `http://${raw}`, focusedPaneId, adding)
    setAdding(null)
    setUrl('')
  }
  return (
    <div ref={bodyRef} className={`window-panel-layout${!expanded ? ' is-collapsed' : ''}${maximizedTab ? ' is-panel-maximized' : ''}`}
      style={{ '--side-panel-width': `${width}%` } as CSSProperties}>
      <div className="window-terminal-grid" hidden={Boolean(maximizedTab)}>{children}</div>
      <div className="side-panel-splitter" hidden={Boolean(maximizedTab) || gridMaximized} role="separator" aria-label="Resize side panel"
        aria-orientation="vertical" aria-valuemin={20} aria-valuemax={80} aria-valuenow={Math.round(width)} tabIndex={collapsed ? -1 : 0}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
          event.preventDefault()
          setWidth((value) => Math.max(20, Math.min(80, value + (event.key === 'ArrowLeft' ? 2 : -2))))
        }}
        onPointerDown={(event) => {
          if (event.button !== 0 || collapsed) return
          event.preventDefault()
          const workspaceWidth = bodyRef.current?.getBoundingClientRect().width ?? 0
          if (!workspaceWidth) return
          dragRef.current = { startX: event.clientX, width, workspaceWidth }
          event.currentTarget.setPointerCapture(event.pointerId)
        }}
        onPointerMove={(event) => {
          const drag = dragRef.current
          if (drag) setWidth(Math.max(20, Math.min(80, drag.width - (event.clientX - drag.startX) / drag.workspaceWidth * 100)))
        }}
        onPointerUp={() => { dragRef.current = null }}
        onPointerCancel={() => { dragRef.current = null }}
        onLostPointerCapture={() => { dragRef.current = null }} />
      <aside className="side-panel" hidden={gridMaximized} aria-label="Pane tabs">
        {!expanded ? <button className="side-panel-expand" type="button" aria-label="Expand side panel" onClick={() => setCollapsed(false)}><PanelRightOpen /></button> : (
          <header className="side-panel-head">
            <div className="side-panel-tabs" role="tablist" aria-label={`Tabs for ${paneLabel}`}>
              {focusedTabs.map((tab) => {
                const Icon = tab.content ? Smartphone : /devtools/i.test(tab.url) ? Wrench : Globe
                const label = tabLabel(tab, titles[tab.id], tab.content ? simulatorNames[tab.content.udid] : undefined)
                return <div className={`side-panel-tab${active?.id === tab.id ? ' is-active' : ''}`} key={tab.id}>
                  <button type="button" role="tab" aria-selected={active?.id === tab.id} aria-controls={`panel-tab-${tab.id}`} onClick={() => onSelect(tab)} title={label}>
                    <Icon aria-hidden="true" /><span>{label}</span>{tab.unseen && <i className="side-panel-new" aria-label="New tab" />}
                  </button>
                  <button type="button" className="side-panel-tab-close" aria-label={`Close ${label}`} onClick={() => onClose(tab.id)}><X /></button>
                </div>
              })}
            </div>
            <span className="side-panel-owner" title={paneLabel}>{paneLabel}</span>
            {!maximizedTab && <button className="web-pane-button" type="button" aria-label="Collapse side panel" onClick={() => setCollapsed(true)}><PanelRightClose /></button>}
          </header>
        )}
        {expanded && !focusedTabs.length && <div className="side-panel-empty">
          <p>No tabs for {paneLabel}</p>
          <div><button type="button" disabled={!focusedPaneId} onClick={() => setAdding('webkit')}>Browser</button>
            <button type="button" disabled={!focusedPaneId} onClick={() => setAdding('chromium')}>Chromium</button></div>
          {adding && <form onSubmit={(event) => { event.preventDefault(); open() }}>
            <input autoFocus value={url} onChange={(event) => setUrl(event.target.value)} placeholder="http://localhost:5173" aria-label="Tab URL" />
            <button type="submit" disabled={!url.trim()}>Open</button>
          </form>}
        </div>}
        <div className="side-panel-content">
          {tabs.map((tab) => {
            const visible = !gridMaximized && expanded && tab.id === active?.id
            return <div id={`panel-tab-${tab.id}`} role="tabpanel" className="side-panel-tab-body" hidden={!visible} key={tab.id}>
              {renderTab(tab, visible)}
            </div>
          })}
        </div>
      </aside>
    </div>
  )
}
