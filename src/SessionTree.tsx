import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, Columns2, FolderGit2, FolderPlus, FolderX, GitBranch, ListTree, Maximize2, MoreHorizontal, Pencil, Plus, Terminal, Trash2, X } from 'lucide-react'
import { type KeyboardEvent, useEffect, useRef, useState } from 'react'
import type { AgentStatus, PaneMark, TmuxPane, TmuxSession, TmuxWindow } from '../shared/protocol'
import type { TmuxCreatedTarget, TmuxCreatedWorktree } from '../shared/tmux-create'
import { createSessionManagementApi, type SessionGroupingMode, type SessionPreferenceGroup, type SessionTreePreferences } from './sessionManagementApi'
import { sessionShortcutIndex } from './sessionShortcuts'
import { DEFAULT_GROUPING_MODE, EMPTY_SESSION_TREE_PREFERENCES, sessionTreeContainers, type SessionTreeContainer } from './sessionTreePreferences'
import { NATIVE_TERMINAL_SHORTCUT_EVENT } from './nativeTerminalBridge'
import { SessionCreateDialog } from './SessionCreateDialog'
import { TmuxCreateControls, type SessionCreateRequest, type TmuxCreateControlsProps } from './TmuxCreateControls'
import './session-tree.css'

type SessionTreeCreation = Pick<TmuxCreateControlsProps, 'disabled' | 'onCreateSession' | 'probeRepo'> & {
  onCreated?: (created: TmuxCreatedTarget, worktree?: TmuxCreatedWorktree) => void
}

type Props = {
  token: string
  sessions: TmuxSession[]
  windows: TmuxWindow[]
  panes: TmuxPane[]
  displayedPaneIds: string[]
  statuses: Record<string, AgentStatus>
  marks?: Record<string, PaneMark>
  selectedSessionId: string | null
  focusedPaneId: string | null
  onSelectSession: (id: string) => void
  onSelectWindow: (id: string) => void
  onSelectPane: (id: string) => void
  onOpenPaneMaximized: (id: string) => void
  onWindowDeleting: (id: string) => void
  onSessionsChanged: () => void
  onPreferencesChanged: (preferences: SessionTreePreferences) => void
  creation?: SessionTreeCreation
}

const providerLabels: Record<AgentStatus['provider'], string> = {
  claude: 'Claude',
  codex: 'Codex',
  opencode: 'OpenCode',
  unknown: 'Unknown agent',
}

const statusLabels: Record<AgentStatus['status'], string> = {
  working: 'working',
  needs_input: 'needs input',
  done: 'done',
  failed: 'failed',
  stale: 'stale',
  unknown: 'unknown',
}

function paneLabel(pane: TmuxPane): string {
  return pane.title || pane.command || `Pane ${pane.index}`
}

function statusLabel(status: AgentStatus, pane: TmuxPane): string {
  return `${providerLabels[status.provider]}: ${statusLabels[status.status]} - ${paneLabel(pane)}`
}

function markLabel(mark: PaneMark, pane: TmuxPane): string {
  return `${mark.label}${mark.activityCount ? `, ${mark.activityCount} ${mark.activityCount === 1 ? 'activity' : 'activities'} since mark` : ''} - ${paneLabel(pane)}`
}

function suggestedDirectories(sessionIds: readonly string[], panes: readonly TmuxPane[]): string[] {
  const sessions = new Set(sessionIds)
  const counts = new Map<string, { count: number; order: number }>()
  for (const pane of panes) {
    if (!sessions.has(pane.sessionId) || !pane.path.startsWith('/')) continue
    const current = counts.get(pane.path)
    counts.set(pane.path, {
      count: (current?.count ?? 0) + 1,
      order: current?.order ?? counts.size,
    })
  }
  return [...counts]
    .sort((left, right) => right[1].count - left[1].count || left[1].order - right[1].order)
    .map(([directory]) => directory)
}

/** `/Users/me/dev/repo` → `~/dev/repo` for the group header hint. */
function shortenHome(path: string): string {
  return path.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/u, '~')
}

export function SessionTree(props: Props) {
  const api = useRef(createSessionManagementApi(props.token)).current
  const [preferences, setPreferences] = useState<SessionTreePreferences>(EMPTY_SESSION_TREE_PREFERENCES)
  const preferencesRef = useRef(preferences)
  const [menu, setMenu] = useState<{ sessionId: string; x: number; y: number } | null>(null)
  const [draggedSessionId, setDraggedSessionId] = useState<string | null>(null)
  const [collapsedContainerIds, setCollapsedContainerIds] = useState<Set<string>>(() => new Set())
  const [sessionCreateRequest, setSessionCreateRequest] = useState<SessionCreateRequest | null>(null)
  const [error, setError] = useState('')
  const sessionCreateRequestId = useRef(0)
  const sessionCreateTrigger = useRef<HTMLElement | null>(null)
  const preferenceSaveVersion = useRef(0)
  const windowMap = new Map(props.windows.map((window) => [window.id, window]))
  const paneMap = new Map(props.panes.map((pane) => [pane.id, pane]))
  const marks = props.marks ?? {}
  const displayedPaneOrder = new Map(props.displayedPaneIds.map((paneId, index) => [paneId, index]))
  const sessionMap = new Map(props.sessions.map((session) => [session.id, session]))
  const mode: SessionGroupingMode = preferences.groupingMode ?? DEFAULT_GROUPING_MODE
  const manual = mode === 'manual'

  useEffect(() => {
    api.loadPreferences().then((next) => {
      preferencesRef.current = next
      setPreferences(next)
      props.onPreferencesChanged(next)
    }).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : 'Unable to load session order'))
  }, [api, props.onPreferencesChanged, props.sessions.length])
  useEffect(() => {
    if (!menu) return
    const close = () => setMenu(null)
    window.addEventListener('pointerdown', close)
    window.addEventListener('blur', close)
    return () => { window.removeEventListener('pointerdown', close); window.removeEventListener('blur', close) }
  }, [menu])

  const save = (next: SessionTreePreferences) => {
    const saveVersion = ++preferenceSaveVersion.current
    preferencesRef.current = next
    setPreferences(next)
    props.onPreferencesChanged(next)
    api.savePreferences(next).then((saved) => {
      if (saveVersion !== preferenceSaveVersion.current) return
      preferencesRef.current = saved
      setPreferences(saved)
      props.onPreferencesChanged(saved)
    }).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : 'Unable to save session order'))
  }

  const containers = sessionTreeContainers(preferences, props.sessions, { mode, panes: props.panes })
  const shortcutSessionIds = containers
    .flatMap((container) => container.sessionIds)
    .filter((sessionId) => sessionMap.has(sessionId))

  useEffect(() => {
    const selectShortcutSession = (event: globalThis.KeyboardEvent) => {
      const index = sessionShortcutIndex(event)
      const sessionId = index === null ? undefined : shortcutSessionIds[index]
      if (!sessionId) return
      event.preventDefault()
      props.onSelectSession(sessionId)
    }
    window.addEventListener('keydown', selectShortcutSession)
    const selectNativeShortcutSession = (event: Event) => {
      const key = (event as CustomEvent<{ key?: string }>).detail?.key
      const index = key && /^[1-9]$/.test(key) ? Number(key) - 1 : null
      const sessionId = index === null ? undefined : shortcutSessionIds[index]
      if (sessionId) props.onSelectSession(sessionId)
    }
    window.addEventListener(NATIVE_TERMINAL_SHORTCUT_EVENT, selectNativeShortcutSession)
    return () => {
      window.removeEventListener('keydown', selectShortcutSession)
      window.removeEventListener(NATIVE_TERMINAL_SHORTCUT_EVENT, selectNativeShortcutSession)
    }
  }, [props.onSelectSession, shortcutSessionIds])

  const setGroupingMode = (groupingMode: SessionGroupingMode) => {
    if (groupingMode === mode) return
    setDraggedSessionId(null)
    save({ ...preferencesRef.current, groupingMode })
  }

  const moveToContainer = (sessionId: string, destinationId: string, beforeId?: string) => {
    const currentPreferences = preferencesRef.current
    if (beforeId === sessionId) return
    if (!manual) {
      const container = sessionTreeContainers(currentPreferences, props.sessions, { mode, panes: props.panes })
        .find((candidate) => candidate.id === destinationId)
      if (!container?.sessionIds.includes(sessionId) || (beforeId && !container.sessionIds.includes(beforeId))) return
      const sessionIds = container.sessionIds.filter((id) => id !== sessionId)
      const index = beforeId ? sessionIds.indexOf(beforeId) : sessionIds.length
      sessionIds.splice(index, 0, sessionId)
      if (sessionIds.every((id, position) => id === container.sessionIds[position])) return
      const otherSessionIds = (currentPreferences.repositorySessionIds ?? [])
        .filter((id) => !container.sessionIds.includes(id))
      save({ ...currentPreferences, repositorySessionIds: [...otherSessionIds, ...sessionIds] })
      return
    }
    const groups = currentPreferences.groups.map((group) => ({ ...group, sessionIds: group.sessionIds.filter((id) => id !== sessionId) }))
    let ungroupedSessionIds = currentPreferences.ungroupedSessionIds.filter((id) => id !== sessionId)
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
    save({ ...currentPreferences, groups, ungroupedSessionIds })
  }

  const createGroup = () => {
    const name = window.prompt('New session group name')?.trim()
    if (!name) return
    const group: SessionPreferenceGroup = { id: crypto.randomUUID(), name, sessionIds: [] }
    save({ ...preferences, groups: [...preferences.groups, group] })
  }

  const createSessionInContainer = (container: SessionTreeContainer, trigger: HTMLElement) => {
    sessionCreateRequestId.current += 1
    sessionCreateTrigger.current = trigger
    const directories = suggestedDirectories(container.sessionIds, props.panes)
    setSessionCreateRequest({
      id: sessionCreateRequestId.current,
      groupId: container.id,
      groupName: container.name,
      suggestedDirectories: container.repo
        ? [container.repo.root, ...directories.filter((directory) => directory !== container.repo?.root)]
        : directories,
      ...(container.repo ? { repo: container.repo } : {}),
    })
  }

  const closeSessionDialog = () => {
    setSessionCreateRequest(null)
    const trigger = sessionCreateTrigger.current
    sessionCreateTrigger.current = null
    trigger?.focus()
  }

  const moveGroup = (groupId: string, direction: -1 | 1) => {
    const index = preferences.groups.findIndex((group) => group.id === groupId)
    const destination = index + direction
    if (index < 0 || destination < 0 || destination >= preferences.groups.length) return
    const groups = [...preferences.groups]
    ;[groups[index], groups[destination]] = [groups[destination], groups[index]]
    save({ ...preferences, groups })
  }

  const renameSession = async (sessionId: string) => {
    const session = sessionMap.get(sessionId)
    const name = window.prompt('Rename tmux session', session?.name ?? '')?.trim()
    if (!name || name === session?.name) return
    try { await api.renameSession(sessionId, name); props.onSessionsChanged() }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Unable to rename session') }
  }

  const deleteSession = async (sessionId: string, deleteWorktree = false) => {
    const session = sessionMap.get(sessionId)
    const label = session?.name ?? sessionId
    const confirmation = deleteWorktree
      ? `Delete tmux session “${label}” and its linked worktree?\n\nUncommitted changes in the worktree will be permanently deleted. The git branch will be kept.`
      : `Delete tmux session “${label}” and all of its windows and panes?`
    if (!window.confirm(confirmation)) return
    try { await api.deleteSession(sessionId, deleteWorktree); props.onSessionsChanged() }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Unable to delete session') }
  }

  const deleteWindow = async (windowId: string) => {
    const tmuxWindow = windowMap.get(windowId)
    if (!tmuxWindow) return
    const session = sessionMap.get(tmuxWindow.sessionId)
    const lastWindow = session?.windowIds.length === 1
    const consequence = lastWindow ? ' This is the last window, so tmux will also close the session.' : ''
    if (!window.confirm(`Close window "${tmuxWindow.name}" and terminate all of its panes?${consequence}`)) return
    props.onWindowDeleting(windowId)
    try { await api.deleteWindow(windowId); props.onSessionsChanged() }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Unable to close window') }
  }

  const finishCreated = (created: TmuxCreatedTarget, sessionGroupId: string | undefined, worktree: TmuxCreatedWorktree | undefined) => {
    if (created.kind === 'session' && manual && sessionGroupId && sessionGroupId !== 'ungrouped') {
      moveToContainer(created.sessionId, sessionGroupId)
    }
    if (worktree) props.creation?.onCreated?.(created, worktree)
    else props.creation?.onCreated?.(created)
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
      <div className="session-tree-tools">
        <span>{props.sessions.length} sessions</span>
        <span className="session-tree-tools-actions">
          {manual ? <button type="button" onClick={createGroup}><FolderPlus /> Group</button> : null}
          <span className="session-grouping-switch" role="group" aria-label="Group sessions by">
            <button type="button" aria-pressed={!manual} aria-label="Group sessions by repository" title="Group sessions by repository" onClick={() => setGroupingMode('repository')}><FolderGit2 />Repo</button>
            <button type="button" aria-pressed={manual} aria-label="Group sessions manually" title="Group sessions manually" onClick={() => setGroupingMode('manual')}><ListTree />Manual</button>
          </span>
        </span>
      </div>
      {error ? <button type="button" className="session-tree-error" onClick={() => setError('')}>{error}</button> : null}
      {containers.map((container) => {
        const groupIndex = container.group ? preferences.groups.findIndex((group) => group.id === container.id) : -1
        const collapsed = collapsedContainerIds.has(container.id)
        const groupBodyId = `session-group-${container.id.replace(/[^A-Za-z0-9_-]/gu, '_')}`
        const sessionCount = container.sessionIds.filter((id) => sessionMap.has(id)).length
        const droppable = Boolean(draggedSessionId && (manual || container.sessionIds.includes(draggedSessionId)))
        return (
        <section
          className={`session-pref-group kind-${container.kind}`}
          key={container.id}
          onDragOver={droppable ? (event) => { if (draggedSessionId) event.preventDefault() } : undefined}
          onDrop={droppable ? (event) => { event.preventDefault(); if (draggedSessionId) moveToContainer(draggedSessionId, container.id); setDraggedSessionId(null) } : undefined}
        >
          <header>
            <button
              type="button"
              className="session-pref-toggle"
              onClick={() => setCollapsedContainerIds((current) => {
                const next = new Set(current)
                if (collapsed) next.delete(container.id)
                else next.add(container.id)
                return next
              })}
              aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${container.name}`}
              aria-expanded={!collapsed}
              aria-controls={groupBodyId}
            >
              {collapsed ? <ChevronRight /> : <ChevronDown />}
              <strong>{container.name}</strong>
              <small>{sessionCount}</small>
              {container.repo ? <span className="session-repo-path" title={container.repo.root}>{shortenHome(container.repo.root)}</span> : null}
            </button>
            {props.creation && container.kind !== 'no-repo' ? <button type="button" onClick={(event) => createSessionInContainer(container, event.currentTarget)} aria-label={`Create a new session in ${container.name}`} title={`Create a new session in ${container.name}`}><Plus /></button> : null}
            {container.group ? <><button type="button" onClick={() => moveGroup(container.id, -1)} disabled={groupIndex === 0} aria-label={`Move ${container.name} up`}><ArrowUp /></button><button type="button" onClick={() => moveGroup(container.id, 1)} disabled={groupIndex === preferences.groups.length - 1} aria-label={`Move ${container.name} down`}><ArrowDown /></button><button type="button" onClick={() => { const name = window.prompt('Rename group', container.name)?.trim(); if (name) save({ ...preferences, groups: preferences.groups.map((group) => group.id === container.id ? { ...group, name } : group) }) }} aria-label={`Rename ${container.name}`}><Pencil /></button><button type="button" onClick={() => save({ ...preferences, groups: preferences.groups.filter((group) => group.id !== container.id), ungroupedSessionIds: [...preferences.ungroupedSessionIds, ...container.sessionIds] })} aria-label={`Delete ${container.name}`}><Trash2 /></button></> : null}
          </header>
          <div id={groupBodyId} hidden={collapsed}>
            {container.sessionIds.flatMap((sessionId) => {
              const session = sessionMap.get(sessionId)
              if (!session) return []
              const selected = session.id === props.selectedSessionId
              const branch = container.sessionBranches?.[session.id]
              const sessionPanes = props.panes
                .filter((pane) => pane.sessionId === session.id)
                .sort((left, right) => (displayedPaneOrder.get(left.id) ?? Number.MAX_SAFE_INTEGER) - (displayedPaneOrder.get(right.id) ?? Number.MAX_SAFE_INTEGER))
              const statusPanes = sessionPanes.filter((pane) => props.statuses[pane.id])
              const markedPanes = sessionPanes.filter((pane) => marks[pane.targetId])
              return [<article
                className={`managed-session${selected ? ' selected' : ''}${draggedSessionId === session.id ? ' dragging' : ''}`}
                draggable
                onDragStart={(event) => {
                  event.dataTransfer?.setData('text/plain', session.id)
                  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
                  setDraggedSessionId(session.id)
                }}
                onDragEnd={() => setDraggedSessionId(null)}
                onDragOver={droppable ? (event) => event.preventDefault() : undefined}
                onDrop={droppable ? (event) => {
                  event.preventDefault()
                  event.stopPropagation()
                  if (draggedSessionId) moveToContainer(draggedSessionId, container.id, session.id)
                  setDraggedSessionId(null)
                } : undefined}
                key={session.id}
              >
                <div className="managed-session-row">
                  <button type="button" className="managed-session-main" onClick={() => props.onSelectSession(session.id)} onContextMenu={(event) => { event.preventDefault(); openMenu(session.id, event.clientX, event.clientY) }} onKeyDown={(event) => menuKey(event, session.id)} aria-expanded={selected}>{selected ? <ChevronDown /> : <ChevronRight />}<span className="managed-session-copy"><strong>{session.name}</strong><small>{branch ? <span className="session-branch" title={`On branch ${branch}`}><GitBranch />{branch}</span> : null}{session.windowIds.length} windows / {sessionPanes.length} panes</small></span></button>
                  {statusPanes.length ? <span className="session-status-cluster">{statusPanes.map((pane) => { const status = props.statuses[pane.id]; const label = statusLabel(status, pane); return <button type="button" key={pane.id} className={`session-status-dot ${status.status}`} onClick={() => props.onSelectPane(pane.id)} aria-label={label} title={label} /> })}</span> : null}
                  {markedPanes.length ? <span className="session-mark-cluster">{markedPanes.map((pane) => { const mark = marks[pane.targetId]; const label = markLabel(mark, pane); return <button type="button" key={pane.targetId} className={`session-mark-dot tone-${mark.tone}${mark.activityCount ? ' has-activity' : ''}`} onClick={() => props.onSelectPane(pane.id)} aria-label={label} title={label}>{mark.activityCount ? <small>{mark.activityCount}</small> : null}</button> })}</span> : null}
                  <span className="session-row-actions"><button type="button" onClick={(event) => { const bounds = event.currentTarget.getBoundingClientRect(); openMenu(session.id, bounds.left, bounds.bottom) }} aria-label={`Actions for ${session.name}`}><MoreHorizontal /></button></span>
                </div>
                {selected ? <div className="managed-window-tree">{session.windowIds.map((windowId) => { const tmuxWindow = windowMap.get(windowId); if (!tmuxWindow) return null; const paneIds = [...tmuxWindow.paneIds].sort((left, right) => (displayedPaneOrder.get(left) ?? Number.MAX_SAFE_INTEGER) - (displayedPaneOrder.get(right) ?? Number.MAX_SAFE_INTEGER)); return <div key={tmuxWindow.id}><div className="managed-window-row"><button type="button" className="managed-window-main" onClick={() => props.onSelectWindow(tmuxWindow.id)}><Columns2 /><span>{tmuxWindow.index}: {tmuxWindow.name}</span><small>{tmuxWindow.paneIds.length}</small></button><button type="button" className="managed-window-close" onClick={() => void deleteWindow(tmuxWindow.id)} aria-label={`Close window ${tmuxWindow.name}`} title="Close window"><X /></button></div><div className="managed-window-panes">{paneIds.map((paneId) => { const pane = paneMap.get(paneId); if (!pane) return null; const status = props.statuses[pane.id]; const mark = marks[pane.targetId]; const label = paneLabel(pane); const agentLabel = status ? statusLabel(status, pane) : ''; const paneMarkLabel = mark ? markLabel(mark, pane) : ''; return <div className={`managed-pane-row${props.focusedPaneId === pane.id ? ' active' : ''}`} key={pane.id}><button type="button" className="managed-pane-main" onClick={() => props.onSelectPane(pane.id)}><Terminal /><span>{label}</span>{mark ? <i className={`mini-pane-mark tone-${mark.tone}${mark.activityCount ? ' has-activity' : ''}`} role="img" aria-label={paneMarkLabel} title={paneMarkLabel}>{mark.activityCount ? <small>{mark.activityCount}</small> : null}</i> : null}{status ? <i className={`mini-status ${status.status}`} role="img" aria-label={agentLabel} title={agentLabel} /> : null}</button><button type="button" className="managed-pane-maximize" onClick={() => props.onOpenPaneMaximized(pane.id)} aria-label={`Open ${label} maximized`} title="Open maximized"><Maximize2 /></button></div> })}</div></div> })}</div> : null}
              </article>]
            })}
            {manual && !container.sessionIds.some((id) => sessionMap.has(id)) ? <p className="session-pref-empty">Drop a session here.</p> : null}
          </div>
        </section>
        )
      })}
      {props.creation ? <TmuxCreateControls
        disabled={props.creation.disabled}
        onCreateSession={props.creation.onCreateSession}
        probeRepo={props.creation.probeRepo}
        onCreated={(created, sessionGroupId, worktree) => finishCreated(created, sessionGroupId, worktree)}
      /> : null}
      {props.creation && sessionCreateRequest ? <SessionCreateDialog
        request={sessionCreateRequest}
        disabled={props.creation.disabled}
        onCreateSession={props.creation.onCreateSession}
        probeRepo={props.creation.probeRepo}
        onCreated={(created, sessionGroupId, worktree) => { finishCreated(created, sessionGroupId, worktree); closeSessionDialog() }}
        onClose={closeSessionDialog}
      /> : null}
      {menu ? <div className="session-context-menu" data-native-terminal-occluder="" style={{ left: menu.x, top: menu.y }} role="menu" onPointerDown={(event) => event.stopPropagation()}><button type="button" role="menuitem" onClick={() => { void renameSession(menu.sessionId); setMenu(null) }}><Pencil /> Rename</button><button type="button" className="danger" role="menuitem" onClick={() => { void deleteSession(menu.sessionId); setMenu(null) }}><Trash2 /> Delete session</button>{props.panes.some((pane) => pane.sessionId === menu.sessionId && pane.repo?.isWorktree) ? <button type="button" className="danger" role="menuitem" onClick={() => { void deleteSession(menu.sessionId, true); setMenu(null) }}><FolderX /> Delete session and worktree</button> : null}</div> : null}
    </div>
  )
}
