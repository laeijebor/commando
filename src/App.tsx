import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Bot,
  ChevronRight,
  CircleDotDashed,
  Clock3,
  Command,
  Grid2X2,
  GripVertical,
  KeyRound,
  LayoutGrid,
  LoaderCircle,
  LockKeyhole,
  Maximize2,
  Minimize2,
  NotebookPen,
  PanelLeft,
  PanelRightOpen,
  PanelTop,
  PanelsTopLeft,
  PlugZap,
  RefreshCw,
  Rows3,
  Search,
  Server,
  ShieldCheck,
  SidebarOpen,
  Terminal,
  WifiOff,
  X,
} from 'lucide-react'
import {
  type CSSProperties,
  type DragEvent,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react'

import type {
  AgentProvider,
  AgentStatus,
  CommandoSnapshot,
  GroupLayoutPreset,
  SavedGroup,
  SavedWorkspace,
  ServerMessage,
  SpecialKey,
  TmuxPane,
} from '../shared/protocol'
import {
  defaultGroupsForSession,
  getPanePlacement,
  moveItem,
  reconcileGroupsForSession,
} from './layout'
import { decodeBase64Bytes, PaneStreamRegistry, type PaneTerminalSink } from './paneStream'
import { dispatchBoundedPaste } from './terminalInput'
import { type ConnectionPhase, useDaemon } from './useDaemon'
import { XtermPane } from './XtermPane'
import { LinearSection } from './LinearSection'
import { NotesSection } from './NotesSection'
import { SessionTree } from './SessionTree'
import { TmuxCreateControls } from './TmuxCreateControls'
import { createTmuxHttpApi } from './tmuxCreateApi'

const TOKEN_STORAGE_KEY = 'commando.session-token'

const PRESETS: Array<{
  id: GroupLayoutPreset
  label: string
  icon: ReactNode
}> = [
  { id: 'equal-grid', label: 'Equal grid', icon: <Grid2X2 /> },
  { id: 'full-then-halves', label: 'Full first, then halves', icon: <PanelTop /> },
  { id: 'two-full-two-halves', label: 'Two full, two halves', icon: <Rows3 /> },
  { id: 'lead-and-stack', label: 'Lead and stack', icon: <PanelLeft /> },
]

const STATUS_PRIORITY: Record<AgentStatus['status'], number> = {
  needs_input: 0,
  failed: 1,
  working: 2,
  stale: 3,
  done: 4,
  unknown: 5,
}

let requestSequence = 0

function requestId(prefix: string) {
  requestSequence += 1
  return `${prefix}-${Date.now()}-${requestSequence}`
}

function getInitialToken() {
  const hash = window.location.hash.slice(1)
  const hashParams = new URLSearchParams(hash)
  let token = hashParams.get('token') ?? ''

  if (!token && hash && !hash.includes('=')) {
    try {
      token = decodeURIComponent(hash)
    } catch {
      token = hash
    }
  }

  try {
    if (token) {
      window.sessionStorage.setItem(TOKEN_STORAGE_KEY, token)
      window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`)
      return token
    }
    return window.sessionStorage.getItem(TOKEN_STORAGE_KEY) ?? ''
  } catch {
    return token
  }
}

function storeToken(token: string) {
  try {
    window.sessionStorage.setItem(TOKEN_STORAGE_KEY, token)
  } catch {
    // A private browser session may block storage; the in-memory token still works.
  }
}

function connectionLabel(phase: ConnectionPhase) {
  switch (phase) {
    case 'live':
      return 'Live'
    case 'reconnecting':
      return 'Reconnecting'
    case 'loading-snapshot':
      return 'Hydrating'
    case 'connecting':
      return 'Connecting'
    case 'unauthorized':
      return 'Token rejected'
    case 'missing-token':
      return 'Token required'
  }
}

function providerInitials(provider: AgentProvider) {
  switch (provider) {
    case 'claude':
      return 'CL'
    case 'codex':
      return 'CX'
    case 'opencode':
      return 'OC'
    case 'unknown':
      return 'AG'
  }
}

function displayTime(timestamp: number) {
  if (!timestamp) return 'unknown time'
  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(timestamp)
}

type TerminalPaneProps = {
  pane: TmuxPane
  status?: AgentStatus
  index: number
  count: number
  preset: GroupLayoutPreset
  maximized: boolean
  focused: boolean
  connected: boolean
  onFocus: () => void
  onMove: (direction: -1 | 1) => void
  onMaximize: () => void
  onDragStart: (event: DragEvent<HTMLElement>) => void
  onDragEnd: () => void
  onDragOver: (event: DragEvent<HTMLElement>) => void
  onDrop: (event: DragEvent<HTMLElement>) => void
  onInput: (data: string) => void
  onKey: (key: SpecialKey) => void
  onPaste: (data: string) => void
  registerSink: (paneId: string, sink: PaneTerminalSink) => () => void
  registerFocusable: (paneId: string, node: HTMLElement | null) => void
}

function TerminalPaneCard({
  pane,
  status,
  index,
  count,
  preset,
  maximized,
  focused,
  connected,
  onFocus,
  onMove,
  onMaximize,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDrop,
  onInput,
  onKey,
  onPaste,
  registerSink,
  registerFocusable,
}: TerminalPaneProps) {
  const placement = getPanePlacement(preset, index, count)
  const style: CSSProperties = maximized
    ? { gridColumn: '1 / -1', gridRow: 'auto' }
    : {
        gridColumn: `span ${placement.columnSpan}`,
        gridRow: `span ${placement.rowSpan}`,
      }

  return (
    <article
      className={`terminal-pane${focused ? ' is-focused' : ''}${maximized ? ' is-maximized' : ''}${count === 1 ? ' is-solo' : ''}`}
      style={style}
      onDragOver={onDragOver}
      onDrop={onDrop}
      data-pane-id={pane.id}
    >
      <header
        className="pane-head"
        draggable
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        title="Drag to reorder this pane"
      >
        <span className={`pane-icon provider-${status?.provider ?? 'unknown'}`}>
          {status ? <Bot aria-hidden="true" /> : <Terminal aria-hidden="true" />}
        </span>
        <span className="pane-heading">
          <strong>{pane.title || pane.command || `Pane ${pane.index}`}</strong>
          <small>{pane.command || pane.path}</small>
        </span>
        {pane.dead ? <span className="pane-state dead">Dead</span> : null}
        {status ? <span className={`pane-state ${status.status}`}>{status.status.replace('_', ' ')}</span> : null}
        <span className="pane-index">{pane.index}</span>
        <span className="pane-actions">
          <button
            type="button"
            className="icon-button compact"
            onClick={() => onMove(-1)}
            disabled={index === 0}
            aria-label={`Move ${pane.title || `pane ${pane.index}`} left`}
            title="Move left"
          >
            <ArrowLeft aria-hidden="true" />
          </button>
          <button
            type="button"
            className="icon-button compact"
            onClick={() => onMove(1)}
            disabled={index === count - 1}
            aria-label={`Move ${pane.title || `pane ${pane.index}`} right`}
            title="Move right"
          >
            <ArrowRight aria-hidden="true" />
          </button>
          <button
            type="button"
            className="icon-button compact"
            onClick={onMaximize}
            aria-label={maximized ? 'Restore pane' : 'Maximize pane'}
            title={maximized ? 'Restore pane' : 'Maximize pane'}
          >
            {maximized ? <Minimize2 aria-hidden="true" /> : <Maximize2 aria-hidden="true" />}
          </button>
        </span>
      </header>
      <XtermPane
        paneId={pane.id}
        cols={pane.width}
        rows={pane.height}
        terminalState={pane}
        connected={connected}
        ariaLabel={`${pane.title || `Pane ${pane.index}`} terminal input${connected ? '' : ', disconnected'}`}
        onFocus={onFocus}
        onInput={onInput}
        onKey={onKey}
        onPaste={onPaste}
        registerSink={registerSink}
        registerFocusable={registerFocusable}
      />
      <footer className="pane-footer">
        <span className={`input-indicator${connected ? ' live' : ''}`} />
        <span>{connected ? 'Input armed' : 'Read only while offline'}</span>
        <span>{pane.width}x{pane.height}</span>
        <span className="pane-path" title={pane.path}>{pane.path}</span>
      </footer>
    </article>
  )
}

type PaletteCommand = {
  id: string
  label: string
  detail: string
  kind: 'pane' | 'session' | 'action' | 'layout'
  run: () => void
}

type CommandoArea = 'workspace' | 'linear' | 'notes'

function PaletteGlyph({ kind }: { kind: PaletteCommand['kind'] }) {
  if (kind === 'pane') return <Terminal aria-hidden="true" />
  if (kind === 'session') return <Server aria-hidden="true" />
  if (kind === 'layout') return <LayoutGrid aria-hidden="true" />
  return <RefreshCw aria-hidden="true" />
}

export function App() {
  const [token, setToken] = useState(getInitialToken)
  const [tokenDraft, setTokenDraft] = useState('')
  const [snapshot, setSnapshot] = useState<CommandoSnapshot | null>(null)
  const [agentStatuses, setAgentStatuses] = useState<Record<string, AgentStatus>>({})
  const [workspaces, setWorkspaces] = useState<Record<string, SavedWorkspace>>({})
  const [dirtySessionIds, setDirtySessionIds] = useState<string[]>([])
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null)
  const [focusedPaneId, setFocusedPaneId] = useState<string | null>(null)
  const [maximizedPaneId, setMaximizedPaneId] = useState<string | null>(null)
  const [draggedPane, setDraggedPane] = useState<{ groupId: string; paneId: string } | null>(null)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [paletteQuery, setPaletteQuery] = useState('')
  const [paletteIndex, setPaletteIndex] = useState(0)
  const [leftPanelOpen, setLeftPanelOpen] = useState(false)
  const [rightPanelOpen, setRightPanelOpen] = useState(false)
  const [pendingFocusPaneId, setPendingFocusPaneId] = useState<string | null>(null)
  const [area, setArea] = useState<CommandoArea>('workspace')
  const paneRefs = useRef(new Map<string, HTMLElement>())
  const paneStreamsRef = useRef<PaneStreamRegistry | null>(null)
  if (!paneStreamsRef.current) paneStreamsRef.current = new PaneStreamRegistry()
  const paletteInputRef = useRef<HTMLInputElement>(null)
  const pendingSaveSessions = useRef(new Set<string>())
  const saveRequestSessions = useRef(new Map<string, string>())

  const handleServerMessage = (message: ServerMessage) => {
    switch (message.type) {
      case 'snapshot':
        setSnapshot(message.snapshot)
        break
      case 'pane_reset':
        try {
          paneStreamsRef.current?.pushReset(message.paneId, {
            data: decodeBase64Bytes(message.data),
            cols: message.cols,
            rows: message.rows,
            terminalState: message.terminalState,
            revision: message.revision,
          })
        } catch {
          console.error(`[commando:pane-reset] Ignored invalid base64 for ${message.paneId}`)
        }
        break
      case 'pane_data':
        try {
          paneStreamsRef.current?.pushData(
            message.paneId,
            decodeBase64Bytes(message.data),
            message.revision,
          )
        } catch {
          console.error(`[commando:pane-data] Ignored invalid base64 for ${message.paneId}`)
        }
        break
      case 'agent_status':
        setAgentStatuses((current) => {
          if (message.status.provider === 'unknown' && message.status.status === 'unknown') {
            if (!(message.status.paneId in current)) return current
            const next = { ...current }
            delete next[message.status.paneId]
            return next
          }
          return {
            ...current,
            [message.status.paneId]: message.status,
          }
        })
        break
      case 'workspace':
        if (
          message.reason === 'load' &&
          (dirtySessionIds.includes(message.sessionId) ||
            pendingSaveSessions.current.has(message.sessionId))
        ) {
          break
        }
        if (message.workspace) {
          setWorkspaces((current) => ({
            ...current,
            [message.sessionId]: message.workspace!,
          }))
        } else {
          setWorkspaces((current) => {
            const next = { ...current }
            delete next[message.sessionId]
            return next
          })
        }
        if (message.reason === 'save') {
          pendingSaveSessions.current.delete(message.sessionId)
          saveRequestSessions.current.delete(message.requestId)
          setDirtySessionIds((current) =>
            current.filter((sessionId) => sessionId !== message.sessionId),
          )
        }
        break
      case 'error':
        console.error(`[commando:${message.code}] ${message.message}`)
        if (message.requestId) {
          const sessionId = saveRequestSessions.current.get(message.requestId)
          if (sessionId) {
            pendingSaveSessions.current.delete(sessionId)
            saveRequestSessions.current.delete(message.requestId)
          }
        }
        break
    }
  }

  const { connection, send } = useDaemon(token, handleServerMessage)
  const connected = connection.phase === 'live'

  const registerTerminalSink = useCallback((paneId: string, sink: PaneTerminalSink) => (
    paneStreamsRef.current!.register(paneId, sink)
  ), [])

  const registerFocusable = useCallback((paneId: string, node: HTMLElement | null) => {
    if (node) paneRefs.current.set(paneId, node)
    else paneRefs.current.delete(paneId)
  }, [])

  useEffect(() => {
    if (!snapshot) return
    setSelectedSessionId((current) => {
      if (current && snapshot.sessions.some((session) => session.id === current)) return current
      return snapshot.sessions.find((session) => session.attached)?.id ?? snapshot.sessions[0]?.id ?? null
    })
  }, [snapshot])

  const selectedSession = snapshot?.sessions.find((session) => session.id === selectedSessionId)
  const selectedWorkspace = selectedSessionId ? workspaces[selectedSessionId] : undefined
  const groups = snapshot && selectedSessionId
    ? selectedWorkspace
      ? reconcileGroupsForSession(snapshot, selectedSessionId, selectedWorkspace.groups)
      : defaultGroupsForSession(snapshot, selectedSessionId)
    : []
  const paneMap = new Map(snapshot?.panes.map((pane) => [pane.id, pane]) ?? [])
  const windowMap = new Map(snapshot?.windows.map((window) => [window.id, window]) ?? [])
  const sessionMap = new Map(snapshot?.sessions.map((session) => [session.id, session]) ?? [])
  const allVisiblePaneIds = groups.flatMap((group) =>
    group.paneIds.filter((paneId) => paneMap.has(paneId)),
  )
  const subscribedPaneIds = area === 'workspace'
    ? maximizedPaneId ? [maximizedPaneId] : allVisiblePaneIds
    : []
  const subscriptionKey = subscribedPaneIds.join('\u0000')

  useEffect(() => {
    if (!connected || !selectedSessionId) return
    send({
      type: 'load_workspace',
      sessionId: selectedSessionId,
      requestId: requestId('load'),
    })
  }, [connected, selectedSessionId, send])

  useEffect(() => {
    if (!connected) return
    send({ type: 'subscribe', paneIds: subscriptionKey ? subscriptionKey.split('\u0000') : [] })
  }, [connected, send, subscriptionKey])

  const dirtyKey = dirtySessionIds.join('\u0000')
  useEffect(() => {
    if (!connected || !dirtyKey) return
    const pendingIds = dirtyKey.split('\u0000')
    for (const sessionId of pendingIds) {
      if (pendingSaveSessions.current.has(sessionId)) continue
      const workspace = workspaces[sessionId]
      if (!workspace) continue
      const saveRequestId = requestId('save')
      if (send({ type: 'save_workspace', workspace, requestId: saveRequestId })) {
        pendingSaveSessions.current.add(sessionId)
        saveRequestSessions.current.set(saveRequestId, sessionId)
      }
    }
  }, [connected, dirtyKey, send, workspaces])

  useEffect(() => {
    if (connected) return
    pendingSaveSessions.current.clear()
    saveRequestSessions.current.clear()
  }, [connected])

  useEffect(() => {
    if (connection.phase !== 'live') {
      paneStreamsRef.current?.clear()
      return
    }
    setAgentStatuses({})
  }, [connection.phase])

  useEffect(() => {
    setMaximizedPaneId(null)
    setFocusedPaneId(null)
  }, [selectedSessionId])

  useEffect(() => {
    if (maximizedPaneId && !snapshot?.panes.some((pane) => pane.id === maximizedPaneId)) {
      setMaximizedPaneId(null)
    }
  }, [maximizedPaneId, snapshot])

  useEffect(() => {
    if (!pendingFocusPaneId) return
    const node = paneRefs.current.get(pendingFocusPaneId)
    if (!node) return
    node.scrollIntoView({ behavior: 'smooth', block: 'center' })
    node.focus({ preventScroll: true })
    setFocusedPaneId(pendingFocusPaneId)
    setPendingFocusPaneId(null)
  })

  useEffect(() => {
    const handleGlobalKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.metaKey && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setPaletteOpen((current) => !current)
      } else if (event.key === 'Escape' && paletteOpen) {
        setPaletteOpen(false)
      }
    }
    window.addEventListener('keydown', handleGlobalKeyDown)
    return () => window.removeEventListener('keydown', handleGlobalKeyDown)
  }, [paletteOpen])

  useEffect(() => {
    if (paletteOpen) {
      setPaletteQuery('')
      setPaletteIndex(0)
      window.setTimeout(() => paletteInputRef.current?.focus(), 0)
    }
  }, [paletteOpen])

  const selectSession = (sessionId: string) => {
    setArea('workspace')
    setSelectedSessionId(sessionId)
    setLeftPanelOpen(false)
  }

  const jumpToPane = (paneId: string) => {
    const pane = paneMap.get(paneId)
    if (!pane) return
    setSelectedSessionId(pane.sessionId)
    setPendingFocusPaneId(paneId)
    setPaletteOpen(false)
    setLeftPanelOpen(false)
    setRightPanelOpen(false)
  }

  const jumpToGroup = (windowId: string) => {
    const group = groups.find((candidate) => candidate.windowId === windowId)
    if (!group) return
    document.querySelector(`[data-group-id="${CSS.escape(group.id)}"]`)?.scrollIntoView({
      behavior: 'smooth',
      block: 'start',
    })
    setLeftPanelOpen(false)
  }

  const persistGroups = (nextGroups: SavedGroup[]) => {
    if (!selectedSessionId) return
    const workspace: SavedWorkspace = {
      sessionId: selectedSessionId,
      groups: nextGroups,
      updatedAt: Date.now(),
    }
    setWorkspaces((current) => ({ ...current, [selectedSessionId]: workspace }))
    setDirtySessionIds((current) =>
      current.includes(selectedSessionId) ? current : [...current, selectedSessionId],
    )
  }

  const updateGroup = (groupId: string, update: (group: SavedGroup) => SavedGroup) => {
    persistGroups(groups.map((group) => (group.id === groupId ? update(group) : group)))
  }

  const movePane = (groupId: string, paneId: string, direction: -1 | 1) => {
    updateGroup(groupId, (group) => {
      const currentIndex = group.paneIds.indexOf(paneId)
      return { ...group, paneIds: moveItem(group.paneIds, currentIndex, currentIndex + direction) }
    })
  }

  const dropPane = (groupId: string, targetPaneId: string) => {
    if (!draggedPane || draggedPane.groupId !== groupId || draggedPane.paneId === targetPaneId) return
    updateGroup(groupId, (group) => ({
      ...group,
      paneIds: moveItem(
        group.paneIds,
        group.paneIds.indexOf(draggedPane.paneId),
        group.paneIds.indexOf(targetPaneId),
      ),
    }))
    setDraggedPane(null)
  }

  const sendPaneInput = (paneId: string, data: string) => {
    if (!connected) return
    const characters = [...data]
    for (let index = 0; index < characters.length; index += 1_024) {
      send({
        type: 'input',
        paneId,
        data: characters.slice(index, index + 1_024).join(''),
        requestId: requestId('input'),
      })
    }
  }

  const sendPaneKey = (paneId: string, key: SpecialKey) => {
    if (!connected) return
    send({ type: 'key', paneId, key, requestId: requestId('key') })
  }

  const sendPanePaste = (paneId: string, data: string) => {
    if (!connected) return
    const result = dispatchBoundedPaste(data, (paste) => {
      send({ type: 'paste', paneId, data: paste, requestId: requestId('paste') })
    })
    if (result === 'too-large') {
      console.error('[commando:paste] Paste exceeds the 256 KiB limit')
    } else if (result === 'invalid') {
      console.error('[commando:paste] Paste contains a null byte')
    }
  }

  const refresh = () => {
    send({ type: 'refresh', requestId: requestId('refresh') })
    setPaletteOpen(false)
  }
  const tmuxCreateApi = createTmuxHttpApi(token)

  const commands: PaletteCommand[] = [
    {
      id: 'refresh',
      label: 'Refresh daemon snapshot',
      detail: connected ? 'Request current tmux state' : 'Unavailable while disconnected',
      kind: 'action',
      run: refresh,
    },
    ...(snapshot?.sessions.map((session) => ({
      id: `session:${session.id}`,
      label: `Open session: ${session.name}`,
      detail: `${session.windowIds.length} windows${session.attached ? ' / attached' : ''}`,
      kind: 'session' as const,
      run: () => {
        selectSession(session.id)
        setPaletteOpen(false)
      },
    })) ?? []),
    ...(snapshot?.panes.map((pane) => {
      const session = sessionMap.get(pane.sessionId)
      const window = windowMap.get(pane.windowId)
      return {
        id: `pane:${pane.id}`,
        label: pane.title || pane.command || `Pane ${pane.index}`,
        detail: `${session?.name ?? pane.sessionId} / ${window?.name ?? pane.windowId} / pane ${pane.index}`,
        kind: 'pane' as const,
        run: () => jumpToPane(pane.id),
      }
    }) ?? []),
    ...PRESETS.map((preset) => ({
      id: `layout:${preset.id}`,
      label: `Apply ${preset.label.toLowerCase()} to visible groups`,
      detail: 'Save as the app-owned workspace layout',
      kind: 'layout' as const,
      run: () => {
        persistGroups(groups.map((group) => ({ ...group, layout: preset.id })))
        setPaletteOpen(false)
      },
    })),
  ]
  const normalizedQuery = paletteQuery.trim().toLowerCase()
  const filteredCommands = commands.filter((command) =>
    `${command.label} ${command.detail}`.toLowerCase().includes(normalizedQuery),
  )
  const safePaletteIndex = Math.min(paletteIndex, Math.max(filteredCommands.length - 1, 0))

  const handlePaletteKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setPaletteIndex((current) => Math.min(current + 1, filteredCommands.length - 1))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setPaletteIndex((current) => Math.max(current - 1, 0))
    } else if (event.key === 'Enter') {
      event.preventDefault()
      filteredCommands[safePaletteIndex]?.run()
    } else if (event.key === 'Escape') {
      event.preventDefault()
      setPaletteOpen(false)
    }
  }

  const submitToken = (event: FormEvent) => {
    event.preventDefault()
    const nextToken = tokenDraft.trim()
    if (!nextToken) return
    storeToken(nextToken)
    setSnapshot(null)
    setToken(nextToken)
    setTokenDraft('')
  }

  const selectedPaneStatuses = Object.values(agentStatuses)
    .filter((status) => paneMap.get(status.paneId)?.sessionId === selectedSessionId)
    .sort((left, right) => STATUS_PRIORITY[left.status] - STATUS_PRIORITY[right.status])
  const attentionCount = selectedPaneStatuses.filter(
    (status) => status.status === 'needs_input' || status.status === 'failed',
  ).length
  const workingCount = selectedPaneStatuses.filter((status) => status.status === 'working').length
  const doneCount = selectedPaneStatuses.filter((status) => status.status === 'done').length
  const activeWindow = selectedSession?.activeWindowId
    ? windowMap.get(selectedSession.activeWindowId)
    : undefined

  if (!token || connection.phase === 'unauthorized') {
    return (
      <main className="auth-screen">
        <div className="auth-ambient" aria-hidden="true" />
        <section className="auth-card" aria-labelledby="auth-title">
          <div className="auth-mark"><Command aria-hidden="true" /></div>
          <span className="eyebrow">Local authority only</span>
          <h1 id="auth-title">
            {connection.phase === 'unauthorized' ? 'Replace the rejected token.' : 'Connect the Commando daemon.'}
          </h1>
          <p>
            Commando accepts the ephemeral token from <code>#token=...</code> and keeps it in this tab's
            session storage. It is sent as a bearer token for the snapshot and as the WebSocket query token.
          </p>
          <form onSubmit={submitToken}>
            <label htmlFor="daemon-token">Daemon session token</label>
            <div className="token-field">
              <KeyRound aria-hidden="true" />
              <input
                id="daemon-token"
                type="password"
                value={tokenDraft}
                onChange={(event) => setTokenDraft(event.target.value)}
                placeholder="Paste ephemeral token"
                autoComplete="off"
                autoFocus
              />
              <button type="submit" disabled={!tokenDraft.trim()}>Connect</button>
            </div>
          </form>
          <div className="auth-boundary">
            <ShieldCheck aria-hidden="true" />
            <span>Expected endpoint: this origin proxied to a daemon bound on 127.0.0.1.</span>
          </div>
        </section>
      </main>
    )
  }

  return (
    <div className={`cockpit${maximizedPaneId ? ' has-maximized-pane' : ''}`}>
      <header className="app-titlebar">
        <div className="brand-lockup">
          <span className="brand-mark"><Command aria-hidden="true" /></span>
          <span className="brand-copy">
            <strong>commando</strong>
            <small>local cockpit</small>
          </span>
        </div>
        <div className="location-readout">
          <span>commando://local</span>
          <strong>{selectedSession?.name ?? 'discovering-sessions'}</strong>
        </div>
        <div className="titlebar-actions">
          <div className={`connection-pill ${connection.phase}`} title={connection.detail}>
            {connection.phase === 'live' ? <Activity aria-hidden="true" /> : null}
            {connection.phase === 'reconnecting' ? <PlugZap aria-hidden="true" /> : null}
            {connection.phase === 'connecting' || connection.phase === 'loading-snapshot' ? (
              <LoaderCircle className="spin" aria-hidden="true" />
            ) : null}
            <span>{connectionLabel(connection.phase)}</span>
          </div>
          <button
            type="button"
            className="icon-button mobile-panel-toggle sidebar-toggle"
            onClick={() => setLeftPanelOpen(true)}
            aria-label="Open session tree"
          >
            <SidebarOpen aria-hidden="true" />
          </button>
          <button
            type="button"
            className="command-trigger"
            onClick={() => setPaletteOpen(true)}
            aria-label="Jump or command Cmd K"
          >
            <Search aria-hidden="true" />
            <span>Jump or command</span>
            <kbd>Cmd K</kbd>
          </button>
          <button
            type="button"
            className="icon-button mobile-panel-toggle hud-toggle"
            onClick={() => setRightPanelOpen(true)}
            aria-label="Open Agent HUD"
          >
            <PanelRightOpen aria-hidden="true" />
            {attentionCount ? <span className="attention-badge">{attentionCount}</span> : null}
          </button>
        </div>
      </header>

      {connection.phase === 'reconnecting' ? (
        <div className="connection-banner" role="status">
          <WifiOff aria-hidden="true" />
          <span>{connection.detail}. Pane snapshots remain visible; input resumes after reconnect.</span>
          <strong>Attempt {connection.attempt}</strong>
        </div>
      ) : null}

      <div className={`cockpit-body area-${area}`}>
        <button
          type="button"
          className={`drawer-scrim${leftPanelOpen || rightPanelOpen ? ' visible' : ''}`}
          onClick={() => {
            setLeftPanelOpen(false)
            setRightPanelOpen(false)
          }}
          aria-label="Close open panel"
        />

        <aside className={`session-sidebar${leftPanelOpen ? ' panel-open' : ''}`}>
          <div className="sidebar-header">
            <div>
              <span className="section-kicker">Machine</span>
              <strong>Local sessions</strong>
            </div>
            <button
              type="button"
              className="icon-button panel-close"
              onClick={() => setLeftPanelOpen(false)}
              aria-label="Close session tree"
            >
              <X aria-hidden="true" />
            </button>
          </div>
          <nav className="primary-nav" aria-label="Commando areas">
            <button type="button" className={area === 'workspace' ? 'active' : ''} aria-current={area === 'workspace' ? 'page' : undefined} onClick={() => { setArea('workspace'); setLeftPanelOpen(false) }}>
              <PanelsTopLeft aria-hidden="true" />
              <span>Workspace</span>
              <span className="nav-count">{snapshot?.sessions.length ?? 0}</span>
            </button>
            <button type="button" className={area === 'linear' ? 'active' : ''} aria-current={area === 'linear' ? 'page' : undefined} onClick={() => { setArea('linear'); setLeftPanelOpen(false) }}>
              <CircleDotDashed aria-hidden="true" />
              <span>Linear</span>
            </button>
            <button type="button" className={area === 'notes' ? 'active' : ''} aria-current={area === 'notes' ? 'page' : undefined} onClick={() => { setArea('notes'); setLeftPanelOpen(false) }}>
              <NotebookPen aria-hidden="true" />
              <span>Notes</span>
            </button>
          </nav>

          <div className="tree-heading">
            <span>Session tree</span>
            <span>{snapshot?.panes.length ?? 0} panes</span>
          </div>
          <div className="session-tree">
            <SessionTree
              token={token}
              sessions={snapshot?.sessions ?? []}
              windows={snapshot?.windows ?? []}
              panes={snapshot?.panes ?? []}
              statuses={agentStatuses}
              selectedSessionId={selectedSessionId}
              focusedPaneId={focusedPaneId}
              onSelectSession={selectSession}
              onSelectWindow={jumpToGroup}
              onSelectPane={jumpToPane}
              onSessionsChanged={refresh}
            />
            <TmuxCreateControls
              sessions={snapshot?.sessions ?? []}
              windows={snapshot?.windows ?? []}
              panes={snapshot?.panes ?? []}
              disabled={!connected}
              defaultSessionId={selectedSessionId ?? ''}
              defaultTargetId={focusedPaneId ?? activeWindow?.id ?? ''}
              onCreateSession={tmuxCreateApi.createSession}
              onCreateWindow={tmuxCreateApi.createWindow}
              onCreatePane={tmuxCreateApi.createPane}
              onCreated={(created) => { setArea('workspace'); setSelectedSessionId(created.sessionId); refresh() }}
            />
          </div>
          <footer className="sidebar-footer">
            <Server aria-hidden="true" />
            <span>
              <strong>Snapshot r{snapshot?.revision ?? '-'}</strong>
              <small>{snapshot ? displayTime(snapshot.capturedAt) : connection.detail}</small>
            </span>
          </footer>
        </aside>

        <main className={`workspace-main area-${area}`} id="workspace-main">
          {area === 'workspace' ? <>
          <header className="workspace-toolbar">
            <div className="workspace-context">
              <span className="section-kicker">Workspace</span>
              <h1>{selectedSession?.name ?? 'Waiting for tmux'}</h1>
              <p>
                {activeWindow ? `Active window ${activeWindow.index}: ${activeWindow.name}` : 'No active window'}
                {' / '}{groups.length} groups / {allVisiblePaneIds.length} visible panes
              </p>
            </div>
            <div className="workspace-actions">
              {dirtySessionIds.includes(selectedSessionId ?? '') ? (
                <span className="save-state"><Clock3 aria-hidden="true" /> Queued to save</span>
              ) : selectedWorkspace ? (
                <span className="save-state saved"><ShieldCheck aria-hidden="true" /> Saved layout</span>
              ) : (
                <span className="save-state"><LayoutGrid aria-hidden="true" /> Window defaults</span>
              )}
              <button
                type="button"
                className="icon-button"
                onClick={refresh}
                disabled={!connected}
                aria-label="Refresh tmux snapshot"
                title="Refresh snapshot"
              >
                <RefreshCw aria-hidden="true" />
              </button>
              <button
                type="button"
                className="icon-button"
                onClick={() => setPaletteOpen(true)}
                aria-label="Open command palette"
                title="Command palette"
              >
                <Command aria-hidden="true" />
              </button>
            </div>
          </header>

          <div className={`workspace-canvas${maximizedPaneId ? ' maximized' : ''}`}>
            {groups.map((group) => {
              const groupPanes = group.paneIds.flatMap((paneId) => {
                const pane = paneMap.get(paneId)
                return pane ? [pane] : []
              })
              const visibleGroupPanes = maximizedPaneId
                ? groupPanes.filter((pane) => pane.id === maximizedPaneId)
                : groupPanes
              if (maximizedPaneId && visibleGroupPanes.length === 0) return null

              const window = windowMap.get(group.windowId)
              return (
                <section className="pane-group" key={group.id} data-group-id={group.id}>
                  <header className="group-head">
                    <span className="group-grip"><GripVertical aria-hidden="true" /></span>
                    <div className="group-title">
                      <span>{window ? `Window ${window.index}` : 'Saved group'}</span>
                      <h2>{group.name}</h2>
                      <p>{groupPanes.length} panes / {group.layout.replaceAll('-', ' ')}</p>
                    </div>
                    <div className="layout-controls" role="group" aria-label={`Layout for ${group.name}`}>
                      {PRESETS.map((preset) => (
                        <button
                          type="button"
                          className={group.layout === preset.id ? 'active' : ''}
                          onClick={() => updateGroup(group.id, (current) => ({ ...current, layout: preset.id }))}
                          aria-label={preset.label}
                          aria-pressed={group.layout === preset.id}
                          title={preset.label}
                          key={preset.id}
                        >
                          {preset.icon}
                        </button>
                      ))}
                    </div>
                  </header>
                  {visibleGroupPanes.length ? (
                    <div className={`pane-grid layout-${group.layout}`}>
                      {visibleGroupPanes.map((pane) => {
                        const originalIndex = groupPanes.findIndex((candidate) => candidate.id === pane.id)
                        return (
                          <TerminalPaneCard
                            key={pane.id}
                            pane={pane}
                            status={agentStatuses[pane.id]}
                            index={originalIndex}
                            count={groupPanes.length}
                            preset={group.layout}
                            maximized={maximizedPaneId === pane.id}
                            focused={focusedPaneId === pane.id}
                            connected={connected}
                            onFocus={() => setFocusedPaneId(pane.id)}
                            onMove={(direction) => movePane(group.id, pane.id, direction)}
                            onMaximize={() => setMaximizedPaneId((current) => current === pane.id ? null : pane.id)}
                            onDragStart={(event) => {
                              setDraggedPane({ groupId: group.id, paneId: pane.id })
                              event.dataTransfer.effectAllowed = 'move'
                              event.dataTransfer.setData('text/plain', pane.id)
                            }}
                            onDragEnd={() => setDraggedPane(null)}
                            onDragOver={(event) => {
                              if (draggedPane?.groupId === group.id) {
                                event.preventDefault()
                                event.dataTransfer.dropEffect = 'move'
                              }
                            }}
                            onDrop={(event) => {
                              event.preventDefault()
                              dropPane(group.id, pane.id)
                            }}
                            onInput={(data) => sendPaneInput(pane.id, data)}
                            onKey={(key) => sendPaneKey(pane.id, key)}
                            onPaste={(data) => sendPanePaste(pane.id, data)}
                            registerSink={registerTerminalSink}
                            registerFocusable={registerFocusable}
                          />
                        )
                      })}
                    </div>
                  ) : (
                    <div className="group-empty">This saved group has no panes in the current tmux snapshot.</div>
                  )}
                </section>
              )
            })}

            {!snapshot ? (
              <section className="workspace-empty" aria-live="polite">
                <LoaderCircle className="spin" aria-hidden="true" />
                <h2>Hydrating the local cockpit</h2>
                <p>{connection.detail}</p>
              </section>
            ) : null}
            {snapshot && !selectedSession ? (
              <section className="workspace-empty">
                <AlertTriangle aria-hidden="true" />
                <h2>No active tmux sessions</h2>
                <p>Start or attach a tmux session, then refresh the daemon snapshot.</p>
              </section>
            ) : null}
          </div>
          </> : area === 'linear' ? <LinearSection token={token} /> : <NotesSection token={token} />}
        </main>

        {area === 'workspace' ? <aside className={`agent-hud${rightPanelOpen ? ' panel-open' : ''}`}>
          <div className="hud-header">
            <div className="hud-heading">
              <span className={`hud-pulse${attentionCount ? ' attention' : ''}`} />
              <div><strong>Agent HUD</strong><small>Attention first</small></div>
            </div>
            <button
              type="button"
              className="icon-button panel-close"
              onClick={() => setRightPanelOpen(false)}
              aria-label="Close Agent HUD"
            >
              <X aria-hidden="true" />
            </button>
          </div>
          <div className="hud-context">
            <span className="section-kicker">Session context</span>
            <strong>{selectedSession?.name ?? 'No session'}</strong>
            <small>{activeWindow ? `Window ${activeWindow.index}: ${activeWindow.name}` : 'All visible windows'}</small>
          </div>
          <div className="hud-stats" aria-label="Agent status totals">
            <div><strong>{workingCount}</strong><span>Working</span></div>
            <div className={attentionCount ? 'attention' : ''}><strong>{attentionCount}</strong><span>Need you</span></div>
            <div><strong>{doneCount}</strong><span>Done</span></div>
          </div>
          <div className="agent-stream">
            {selectedPaneStatuses.map((status) => {
              const pane = paneMap.get(status.paneId)
              const window = pane ? windowMap.get(pane.windowId) : undefined
              return (
                <button
                  type="button"
                  className={`agent-card status-${status.status}`}
                  onClick={() => jumpToPane(status.paneId)}
                  key={status.paneId}
                >
                  <span className={`agent-avatar provider-${status.provider}`}>
                    {providerInitials(status.provider)}
                  </span>
                  <span className="agent-copy">
                    <span className="agent-title-row">
                      <strong>{status.provider === 'unknown' ? 'Agent' : status.provider}</strong>
                      <span className={`agent-state ${status.status}`}>{status.status.replace('_', ' ')}</span>
                    </span>
                    <span className="agent-summary">{status.summary || status.reason}</span>
                    <span className="agent-context">
                      {window?.name ?? pane?.windowId ?? 'unknown window'} / pane {pane?.index ?? '?'} / {displayTime(status.updatedAt)}
                    </span>
                    <span className="provenance-row">
                      <ShieldCheck aria-hidden="true" />
                      Source: {status.source} / Confidence: {status.confidence}
                    </span>
                    <span className="agent-reason">{status.reason}</span>
                  </span>
                  <ChevronRight className="jump-chevron" aria-hidden="true" />
                </button>
              )
            })}
            {selectedPaneStatuses.length === 0 ? (
              <div className="hud-empty">
                <Bot aria-hidden="true" />
                <strong>No agent signals yet</strong>
                <p>Provider hooks, process inspection, and heuristics will appear here with their source.</p>
              </div>
            ) : null}
          </div>
          <button type="button" className="quick-jump" onClick={() => setPaletteOpen(true)}>
            <Search aria-hidden="true" />
            <span><strong>Quick-jump to pane</strong><small>Search every session and window</small></span>
            <kbd>Cmd K</kbd>
          </button>
          <footer className="hud-footer">
            <LockKeyhole aria-hidden="true" />
            <span>Status metadata includes explicit provenance and bounded heuristic reasons.</span>
          </footer>
        </aside> : null}
      </div>

      {paletteOpen ? (
        <div
          className="palette-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setPaletteOpen(false)
          }}
        >
          <section className="command-palette" role="dialog" aria-modal="true" aria-label="Command palette">
            <div className="palette-search">
              <Search aria-hidden="true" />
              <input
                ref={paletteInputRef}
                id="command-query"
                name="command-query"
                value={paletteQuery}
                onChange={(event) => {
                  setPaletteQuery(event.target.value)
                  setPaletteIndex(0)
                }}
                onKeyDown={handlePaletteKeyDown}
                placeholder="Jump to a pane, session, or action..."
                aria-label="Search commands"
                aria-controls="command-results"
                aria-activedescendant={filteredCommands[safePaletteIndex]?.id}
              />
              <kbd>Esc</kbd>
            </div>
            <div className="palette-caption">
              <span>{normalizedQuery ? 'Matching commands' : 'Local cockpit commands'}</span>
              <span>{filteredCommands.length} results</span>
            </div>
            <div className="command-results" id="command-results" role="listbox">
              {filteredCommands.map((command, index) => (
                <button
                  type="button"
                  id={command.id}
                  className={index === safePaletteIndex ? 'active' : ''}
                  onMouseEnter={() => setPaletteIndex(index)}
                  onClick={command.run}
                  role="option"
                  aria-selected={index === safePaletteIndex}
                  key={command.id}
                >
                  <span className="command-icon"><PaletteGlyph kind={command.kind} /></span>
                  <span><strong>{command.label}</strong><small>{command.detail}</small></span>
                  <span className="command-kind">{command.kind}</span>
                </button>
              ))}
              {filteredCommands.length === 0 ? (
                <div className="palette-empty">No local command matches "{paletteQuery}".</div>
              ) : null}
            </div>
            <footer className="palette-footer">
              <span><kbd>Up/Down</kbd> Navigate</span>
              <span><kbd>Enter</kbd> Run</span>
              <span><kbd>Esc</kbd> Close</span>
            </footer>
          </section>
        </div>
      ) : null}
    </div>
  )
}
