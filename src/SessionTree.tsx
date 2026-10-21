import type { CommanderState } from '../shared/commander'
import { isSessionGlyph, sessionIdentityForName } from '../shared/session-identity'
import { SessionAvatar } from './SessionAvatar'
import { Bot, Archive, ArrowDown, ArrowUp, ChevronDown, ChevronRight, Code2, FolderGit2, FolderPlus, FolderX, ListTree, MoreHorizontal, Pencil, Plus, RotateCcw, Smartphone, Trash2 } from 'lucide-react'
import { type KeyboardEvent, type Ref, useEffect, useImperativeHandle, useRef, useState } from 'react'
import type { AgentStatus, PaneMark, SessionIde, SimulatorClaim, TmuxPane, TmuxSession } from '../shared/protocol'
import type { TmuxCreatedTarget, TmuxCreatedWorktree } from '../shared/tmux-create'
import { auxiliarySessionIds } from '../shared/auxiliary-session'
import { createSessionManagementApi, type SessionArchiveSummary, type SessionGroupingMode, type SessionPreferenceGroup, type SessionTreePreferences } from './sessionManagementApi'
import { sessionShortcutIndex } from './sessionShortcuts'
import { DEFAULT_GROUPING_MODE, EMPTY_SESSION_TREE_PREFERENCES, sessionTreeContainers, type SessionTreeContainer } from './sessionTreePreferences'
import { NATIVE_TERMINAL_SHORTCUT_EVENT } from './nativeTerminalBridge'
import { SessionCreateDialog } from './SessionCreateDialog'
import { TmuxCreateControls, type SessionCreateRequest, type TmuxCreateControlsProps } from './TmuxCreateControls'
import './session-tree.css'
import { OpenedByMarker } from './OpenedByMarker'
import { AgentChatRequestBadge } from './AgentChatRequestBadge'
import type { AgentChatRequest } from '../shared/agent-chats'
import './session-ide.css'
import type { PrsApiClient } from './prsApi'
import { SessionPrCount } from './SessionPrCount'
import { paneAttention, paneAttentionLabels, sessionIndicator } from './sessionIndicator'
import { ARCHIVE_RESTORE_NOTE } from './sessionProcesses'

type SessionTreeCreation = Pick<TmuxCreateControlsProps, 'disabled' | 'onCreateSession' | 'probeRepo' | 'loadClaudeProfiles'> & {
  onCreated?: (created: TmuxCreatedTarget, worktree?: TmuxCreatedWorktree) => void
}

/**
 * The session menu's actions, for menus outside the tree. A `confirmation` of
 * null skips the dialog; a string replaces it. Deleting a worktree always
 * confirms, with any `confirmation` leading its dialog. `onError` reports
 * failures where the caller can see them instead of in the tree.
 */
export type SessionActions = {
  renameSession: (sessionId: string, onError?: (message: string) => void) => Promise<void>
  changeIdentity: (sessionId: string, reset?: boolean, onError?: (message: string) => void) => Promise<void>
  archiveSession: (sessionId: string, confirmation?: string | null, onError?: (message: string) => void) => Promise<void>
  deleteSession: (sessionId: string, deleteWorktree?: boolean, confirmation?: string | null, onError?: (message: string) => void) => Promise<void>
}

type Props = {
  token: string
  actionsRef?: Ref<SessionActions | null>
  commanderState?: CommanderState
  commanderNeedsYou?: number
  commanderUnreadFinished?: boolean
  commanderOpening?: boolean
  onCreateCommander?: () => Promise<void>
  sessions: TmuxSession[]
  panes: TmuxPane[]
  displayedPaneIds: string[]
  statuses: Record<string, AgentStatus>
  marks?: Record<string, PaneMark>
  /** When the user last viewed each pane, by daemon clock. */
  seen?: Record<string, number>
  agentChatRequests?: Record<string, AgentChatRequest>
  /** Leased simulators keyed by pane id. */
  simulators?: Record<string, SimulatorClaim>
  selectedSessionId: string | null
  onSelectSession: (id: string) => void
  onSelectPane: (id: string) => void
  onShowSimulator?: (udid: string, paneId: string) => void
  onSessionsChanged: () => void
  onPreferencesChanged: (preferences: SessionTreePreferences) => void
  creation?: SessionTreeCreation
  ides?: SessionIde[]
  ideSessionId?: string | null
  onOpenIde?: (sessionId: string) => void
  onResumeChat?: (sessionId: string) => void
  prsApi?: PrsApiClient
  connected?: boolean
}

const providerLabels: Record<AgentStatus['provider'], string> = {
  claude: 'Claude',
  codex: 'Codex',
  opencode: 'OpenCode',
  cursor: 'Cursor',
  muse: 'Muse',
  unknown: 'Unknown agent',
}

function paneLabel(pane: TmuxPane): string {
  if (pane.empty) return 'Nothing running yet'
  return pane.title || pane.command || `Pane ${pane.index}`
}

function statusLabel(status: AgentStatus, seenAt: number | undefined, pane: TmuxPane): string {
  return `${providerLabels[status.provider]}: ${paneAttentionLabels[paneAttention(status, seenAt)]} - ${paneLabel(pane)}`
}

function markLabel(mark: PaneMark, pane: TmuxPane): string {
  return `${mark.label}${mark.activityCount ? `, ${mark.activityCount} ${mark.activityCount === 1 ? 'activity' : 'activities'} since mark` : ''} - ${paneLabel(pane)}`
}

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`

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

export function SessionTree(props: Props) {
  const api = useRef(createSessionManagementApi(props.token)).current
  const [preferences, setPreferences] = useState<SessionTreePreferences>(EMPTY_SESSION_TREE_PREFERENCES)
  const preferencesRef = useRef(preferences)
  const [menu, setMenu] = useState<{ sessionId: string; x: number; y: number } | null>(null)
  const [draggedSessionId, setDraggedSessionId] = useState<string | null>(null)
  const [collapsedContainerIds, setCollapsedContainerIds] = useState<Set<string>>(() => new Set(['auxiliary']))
  const [sessionCreateRequest, setSessionCreateRequest] = useState<SessionCreateRequest | null>(null)
  const [error, setError] = useState('')
  const [archives, setArchives] = useState<SessionArchiveSummary[]>([])
  const [archivesExpanded, setArchivesExpanded] = useState(false)
  const sessionCreateRequestId = useRef(0)
  const sessionCreateTrigger = useRef<HTMLElement | null>(null)
  const preferenceSaveVersion = useRef(0)
  const marks = props.marks ?? {}
  const seen = props.seen ?? {}
  const lineageSnapshot = { panes: props.panes, sessions: props.sessions }
  const displayedPaneOrder = new Map(props.displayedPaneIds.map((paneId, index) => [paneId, index]))
  const sessionMap = new Map(props.sessions.map((session) => [session.id, session]))
  const mode: SessionGroupingMode = preferences.groupingMode ?? DEFAULT_GROUPING_MODE
  const manual = mode === 'manual'
  const liveTargetIds = new Set(props.panes.map((pane) => pane.targetId))
  const jumpToTarget = (targetId: string) => {
    const panes = props.panes.filter((pane) => pane.targetId === targetId)
    if (panes.length === 1) props.onSelectPane(panes[0].id)
  }

  const sessionNamesKey = JSON.stringify(props.sessions.map((session) => session.name))
  useEffect(() => {
    let active = true
    api.loadPreferences().then((next) => {
      if (!active) return
      preferencesRef.current = next
      setPreferences(next)
      props.onPreferencesChanged(next)
    }).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : 'Unable to load session order'))
    return () => { active = false }
  }, [api, props.onPreferencesChanged, sessionNamesKey])
  useEffect(() => {
    let active = true
    api.listArchives().then((items) => { if (active) setArchives(items) })
      .catch((cause: unknown) => { if (active) setError(cause instanceof Error ? cause.message : 'Unable to load archives') })
    return () => { active = false }
  }, [api])
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

  const commanderSessionId = props.commanderState?.sessionId && sessionMap.has(props.commanderState.sessionId)
    ? props.commanderState.sessionId : undefined
  const auxiliaryIds = auxiliarySessionIds(props.sessions, props.panes, commanderSessionId)
  const auxiliarySessions = props.sessions.filter((session) => auxiliaryIds.has(session.id))
  const containers: SessionTreeContainer[] = [
    ...sessionTreeContainers(preferences, props.sessions.filter((session) => !auxiliaryIds.has(session.id) && session.id !== commanderSessionId), { mode, panes: props.panes })
      .map((container) => ({ ...container, sessionIds: container.sessionIds.filter((id) => !auxiliaryIds.has(id) && id !== commanderSessionId) })),
    ...(auxiliarySessions.length ? [{ id: 'auxiliary', kind: 'auxiliary' as const, name: 'Background sessions', sessionIds: auxiliarySessions.map((session) => session.id), group: null }] : []),
  ]
  const shortcutSessionIds = containers
    .filter((container) => container.kind !== 'auxiliary')
    .flatMap((container) => container.sessionIds)
    .filter((sessionId) => sessionMap.has(sessionId) && sessionId !== commanderSessionId)

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

  const renameSession = async (sessionId: string, onError: (message: string) => void = setError) => {
    const session = sessionMap.get(sessionId)
    const name = window.prompt('Rename tmux session', session?.name ?? '')?.trim()
    if (!name || name === session?.name) return
    try { await api.renameSession(sessionId, name); props.onSessionsChanged() }
    catch (cause) { onError(cause instanceof Error ? cause.message : 'Unable to rename session') }
  }

  const changeIdentity = async (sessionId: string, reset = false, onError: (message: string) => void = setError) => {
    const session = sessionMap.get(sessionId)
    if (!session) return
    const glyph = reset ? null : window.prompt('Choose one emoji for this session', sessionIdentityForName(preferencesRef.current.sessionIdentities ?? {}, session.name).glyph)
    if (!reset && glyph === null) return
    if (!reset && !isSessionGlyph(glyph)) { onError('Glyph must be a single emoji'); return }
    try {
      const next = await api.changeIdentity(sessionId, glyph)
      preferenceSaveVersion.current += 1
      preferencesRef.current = next
      setPreferences(next)
      props.onPreferencesChanged(next)
    } catch (cause) { onError(cause instanceof Error ? cause.message : 'Unable to update session identity') }
  }

  const deleteSession = async (sessionId: string, deleteWorktree = false, confirmation?: string | null, onError: (message: string) => void = setError) => {
    const session = sessionMap.get(sessionId)
    const label = session?.name ?? sessionId
    let auxiliary: { id: string; name: string }[] = []
    if (deleteWorktree) {
      try { auxiliary = (await api.previewWorktreeDeletion(sessionId)).auxiliarySessions }
      catch (cause) { onError(cause instanceof Error ? cause.message : 'Unable to inspect sessions using this worktree'); return }
    }
    const prompt = deleteWorktree
      ? `${confirmation ? `${confirmation}\n\n` : ''}Delete tmux session “${label}” and its linked worktree?${auxiliary.length ? `\n\nThe following background sessions using this worktree will also be closed:\n${auxiliary.map(({ name }) => `• ${name}`).join('\n')}` : ''}\n\nUncommitted changes in the worktree will be permanently deleted. The git branch will be kept.`
      : confirmation === undefined ? `Delete tmux session “${label}” and all of its windows and panes?` : confirmation
    if (prompt !== null && !window.confirm(prompt)) return
    try { await api.deleteSession(sessionId, deleteWorktree, auxiliary.map(({ id }) => id)); props.onSessionsChanged() }
    catch (cause) { onError(cause instanceof Error ? cause.message : 'Unable to delete session') }
  }

  const archiveSession = async (sessionId: string, confirmation?: string | null, onError: (message: string) => void = setError) => {
    const label = sessionMap.get(sessionId)?.name ?? sessionId
    const prompt = confirmation === undefined ? `Archive tmux session “${label}”? Its running processes will stop. ${ARCHIVE_RESTORE_NOTE}` : confirmation
    if (prompt !== null && !window.confirm(prompt)) return
    try {
      await api.archiveSession(sessionId)
      setArchives(await api.listArchives())
      setArchivesExpanded(true)
      props.onSessionsChanged()
    } catch (cause) { onError(cause instanceof Error ? cause.message : 'Unable to archive session') }
  }

  useImperativeHandle(props.actionsRef, () => ({ renameSession, changeIdentity, archiveSession, deleteSession }))

  const restoreSession = async (archive: SessionArchiveSummary) => {
    try {
      await api.restoreSession(archive.id)
      setArchives(await api.listArchives())
      props.onSessionsChanged()
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Unable to restore session') }
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
        <span title={auxiliarySessions.length ? `${auxiliarySessions.length} background sessions are listed separately` : undefined}>{props.sessions.length - auxiliarySessions.length} sessions{auxiliarySessions.length ? ` · ${auxiliarySessions.length} bg` : ''}</span>
        <span className="session-tree-tools-actions">
          {!commanderSessionId ? <button type="button" disabled={props.commanderOpening || !props.onCreateCommander || props.connected === false}
            onClick={() => { void props.onCreateCommander?.().catch((cause: unknown) => setError(cause instanceof Error ? cause.message : 'Unable to open Commander')) }}>
            <Bot />{props.commanderOpening ? 'Opening…' : 'Commander'}
          </button> : null}
          {manual ? <button type="button" onClick={createGroup}><FolderPlus /> Group</button> : null}
          <span className="session-grouping-switch" role="group" aria-label="Group sessions by">
            <button type="button" aria-pressed={!manual} aria-label="Group sessions by repository" title="Group sessions by repository" onClick={() => setGroupingMode('repository')}><FolderGit2 />Repo</button>
            <button type="button" aria-pressed={manual} aria-label="Group sessions manually" title="Group sessions manually" onClick={() => setGroupingMode('manual')}><ListTree />Manual</button>
          </span>
        </span>
      </div>
      {error ? <button type="button" className="session-tree-error" onClick={() => setError('')}>{error}</button> : null}
      {commanderSessionId ? <button type="button"
        className={`session-commander-row${props.selectedSessionId === commanderSessionId ? ' selected' : ''}`}
        aria-label="Commander" aria-current={props.selectedSessionId === commanderSessionId ? 'page' : undefined}
        onClick={() => props.onSelectSession(commanderSessionId)}>
        <Bot aria-hidden="true" /><span className="session-commander-label">Commander</span>
        {props.commanderNeedsYou ? <span className="session-commander-count" aria-label={`${props.commanderNeedsYou} agents need you`}>{props.commanderNeedsYou}</span> : null}
        {props.commanderUnreadFinished ? <span className="session-commander-unread" aria-label="Unread finished turns" /> : null}
      </button> : null}
      {containers.map((container) => {
        const groupIndex = container.group ? preferences.groups.findIndex((group) => group.id === container.id) : -1
        const collapsed = collapsedContainerIds.has(container.id)
        const groupBodyId = `session-group-${container.id.replace(/[^A-Za-z0-9_-]/gu, '_')}`
        const sessionCount = container.sessionIds.filter((id) => sessionMap.has(id)).length
        const droppable = container.kind !== 'auxiliary' && Boolean(draggedSessionId && (manual || container.sessionIds.includes(draggedSessionId)))
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
              title={container.repo?.root}
            >
              {collapsed ? <ChevronRight /> : <ChevronDown />}
              <strong>{container.name}</strong>
              <small>{sessionCount}</small>
            </button>
            {props.creation && container.kind !== 'no-repo' && container.kind !== 'auxiliary' ? <button type="button" onClick={(event) => createSessionInContainer(container, event.currentTarget)} aria-label={`Create a new session in ${container.name}`} title={`Create a new session in ${container.name}`}><Plus /></button> : null}
            {container.group ? <><button type="button" onClick={() => moveGroup(container.id, -1)} disabled={groupIndex === 0} aria-label={`Move ${container.name} up`}><ArrowUp /></button><button type="button" onClick={() => moveGroup(container.id, 1)} disabled={groupIndex === preferences.groups.length - 1} aria-label={`Move ${container.name} down`}><ArrowDown /></button><button type="button" onClick={() => { const name = window.prompt('Rename group', container.name)?.trim(); if (name) save({ ...preferences, groups: preferences.groups.map((group) => group.id === container.id ? { ...group, name } : group) }) }} aria-label={`Rename ${container.name}`}><Pencil /></button><button type="button" onClick={() => save({ ...preferences, groups: preferences.groups.filter((group) => group.id !== container.id), ungroupedSessionIds: [...preferences.ungroupedSessionIds, ...container.sessionIds] })} aria-label={`Delete ${container.name}`}><Trash2 /></button></> : null}
          </header>
          <div id={groupBodyId} hidden={collapsed}>
            {container.sessionIds.flatMap((sessionId) => {
              const session = sessionMap.get(sessionId)
              if (!session) return []
              const selected = session.id === props.selectedSessionId
              const ide = props.ides?.find((item) => item.sessionIds.includes(session.id))
              const identity = sessionIdentityForName(preferences.sessionIdentities ?? {}, session.name)
              const branch = container.sessionBranches?.[session.id]
              const sessionPanes = props.panes
                .filter((pane) => pane.sessionId === session.id)
                .sort((left, right) => (displayedPaneOrder.get(left.id) ?? Number.MAX_SAFE_INTEGER) - (displayedPaneOrder.get(right.id) ?? Number.MAX_SAFE_INTEGER))
              const indicator = sessionIndicator(sessionPanes, props.statuses, marks, seen)
              const indicatorLabel = sessionPanes.flatMap((pane) => {
                const status = props.statuses[pane.id]
                const mark = marks[pane.targetId]
                return [...(status ? [statusLabel(status, seen[pane.id], pane)] : []), ...(mark ? [markLabel(mark, pane)] : [])]
              }).join('; ')
              const simulatorPane = sessionPanes.find((pane) => props.simulators?.[pane.id])
              const simulator = simulatorPane && props.simulators?.[simulatorPane.id]
              return [<article
                className={`managed-session${selected ? ' selected' : ''}${draggedSessionId === session.id ? ' dragging' : ''}`}
                draggable={container.kind !== 'auxiliary'}
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
                  {indicator ? <button
                    type="button"
                    className={`session-indicator ${indicator.kind === 'status' ? indicator.status : `mark tone-${indicator.mark.tone}${indicator.mark.activityCount ? ' has-activity' : ''}`}`}
                    onClick={() => props.onSelectPane(indicator.paneId)}
                    aria-label={indicatorLabel}
                    title={indicatorLabel}
                  /> : <span className="session-indicator" aria-hidden="true" />}
                  <button type="button" className="managed-session-main" onClick={() => props.onSelectSession(session.id)} onContextMenu={(event) => { event.preventDefault(); openMenu(session.id, event.clientX, event.clientY) }} onKeyDown={(event) => menuKey(event, session.id)} aria-current={selected || undefined} title={[`${session.name} — ${identity.codename}`, branch, `${plural(session.windowIds.length, 'window')} / ${plural(sessionPanes.length, 'pane')}`].filter(Boolean).join(' · ')}><SessionAvatar identity={identity} /><span className="session-identity-name">{session.name}</span></button>
                  <span className="session-row-meta">
                    {props.prsApi ? <SessionPrCount paneIds={sessionPanes.map((pane) => pane.id)} api={props.prsApi} previewApi={props.prsApi} enabled={props.connected ?? true} sessionName={session.name} liveTargetIds={liveTargetIds} onJumpToTarget={jumpToTarget} /> : null}
                    {ide ? <button type="button" className={`session-ide-glyph state-${ide.state}`} aria-pressed={props.ideSessionId === session.id} aria-label={`Open attached IDE for ${session.name}`} title={`${ide.state === 'ready' ? 'IDE attached' : ide.state === 'starting' ? 'IDE starting' : 'IDE failed'} · ${ide.workspacePath}`} onClick={() => props.onOpenIde?.(session.id)}><Code2 /></button> : null}
                    {Object.values(props.agentChatRequests ?? {}).filter((request) => sessionPanes.some((pane) => pane.id === request.callerPaneId && pane.targetId === request.callerTargetId)).map((request) => <AgentChatRequestBadge key={request.id} request={request} onSelect={props.onSelectPane} />)}
                    {sessionPanes[0] ? <OpenedByMarker pane={sessionPanes[0]} snapshot={lineageSnapshot} statuses={props.statuses} onSelect={props.onSelectPane} /> : null}
                    {simulator && simulatorPane ? <button type="button" className={`session-sim-glyph${simulator.idle ? ' idle' : ''}`} aria-label={`Show leased simulator for ${session.name}`} title={`Simulator · ${simulator.label}${simulator.task ? ` · ${simulator.task}` : ''}`} onClick={() => props.onShowSimulator?.(simulator.udid, simulatorPane.id)}><Smartphone /></button> : null}
                  </span>
                  <span className="session-row-actions"><button type="button" onClick={(event) => { const bounds = event.currentTarget.getBoundingClientRect(); openMenu(session.id, bounds.left, bounds.bottom) }} aria-label={`Actions for ${session.name}`}><MoreHorizontal /></button></span>
                </div>
              </article>]
            })}
            {manual && !container.sessionIds.some((id) => sessionMap.has(id)) ? <p className="session-pref-empty">Drop a session here.</p> : null}
          </div>
        </section>
        )
      })}
      {archives.length ? <section className="session-pref-group session-archives">
        <header><button type="button" className="session-pref-toggle" aria-expanded={archivesExpanded} onClick={() => setArchivesExpanded((open) => !open)}>
          {archivesExpanded ? <ChevronDown /> : <ChevronRight />}<Archive /><strong>Archived</strong><small>{archives.length}</small>
        </button></header>
        {archivesExpanded ? <div>{archives.map((archive) => <div className="session-archive-row" key={archive.id}>
          <span title={new Date(archive.createdAt).toLocaleString()}><strong>{archive.name}</strong><small>{archive.windowCount} windows / {archive.paneCount} panes</small></span>
          <button type="button" onClick={() => void restoreSession(archive)} aria-label={`Restore ${archive.name}`} title="Restore session as fresh shells"><RotateCcw /> Restore</button>
        </div>)}</div> : null}
      </section> : null}
      {props.creation ? <TmuxCreateControls
        token={props.token}
        disabled={props.creation.disabled}
        onCreateSession={props.creation.onCreateSession}
        probeRepo={props.creation.probeRepo}
        loadClaudeProfiles={props.creation.loadClaudeProfiles}
        onCreated={(created, sessionGroupId, worktree) => finishCreated(created, sessionGroupId, worktree)}
      /> : null}
      {props.creation && sessionCreateRequest ? <SessionCreateDialog
        request={sessionCreateRequest}
        token={props.token}
        disabled={props.creation.disabled}
        onCreateSession={props.creation.onCreateSession}
        probeRepo={props.creation.probeRepo}
        loadClaudeProfiles={props.creation.loadClaudeProfiles}
        onCreated={(created, sessionGroupId, worktree) => { finishCreated(created, sessionGroupId, worktree); closeSessionDialog() }}
        onClose={closeSessionDialog}
      /> : null}
      {menu ? <div className="session-context-menu" data-native-terminal-occluder="" style={{ left: menu.x, top: menu.y }} role="menu" onPointerDown={(event) => event.stopPropagation()}>{props.onOpenIde ? <button type="button" role="menuitem" onClick={() => { props.onOpenIde?.(menu.sessionId); setMenu(null) }}><Code2 /> Open IDE</button> : null}<button type="button" role="menuitem" onClick={() => { void changeIdentity(menu.sessionId); setMenu(null) }}><Pencil /> Change glyph…</button><button type="button" role="menuitem" onClick={() => { void changeIdentity(menu.sessionId, true); setMenu(null) }}><RotateCcw /> Reset identity</button><button type="button" role="menuitem" onClick={() => { void renameSession(menu.sessionId); setMenu(null) }}><Pencil /> Rename</button>{props.onResumeChat ? <button type="button" role="menuitem" disabled={!props.connected} onClick={() => { props.onResumeChat?.(menu.sessionId); setMenu(null) }}><RotateCcw /> Resume a chat…</button> : null}{!auxiliaryIds.has(menu.sessionId) ? <button type="button" role="menuitem" onClick={() => { void archiveSession(menu.sessionId); setMenu(null) }}><Archive /> Archive session</button> : null}<button type="button" className="danger" role="menuitem" onClick={() => { void deleteSession(menu.sessionId); setMenu(null) }}><Trash2 /> Delete session</button>{!auxiliaryIds.has(menu.sessionId) && props.panes.some((pane) => pane.sessionId === menu.sessionId && pane.repo?.isWorktree) ? <button type="button" className="danger" role="menuitem" onClick={() => { void deleteSession(menu.sessionId, true); setMenu(null) }}><FolderX /> Delete session and worktree</button> : null}</div> : null}
    </div>
  )
}
