import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { FileDiff, GitPullRequest, LayoutDashboard, ListChecks, Maximize2, Minimize2, NotebookText, Plus, Globe, PanelRightClose, PanelRightOpen, Smartphone, Wrench, X } from 'lucide-react'
import { parsePrPanelKey, prPanelKey } from '../shared/web-pane-placement'
import type { TmuxPane, WebPane, WebPaneEngine } from '../shared/protocol'
import { activePanelTab, builtinPanelTab, closedPanePrs, combinedPanelTabs, panelScrimClipPath, clampDrawerHeight, rememberedDrawerHeight, defaultPanelCollapsed, isBuiltinTab, panelTabKey, resolveActivePanelTab, type BuiltinPanelTab, type PanelTab } from './sidePanelState'
import type { GitDiffApiClient, GitDiffSummary } from './gitApi'
import type { PanePrList, PrsApiClient } from './prsApi'
import { usePaneGitSummary } from './paneGitStore'
import { usePanePrs } from './prStore'

export type PanePanelData = { summary: GitDiffSummary | null; prs: PanePrList | null }
function PanePanelSource({ pane, gitApi, prsApi, connected, onData }: {
  pane: TmuxPane; gitApi: GitDiffApiClient; prsApi: PrsApiClient; connected: boolean
  onData: (id: string, data: PanePanelData) => void
}) {
  const summary = usePaneGitSummary(pane.id, pane.path, gitApi, connected)
  const list = usePanePrs(pane.id, prsApi, { background: false, enabled: connected })
  const prs = list?.targetId === pane.targetId ? list : null
  useEffect(() => { onData(pane.id, { summary, prs }) }, [pane.id, summary, prs, onData])
  return null
}

function loadCollapsed(windowId: string): boolean | undefined {
  try {
    const remembered = localStorage.getItem(`commando.side-panel.collapsed.${windowId}`)
    if (remembered === 'true' || remembered === 'false') return defaultPanelCollapsed(false, remembered)
  } catch { /* Best effort. */ }
  return undefined
}

function loadWidth(windowId: string): number {
  try {
    const width = Number(localStorage.getItem(`commando.side-panel.width.${windowId}`))
    if (width >= 20 && width <= 80) return width
  } catch { /* Storage can be disabled by the host. */ }
  return 50
}

function loadDrawerHeight(windowId: string): number {
  try { return rememberedDrawerHeight(localStorage.getItem(`commando.side-panel.height.${windowId}`)) }
  catch { return rememberedDrawerHeight(null) }
}

function tabLabel(tab: WebPane, title?: string, simulatorName?: string): string {
  if (tab.title) return tab.title
  if (title) return title
  if (tab.content?.kind === 'simulator') return simulatorName ?? 'Simulator'
  if (tab.content?.kind === 'canvas') return 'Canvas'
  if (tab.content?.kind === 'guide') return 'Guide'
  try {
    const url = new URL(tab.url)
    return `${url.host}${url.pathname}`
  } catch { return 'Browser' }
}

export function SidePanel({
  windowId, tabs, focusedPaneId, maximizedTabId, revealRequest, narrowMode = false, drawerOpen = false, onDrawerOpen, onDrawerClose, gridMaximized = false, paneLabel, simulatorNames, titles,
  onSelect, onSeen, onClose, onOpen, renderTab, children, panes = [], gitApi, prsApi, connected = false, renderBuiltin, activeTabs = {}, dismissedPrTabs = {}, onDismissPr, onRestorePr, sessionAttention = {}, sessionWarnings = {}, onMaximize, onTabSets,
}: {
  windowId: string
  narrowMode?: boolean
  drawerOpen?: boolean
  onDrawerOpen?: () => void
  onDrawerClose?: () => void
  tabs: WebPane[]
  focusedPaneId?: string
  maximizedTabId?: string
  revealRequest?: { tabId: string; onVisible: () => void; onUnavailable?: () => void }
  gridMaximized?: boolean
  paneLabel: string
  simulatorNames: Record<string, string>
  titles: Record<string, string>
  onTabSets?: (tabs: PanelTab[]) => void
  panes?: TmuxPane[]
  gitApi?: GitDiffApiClient
  prsApi?: PrsApiClient
  connected?: boolean
  activeTabs?: Record<string, string>
  dismissedPrTabs?: Record<string, Record<string, string>>
  onDismissPr?: (tab: BuiltinPanelTab, signature: string, next?: PanelTab) => void
  onRestorePr?: (tab: BuiltinPanelTab) => void
  sessionAttention?: Record<string, boolean>
  sessionWarnings?: Record<string, boolean>
  onMaximize?: (tab: PanelTab) => void
  renderBuiltin?: (tab: BuiltinPanelTab, visible: boolean, data: PanePanelData) => ReactNode
  onSelect: (tab: PanelTab) => void
  onSeen?: (tab: WebPane) => void
  onClose: (id: string) => void
  onOpen: (url: string, anchor: string, engine: WebPaneEngine) => void
  renderTab: (tab: WebPane, visible: boolean) => ReactNode
  children: ReactNode
}) {
  const [drawerHeight, setDrawerHeight] = useState(() => loadDrawerHeight(windowId))
  const [drawerOccluding, setDrawerOccluding] = useState(false)
  const drawerRef = useRef<HTMLElement>(null)
  const scrimRef = useRef<HTMLButtonElement>(null)
  const drawerDragRef = useRef<{ startY: number; height: number; windowHeight: number } | null>(null)
  const swallowedPointerRef = useRef(false)
  const [width, setWidth] = useState(() => loadWidth(windowId))
  const [collapseChoice, setCollapsed] = useState(() => loadCollapsed(windowId))
  const [hasHadWebTabs, setHasHadWebTabs] = useState(tabs.length > 0)
  useEffect(() => { if (tabs.length > 0) setHasHadWebTabs(true) }, [tabs.length])
  const collapsed = collapseChoice ?? defaultPanelCollapsed(tabs.length > 0, null, hasHadWebTabs)
  const changeCollapsed = (value: boolean) => {
    setCollapsed(value)
    try { localStorage.setItem(`commando.side-panel.collapsed.${windowId}`, String(value)) } catch { /* Best effort. */ }
  }
  const [paneData, setPaneData] = useState<Record<string, PanePanelData>>({})
  const onData = useCallback((id: string, data: PanePanelData) => {
    setPaneData((current) => current[id]?.summary === data.summary && current[id]?.prs === data.prs ? current : { ...current, [id]: data })
  }, [])
  const previousTabs = useRef<Record<string, PanelTab[]>>({})
  const [visited, setVisited] = useState<Set<string>>(() => new Set())
  const [url, setUrl] = useState('')
  const [adding, setAdding] = useState<WebPaneEngine | null>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const closeDrawer = useCallback(() => {
    onDrawerClose?.()
    setAdding(null)
    const chip = [...(bodyRef.current?.querySelectorAll<HTMLButtonElement>('[data-panel-chip]') ?? [])]
      .find((node) => node.dataset.panelChip === focusedPaneId)
    chip?.focus()
  }, [onDrawerClose, focusedPaneId])
  const dragRef = useRef<{ startX: number; width: number; workspaceWidth: number } | null>(null)
  const paneIds = [...new Set([...panes.map((pane) => pane.id), ...tabs.map((tab) => tab.anchorPaneId), ...(focusedPaneId ? [focusedPaneId] : [])])]
  const allTabs = paneIds.flatMap((id) => combinedPanelTabs(id, tabs, paneData[id]?.summary ?? null, paneData[id]?.prs?.pullRequests ?? [], sessionAttention[id], sessionWarnings[id], dismissedPrTabs[id]))
  useEffect(() => { onTabSets?.(allTabs) }, [allTabs, onTabSets])
  const maximizedTab = allTabs.find((tab) => tab.id === maximizedTabId)
  const expanded = Boolean(maximizedTab) || (narrowMode ? drawerOpen : !collapsed)
  useLayoutEffect(() => {
    if (!narrowMode || gridMaximized) { setDrawerOccluding(false); return }
    if (expanded) { setDrawerOccluding(true); return }
    if (!drawerOccluding) return
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) { setDrawerOccluding(false); return }
    const timer = window.setTimeout(() => setDrawerOccluding(false), 250)
    return () => window.clearTimeout(timer)
  }, [narrowMode, expanded, gridMaximized, drawerOccluding])
  const owner = maximizedTab?.anchorPaneId ?? focusedPaneId ?? ''
  const closedPrs = closedPanePrs(paneData[focusedPaneId ?? '']?.prs?.pullRequests ?? [], dismissedPrTabs[focusedPaneId ?? ''])
  const focusedTabs = allTabs.filter((tab) => tab.anchorPaneId === owner)
  const stored = activeTabs[owner] ?? activePanelTab(tabs.filter((tab) => tab.anchorPaneId === owner))?.id
  const active = maximizedTab ?? resolveActivePanelTab(focusedTabs, stored, previousTabs.current[owner])
  useEffect(() => {
    const previous = previousTabs.current[owner] ?? []
    if (!stored || focusedTabs.some((tab) => panelTabKey(tab) === stored) || !previous.length) previousTabs.current[owner] = focusedTabs
    if (expanded && active) setVisited((current) => current.has(active.id) ? current : new Set([...current, active.id]))
  }, [owner, stored, active?.id, expanded, focusedTabs.map((tab) => tab.id).join(',')])
  useEffect(() => {
    try { localStorage.setItem(`commando.side-panel.width.${windowId}`, String(width)) } catch { /* Best effort. */ }
  }, [windowId, width])
  useEffect(() => { setAdding(null); setUrl('') }, [focusedPaneId])
  useEffect(() => {
    if (!gridMaximized && expanded && active && !isBuiltinTab(active) && active.unseen) onSeen?.(active)
  }, [active?.id, active?.unseen, active && !isBuiltinTab(active) ? active.openRevision : undefined, gridMaximized, expanded, onSeen])
  useEffect(() => {
    if (!revealRequest?.onUnavailable) return
    const pane = panes.find((pane) => revealRequest.tabId.startsWith(`panel:${pane.id}:pr:`))
    if (pane && paneData[pane.id]?.prs?.targetId === pane.targetId && !allTabs.some((tab) => tab.id === revealRequest.tabId)) revealRequest.onUnavailable()
  }, [revealRequest, paneData, allTabs])
  useEffect(() => {
    if (!revealRequest) return
    if (narrowMode) onDrawerOpen?.()
    else changeCollapsed(false)
  }, [revealRequest, narrowMode])
  useEffect(() => {
    try { localStorage.setItem(`commando.side-panel.height.${windowId}`, String(drawerHeight)) } catch { /* Best effort. */ }
  }, [windowId, drawerHeight])
  useEffect(() => {
    if (!narrowMode || !expanded || gridMaximized) return
    drawerRef.current?.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]')?.focus()
  }, [narrowMode, expanded, gridMaximized, focusedPaneId])
  useEffect(() => {
    if (!narrowMode || !drawerOpen || maximizedTab || gridMaximized) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      const target = event.target instanceof Element ? event.target : document.activeElement
      if (target?.closest('[role="dialog"], [role="alertdialog"], .xterm, .terminal-find-shell, [data-native-terminal-pane]')) return
      const overlayOpen = [...document.querySelectorAll('[role="dialog"], [role="alertdialog"], .command-palette, .pane-context-menu')].some((node) => {
        const style = window.getComputedStyle(node)
        return !node.closest('[hidden], [inert], [aria-hidden="true"]') && style.display !== 'none' && style.visibility !== 'hidden'
      })
      if (overlayOpen) return
      event.preventDefault()
      event.stopPropagation()
      closeDrawer()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [narrowMode, drawerOpen, Boolean(maximizedTab), gridMaximized, closeDrawer])
  useEffect(() => {
    if (!revealRequest || !expanded || gridMaximized || active?.id !== revealRequest.tabId) return
    const frame = window.requestAnimationFrame(revealRequest.onVisible)
    return () => window.cancelAnimationFrame(frame)
  }, [revealRequest, expanded, gridMaximized, active?.id])
  useLayoutEffect(() => {
    const scrim = scrimRef.current
    const layout = bodyRef.current
    const grid = layout?.querySelector<HTMLElement>('.window-terminal-grid')
    if (!scrim || !layout || !grid) return
    let frame: number | undefined
    const update = () => {
      frame = undefined
      const controls = [...grid.querySelectorAll<HTMLButtonElement>('[data-panel-chip], .pane-git-stats')].filter((node) => !node.disabled)
      scrim.style.clipPath = panelScrimClipPath(scrim.getBoundingClientRect(), controls.map((node) => node.getBoundingClientRect()))
      controls.forEach((node) => resizeObserver?.observe(node))
    }
    const schedule = () => { frame ??= window.requestAnimationFrame(update) }
    const resizeObserver = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(schedule)
    resizeObserver?.observe(layout)
    resizeObserver?.observe(grid)
    const mutationObserver = new MutationObserver(schedule)
    // Header and footer changes can add or move controls; terminal output cannot.
    grid.querySelectorAll('.pane-head, .empty-pane__head, .pane-footer').forEach((node) => mutationObserver.observe(node, { childList: true, characterData: true, attributes: true, subtree: true }))
    window.addEventListener('resize', schedule)
    window.addEventListener('scroll', schedule, true)
    window.addEventListener('transitionend', schedule, true)
    update()
    return () => {
      resizeObserver?.disconnect()
      mutationObserver.disconnect()
      window.removeEventListener('resize', schedule)
      window.removeEventListener('scroll', schedule, true)
      window.removeEventListener('transitionend', schedule, true)
      if (frame !== undefined) window.cancelAnimationFrame(frame)
    }
  }, [narrowMode, expanded, gridMaximized, Boolean(maximizedTab), drawerHeight, focusedPaneId, paneIds.join(',')])
  const open = () => {
    if (!focusedPaneId || !adding || !url.trim()) return
    const raw = url.trim()
    onOpen(/^https?:\/\//i.test(raw) ? raw : `http://${raw}`, focusedPaneId, adding)
    setAdding(null)
    setUrl('')
  }
  return (
    <div ref={bodyRef} className={`window-panel-layout${!expanded ? ' is-collapsed' : ''}${maximizedTab ? ' is-panel-maximized' : ''}${narrowMode ? ' is-narrow' : ''}${narrowMode && expanded ? ' is-drawer-open' : ''}`}
      style={{ '--side-panel-width': `${width}%`, '--side-panel-height': `${drawerHeight}vh` } as CSSProperties}>
      <div className="window-terminal-grid" hidden={Boolean(maximizedTab)}
        onPointerDownCapture={(event) => {
          if (!narrowMode || !drawerOpen || gridMaximized || (event.target as Element).closest('[data-panel-chip], .pane-git-stats')) return
          event.preventDefault()
          event.stopPropagation()
          swallowedPointerRef.current = true
          closeDrawer()
        }}
        onPointerCancel={() => { swallowedPointerRef.current = false }}
        onClickCapture={(event) => {
          if ((event.target as Element).closest('[data-panel-chip], .pane-git-stats')) return
          if (!swallowedPointerRef.current && !(narrowMode && drawerOpen && !gridMaximized)) return
          event.preventDefault()
          event.stopPropagation()
          swallowedPointerRef.current = false
          if (drawerOpen) closeDrawer()
        }}>{children}</div>
      {narrowMode && expanded && !maximizedTab && !gridMaximized && <button ref={scrimRef} type="button" className="side-panel-scrim" aria-label="Close tabs drawer" tabIndex={-1} data-native-terminal-hit-blocker=""
        onPointerDown={(event) => event.preventDefault()} onClick={closeDrawer} />}
      {gitApi && prsApi && panes.map((pane) => <PanePanelSource key={pane.targetId} pane={pane} gitApi={gitApi} prsApi={prsApi} connected={connected} onData={onData} />)}
      <div className="side-panel-splitter" hidden={narrowMode || !paneIds.length || Boolean(maximizedTab) || gridMaximized} role="separator" aria-label="Resize side panel"
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
      <aside ref={drawerRef} className="side-panel" hidden={!paneIds.length || gridMaximized} aria-label="Pane tabs"
        aria-hidden={narrowMode && !expanded ? true : undefined} inert={narrowMode && !expanded}
        data-native-terminal-occluder={narrowMode && !gridMaximized && (expanded || drawerOccluding) ? '' : undefined}
        onTransitionEnd={(event) => {
          if (event.target === event.currentTarget && event.propertyName === 'transform' && !expanded) setDrawerOccluding(false)
        }}>
        {narrowMode && !maximizedTab && <div className="side-panel-drawer-handle" role="separator" aria-label="Resize tabs drawer"
          aria-orientation="horizontal" aria-valuemin={25} aria-valuemax={90} aria-valuenow={Math.round(drawerHeight)} tabIndex={0}
          onKeyDown={(event) => {
            if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
            event.preventDefault()
            setDrawerHeight((value) => clampDrawerHeight(value + (event.key === 'ArrowUp' ? 5 : -5)))
          }}
          onPointerDown={(event) => {
            if (event.button !== 0) return
            event.preventDefault()
            const windowHeight = window.innerHeight
            if (!windowHeight) return
            drawerDragRef.current = { startY: event.clientY, height: drawerHeight, windowHeight }
            event.currentTarget.setPointerCapture(event.pointerId)
          }}
          onPointerMove={(event) => {
            const drag = drawerDragRef.current
            if (drag) setDrawerHeight(clampDrawerHeight(drag.height - (event.clientY - drag.startY) / drag.windowHeight * 100))
          }}
          onPointerUp={() => { drawerDragRef.current = null }}
          onPointerCancel={() => { drawerDragRef.current = null }}
          onLostPointerCapture={() => { drawerDragRef.current = null }} />}
        {!expanded && !narrowMode ? <div className="side-panel-rail">
          <button className="side-panel-expand" type="button" aria-label="Expand side panel" onClick={() => changeCollapsed(false)}><PanelRightOpen /></button>
          {focusedTabs.filter(isBuiltinTab).filter((tab, index, builtins) => !tab.prState || builtins.findIndex((candidate) => candidate.prState) === index).map((tab) => {
            const Icon = tab.key === 'session' ? NotebookText : tab.key === 'changes' ? FileDiff : GitPullRequest
            return <button key={tab.id} className="side-panel-expand" type="button" aria-label={`Open ${tab.prState ? 'PRs' : tab.label}`} title={tab.prState ? 'PRs' : tab.label} onClick={() => { onSelect(tab); changeCollapsed(false) }}><Icon />{tab.unseen && <i className={`side-panel-new${tab.warning ? ' is-warning' : ''}`} aria-label={tab.warning ? 'Session resume failed' : 'New updates'} />}</button>
          })}
        </div> : (
          <header className="side-panel-head">
            <div className="side-panel-tabs" role="tablist" aria-label={`Tabs for ${paneLabel}`}>
              {focusedTabs.map((tab) => {
                if (isBuiltinTab(tab)) {
                  const pr = parsePrPanelKey(tab.key)
                  const Icon = tab.key === 'session' ? NotebookText : tab.key === 'changes' ? FileDiff : GitPullRequest
                  return <div className={`side-panel-tab${active?.id === tab.id ? ' is-active' : ''}`} key={tab.id}>
                    <button type="button" role="tab" aria-label={tab.prState ? `${tab.label} ${tab.prState}` : undefined} aria-selected={active?.id === tab.id} aria-controls={`panel-tab-${tab.id}`} onClick={() => onSelect(tab)}>
                      <Icon aria-hidden="true" className={tab.prState ? `side-panel-pr-state ${tab.prState}` : undefined} /><span>{tab.label}</span>
                      {tab.prState && <i className={`side-panel-pr-indicator ${tab.prState}`} aria-label={tab.prState} />}
                      {tab.key === 'changes' && <span className="side-panel-counts"><b className="added">+{tab.additions}</b> <b className="deleted">−{tab.deletions}</b></span>}
                      {tab.unseen && <i className={`side-panel-new${tab.warning ? ' is-warning' : ''}`} aria-label={tab.warning ? 'Session resume failed' : 'New updates'} />}
                    </button>
                    {pr && <button type="button" className="side-panel-tab-close" aria-label={`Close PR #${pr.number} tab`} onClick={() => onDismissPr?.(tab, tab.prSignature!, active?.id === tab.id
                      ? resolveActivePanelTab(focusedTabs.filter((candidate) => candidate.id !== tab.id), tab.key, focusedTabs) : undefined)}><X /></button>}
                  </div>
                }
                const Icon = tab.content?.kind === 'canvas' ? LayoutDashboard : tab.content?.kind === 'guide' ? ListChecks : tab.content?.kind === 'simulator' ? Smartphone : /devtools/i.test(tab.url) ? Wrench : Globe
                const label = tabLabel(tab, titles[tab.id], tab.content?.kind === 'simulator' ? simulatorNames[tab.content.udid] : undefined)
                return <div className={`side-panel-tab${active?.id === tab.id ? ' is-active' : ''}${tab.id === focusedTabs.find((item) => !isBuiltinTab(item))?.id ? ' first-web-tab' : ''}`} key={tab.id}>
                  <button type="button" role="tab" aria-selected={active?.id === tab.id} aria-controls={`panel-tab-${tab.id}`} onClick={() => onSelect(tab)} title={tab.url || label}>
                    <Icon aria-hidden="true" />
                    <span className="side-panel-tab-label" dir={!tab.title && !titles[tab.id] && !tab.content ? 'rtl' : undefined}><bdi dir="ltr">{label}</bdi></span>
                    {tab.unseen && <i className="side-panel-new" aria-label="New tab" />}
                  </button>
                  <button type="button" className="side-panel-tab-close" aria-label={`Close ${label}`} onClick={() => onClose(tab.id)}><X /></button>
                </div>
              })}
              <button type="button" className="web-pane-button side-panel-add" aria-label="Add web tab" aria-expanded={adding !== null} onClick={() => setAdding(adding ? null : 'webkit')}><Plus /></button>
            </div>
            <span className="side-panel-owner" title={paneLabel}>{paneLabel}</span>
            {active && onMaximize && <button className="web-pane-button" type="button" aria-label={maximizedTab ? 'Restore panel tab' : 'Maximize panel tab'} onClick={() => onMaximize(active)}>{maximizedTab ? <Minimize2 /> : <Maximize2 />}</button>}
            {!maximizedTab && <button className="web-pane-button" type="button" aria-label={narrowMode ? "Close tabs drawer" : "Collapse side panel"} onClick={() => narrowMode ? closeDrawer() : changeCollapsed(true)}>{narrowMode ? <X /> : <PanelRightClose />}</button>}
          </header>
        )}
        {expanded && adding && <div className="side-panel-add-menu">
          <div><button type="button" aria-pressed={adding === 'webkit'} onClick={() => setAdding('webkit')}>Browser</button>
            <button type="button" aria-pressed={adding === 'chromium'} onClick={() => setAdding('chromium')}>Chromium</button></div>
          {closedPrs.length > 0 && <section className="side-panel-closed-prs">
            <h3>Closed PRs</h3>
            {closedPrs.map((pr) => <button key={prPanelKey(pr.repo, pr.number)} type="button" onClick={() => {
              onRestorePr?.(builtinPanelTab(focusedPaneId!, prPanelKey(pr.repo, pr.number)))
              setAdding(null)
            }}><i className={`side-panel-pr-indicator ${pr.state === 'open' && pr.isDraft ? 'draft' : pr.state}`} aria-label={pr.state === 'open' && pr.isDraft ? 'draft' : pr.state} /><span>{(paneData[focusedPaneId ?? '']?.prs?.pullRequests ?? []).filter((linked) => linked.number === pr.number).length > 1 ? pr.repo : ''}#{pr.number} · {pr.title}</span></button>)}
          </section>}
          <form onSubmit={(event) => { event.preventDefault(); open() }}>
            <input autoFocus value={url} onChange={(event) => setUrl(event.target.value)} placeholder="http://localhost:5173" aria-label="Tab URL" />
            <button type="submit" disabled={!focusedPaneId || !url.trim()}>Open</button>
          </form>
        </div>}
        <div className="side-panel-content">
          {allTabs.filter(isBuiltinTab).map((tab) => {
            const visible = !gridMaximized && expanded && tab.id === active?.id
            return <div id={`panel-tab-${tab.id}`} role="tabpanel" className="side-panel-tab-body" hidden={!visible} key={tab.id}>
              {(tab.key === 'session' || visible || visited.has(tab.id)) && renderBuiltin?.(tab, visible, paneData[tab.anchorPaneId] ?? { summary: null, prs: null })}
            </div>
          })}
          {tabs.map((tab) => {
            const visible = !gridMaximized && expanded && tab.id === active?.id
            return <div id={`panel-tab-${tab.id}`} role="tabpanel" className="side-panel-tab-body" hidden={!visible} key={tab.id}>{renderTab(tab, visible)}</div>
          })}
        </div>
      </aside>
    </div>
  )
}
