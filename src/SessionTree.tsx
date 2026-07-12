import { ChevronDown, ChevronRight, Columns2, FolderPlus, Maximize2, MoreHorizontal, Pencil, Terminal, Trash2 } from 'lucide-react'
import { type KeyboardEvent, useEffect, useRef, useState } from 'react'
import type { AgentStatus, TmuxPane, TmuxSession, TmuxWindow } from '../shared/protocol'
import { createSessionManagementApi, type SessionPreferenceGroup, type SessionTreePreferences } from './sessionManagementApi'
import './session-tree.css'

type Props = {
  token: string
  sessions: TmuxSession[]
  windows: TmuxWindow[]
  panes: TmuxPane[]
  displayedPaneIds: string[]
  statuses: Record<string, AgentStatus>
  selectedSessionId: string | null
  focusedPaneId: string | null
  onSelectSession: (id: string) => void
  onSelectWindow: (id: string) => void
  onSelectPane: (id: string) => void
  onOpenPaneMaximized: (id: string) => void
  onSessionsChanged: () => void
}

const emptyPreferences: SessionTreePreferences = { version: 1, groups: [], ungroupedSessionIds: [] }

export function SessionTree(props: Props) {
  const api = useRef(createSessionManagementApi(props.token)).current
  const [preferences, setPreferences] = useState<SessionTreePreferences>(emptyPreferences)
  const [menu, setMenu] = useState<{ sessionId: string; x: number; y: number } | null>(null)
  const [draggedSessionId, setDraggedSessionId] = useState<string | null>(null)
  const [error, setError] = useState('')
  const windowMap = new Map(props.windows.map((window) => [window.id, window]))
  const paneMap = new Map(props.panes.map((pane) => [pane.id, pane]))
  const displayedPaneOrder = new Map(props.displayedPaneIds.map((paneId, index) => [paneId, index]))
  const sessionMap = new Map(props.sessions.map((session) => [session.id, session]))

  useEffect(() => {
    api.loadPreferences().then(setPreferences).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : 'Unable to load session order'))
  }, [api, props.sessions.length])
  useEffect(() => {
    if (!menu) return
    const close = () => setMenu(null)
    window.addEventListener('pointerdown', close)
    window.addEventListener('blur', close)
    return () => { window.removeEventListener('pointerdown', close); window.removeEventListener('blur', close) }
  }, [menu])

  const save = (next: SessionTreePreferences) => {
    setPreferences(next)
    api.savePreferences(next).then(setPreferences).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : 'Unable to save session order'))
  }

  const containers = [
    ...preferences.groups.map((group) => ({ id: group.id, name: group.name, sessionIds: group.sessionIds, group })),
    { id: 'ungrouped', name: 'Ungrouped', sessionIds: preferences.ungroupedSessionIds, group: null },
  ]
  const known = new Set(containers.flatMap((container) => container.sessionIds))
  const missing = props.sessions.map((session) => session.id).filter((id) => !known.has(id))
  if (missing.length) containers[containers.length - 1].sessionIds = [...containers[containers.length - 1].sessionIds, ...missing]

  const moveToContainer = (sessionId: string, destinationId: string, beforeId?: string) => {
    const groups = preferences.groups.map((group) => ({ ...group, sessionIds: group.sessionIds.filter((id) => id !== sessionId) }))
    let ungroupedSessionIds = preferences.ungroupedSessionIds.filter((id) => id !== sessionId)
    if (destinationId === 'ungrouped') {
      const index = beforeId ? ungroupedSessionIds.indexOf(beforeId) : -1
      if (index >= 0) ungroupedSessionIds.splice(index, 0, sessionId)
      else ungroupedSessionIds.push(sessionId)
    } else {
      const group = groups.find((candidate) => candidate.id === destinationId)
      if (!group) return
      const index = beforeId ? group.sessionIds.indexOf(beforeId) : -1
      if (index >= 0) group.sessionIds.splice(index, 0, sessionId)
      else group.sessionIds.push(sessionId)
    }
    save({ version: 1, groups, ungroupedSessionIds })
  }

  const createGroup = () => {
    const name = window.prompt('New session group name')?.trim()
    if (!name) return
    const group: SessionPreferenceGroup = { id: crypto.randomUUID(), name, sessionIds: [] }
    save({ ...preferences, groups: [...preferences.groups, group] })
  }

  const renameSession = async (sessionId: string) => {
    const session = sessionMap.get(sessionId)
    const name = window.prompt('Rename tmux session', session?.name ?? '')?.trim()
    if (!name || name === session?.name) return
    try { await api.renameSession(sessionId, name); props.onSessionsChanged() }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Unable to rename session') }
  }

  const deleteSession = async (sessionId: string) => {
    const session = sessionMap.get(sessionId)
    if (!window.confirm(`Delete tmux session “${session?.name ?? sessionId}” and all of its windows and panes?`)) return
    try { await api.deleteSession(sessionId); props.onSessionsChanged() }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Unable to delete session') }
  }

  const openMenu = (sessionId: string, x: number, y: number) => setMenu({ sessionId, x, y })
  const menuKey = (event: KeyboardEvent, sessionId: string) => {
    if ((event.shiftKey && event.key === 'F10') || event.key === 'ContextMenu') {
      event.preventDefault()
      const bounds = event.currentTarget.getBoundingClientRect()
      openMenu(sessionId, bounds.left + 28, bounds.bottom)
    }
  }

  return (
    <div className="managed-session-tree">
      <div className="session-tree-tools"><span>{props.sessions.length} sessions</span><button type="button" onClick={createGroup}><FolderPlus /> Group</button></div>
      {error ? <button type="button" className="session-tree-error" onClick={() => setError('')}>{error}</button> : null}
      {containers.map((container) => (
        <section
          className="session-pref-group"
          key={container.id}
          onDragOver={(event) => { if (draggedSessionId) event.preventDefault() }}
          onDrop={(event) => { event.preventDefault(); if (draggedSessionId) moveToContainer(draggedSessionId, container.id); setDraggedSessionId(null) }}
        >
          <header>
            <strong>{container.name}</strong><small>{container.sessionIds.filter((id) => sessionMap.has(id)).length}</small>
            {container.group ? <><button type="button" onClick={() => { const name = window.prompt('Rename group', container.name)?.trim(); if (name) save({ ...preferences, groups: preferences.groups.map((group) => group.id === container.id ? { ...group, name } : group) }) }} aria-label={`Rename ${container.name}`}><Pencil /></button><button type="button" onClick={() => save({ ...preferences, groups: preferences.groups.filter((group) => group.id !== container.id), ungroupedSessionIds: [...preferences.ungroupedSessionIds, ...container.sessionIds] })} aria-label={`Delete ${container.name}`}><Trash2 /></button></> : null}
          </header>
          <div>
            {container.sessionIds.flatMap((sessionId) => {
              const session = sessionMap.get(sessionId)
              if (!session) return []
              const selected = session.id === props.selectedSessionId
              const sessionPanes = props.panes.filter((pane) => pane.sessionId === session.id)
              return [<article className={`managed-session${selected ? ' selected' : ''}`} draggable onDragStart={() => setDraggedSessionId(session.id)} onDragEnd={() => setDraggedSessionId(null)} onDragOver={(event) => { if (draggedSessionId) event.preventDefault() }} onDrop={(event) => { event.preventDefault(); if (draggedSessionId && draggedSessionId !== session.id) moveToContainer(draggedSessionId, container.id, session.id); setDraggedSessionId(null) }} key={session.id}>
                <div className="managed-session-row">
                  <button type="button" className="managed-session-main" onClick={() => props.onSelectSession(session.id)} onContextMenu={(event) => { event.preventDefault(); openMenu(session.id, event.clientX, event.clientY) }} onKeyDown={(event) => menuKey(event, session.id)} aria-expanded={selected}>{selected ? <ChevronDown /> : <ChevronRight />}<span className={`live-dot${session.attached ? ' attached' : ''}`} /><span><strong>{session.name}</strong><small>{session.windowIds.length} windows / {sessionPanes.length} panes</small></span></button>
                  <span className="session-row-actions"><button type="button" onClick={(event) => { const bounds = event.currentTarget.getBoundingClientRect(); openMenu(session.id, bounds.left, bounds.bottom) }} aria-label={`Actions for ${session.name}`}><MoreHorizontal /></button></span>
                </div>
                {selected ? <div className="managed-window-tree">{session.windowIds.map((windowId) => { const tmuxWindow = windowMap.get(windowId); if (!tmuxWindow) return null; const paneIds = [...tmuxWindow.paneIds].sort((left, right) => (displayedPaneOrder.get(left) ?? Number.MAX_SAFE_INTEGER) - (displayedPaneOrder.get(right) ?? Number.MAX_SAFE_INTEGER)); return <div key={tmuxWindow.id}><button type="button" onClick={() => props.onSelectWindow(tmuxWindow.id)}><Columns2 /><span>{tmuxWindow.index}: {tmuxWindow.name}</span><small>{tmuxWindow.paneIds.length}</small></button><div>{paneIds.map((paneId) => { const pane = paneMap.get(paneId); if (!pane) return null; const status = props.statuses[pane.id]; const label = pane.title || pane.command || `Pane ${pane.index}`; return <div className={`managed-pane-row${props.focusedPaneId === pane.id ? ' active' : ''}`} key={pane.id}><button type="button" className="managed-pane-main" onClick={() => props.onSelectPane(pane.id)}><Terminal /><span>{label}</span>{status ? <i className={`mini-status ${status.status}`} /> : null}</button><button type="button" className="managed-pane-maximize" onClick={() => props.onOpenPaneMaximized(pane.id)} aria-label={`Open ${label} maximized`} title="Open maximized"><Maximize2 /></button></div> })}</div></div> })}</div> : null}
              </article>]
            })}
            {!container.sessionIds.some((id) => sessionMap.has(id)) ? <p className="session-pref-empty">Drop a session here.</p> : null}
          </div>
        </section>
      ))}
      {menu ? <div className="session-context-menu" style={{ left: menu.x, top: menu.y }} role="menu" onPointerDown={(event) => event.stopPropagation()}><button type="button" role="menuitem" onClick={() => { void renameSession(menu.sessionId); setMenu(null) }}><Pencil /> Rename</button><button type="button" className="danger" role="menuitem" onClick={() => { void deleteSession(menu.sessionId); setMenu(null) }}><Trash2 /> Delete session</button></div> : null}
    </div>
  )
}
