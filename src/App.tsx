import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Bot,
  Check,
  ChevronRight,
  CircleDotDashed,
  Command,
  Grid2X2,
  KeyRound,
  LayoutGrid,
  LoaderCircle,
  LockKeyhole,
  LogOut,
  Mail,
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
  UserRound,
  WifiOff,
  X,
} from 'lucide-react'
import {

  type DragEvent,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react'

import type {
  AgentProvider,
  AgentStatus,
  CommandoSnapshot,
  LayoutSpec,
  PaneLayoutCapacity,
  SavedWorkspace,
  ServerMessage,
  SpecialKey,
  TmuxPane,
} from '../shared/protocol'
import {
  filterLayoutTree,
  layoutShapeKey,
  layoutSpecFromTree,
  layoutTreePanes,
  parseWindowLayout,
  type WindowLayoutNode,
} from '../shared/window-layout'
import {
  defaultGroupsForSession,
  presetLayoutSpec,
  reconcileGroupsForSession,
  type GroupLayoutPreset,
} from './layout'
import { decodeBase64Bytes, PaneStreamRegistry, type PaneTerminalSink } from './paneStream'
import { dispatchBoundedPaste } from './terminalInput'
import { THEMES, applyTheme, storedTheme, type ThemeName } from './theme'
import { type ConnectionPhase, useDaemon } from './useDaemon'
import { XtermPane } from './XtermPane'
import { LinearSection } from './LinearSection'
import { ResizablePaneLayout } from './ResizablePaneLayout'
import { SessionTree } from './SessionTree'
import { TmuxCreateControls } from './TmuxCreateControls'
import { createTmuxHttpApi } from './tmuxCreateApi'
import { PaneContextMenu, type PaneSplitDirection } from './PaneContextMenu'
import { createPaneManagementApi } from './paneManagementApi'
import { createGitDiffApi, type GitDiffApiClient } from './gitApi'
import { PaneGitStats } from './PaneGitStats'
import { PortsSection } from './PortsSection'
import {
  createOwner,
  getAuthBootstrap,
  getAuthUser,
  signInWithEmail,
  signOut,
  type AuthBootstrap,
  type AuthUser,
} from './authClient'

const TOKEN_STORAGE_KEY = 'commando.session-token'
const NotesSection = lazy(() => import('./NotesSection').then((module) => ({ default: module.NotesSection })))

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

const LEFT_PANEL_HIDDEN_STORAGE_KEY = 'commando.panel.left-hidden'
const RIGHT_PANEL_HIDDEN_STORAGE_KEY = 'commando.panel.right-hidden'

function storedPanelHidden(key: string): boolean {
  try {
    return window.localStorage.getItem(key) === 'true'
  } catch {
    return false
  }
}

function storePanelHidden(key: string, hidden: boolean): void {
  try {
    window.localStorage.setItem(key, String(hidden))
  } catch {
    // Panel visibility still works in memory when storage is unavailable.
  }
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

function clearToken() {
  try {
    window.sessionStorage.removeItem(TOKEN_STORAGE_KEY)
  } catch {
    // The in-memory credential can still be cleared when storage is unavailable.
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
      return 'Signed out'
    case 'signed-out':
      return 'Sign in required'
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
  maximized: boolean
  focused: boolean
  resizeOwner: boolean
  measurementKey: string
  connected: boolean
  renaming: boolean
  gitApi: GitDiffApiClient
  onFocus: () => void
  onOpenMenu: (x: number, y: number) => void
  onRename: (title: string) => Promise<void>
  onRenameFinished: () => void
  onMove: (direction: -1 | 1) => void
  onMaximize: () => void
  onDragStart: (event: DragEvent<HTMLElement>) => void
  onDragEnd: () => void
  onDragOver: (event: DragEvent<HTMLElement>) => void
  onDrop: (event: DragEvent<HTMLElement>) => void
  onInput: (data: string) => void
  onKey: (key: SpecialKey) => void
  onPaste: (data: string) => void
  onResize: (cols: number, rows: number) => void
  registerSink: (paneId: string, sink: PaneTerminalSink) => () => void
  registerFocusable: (paneId: string, node: HTMLElement | null) => void
}

export function TerminalPaneCard({
  pane,
  status,
  index,
  count,
  maximized,
  focused,
  resizeOwner,
  measurementKey,
  connected,
  renaming,
  gitApi,
  onFocus,
  onOpenMenu,
  onRename,
  onRenameFinished,
  onMove,
  onMaximize,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDrop,
  onInput,
  onKey,
  onPaste,
  onResize,
  registerSink,
  registerFocusable,
}: TerminalPaneProps) {
  const paneLabel = pane.title || pane.command || `Pane ${pane.index}`
  const renameInputRef = useRef<HTMLInputElement>(null)
  const [renameValue, setRenameValue] = useState(paneLabel)
  const [renamePending, setRenamePending] = useState(false)
  const [renameError, setRenameError] = useState('')
  const [pathCopyState, setPathCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const [selectionCopied, setSelectionCopied] = useState(false)
  const pathCopyResetTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const selectionCopyResetTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => {
    if (!renaming) return
    setRenameValue(paneLabel)
    setRenameError('')
    window.setTimeout(() => {
      renameInputRef.current?.focus()
      renameInputRef.current?.select()
    }, 0)
  }, [paneLabel, renaming])

  useEffect(() => () => {
    clearTimeout(pathCopyResetTimer.current)
    clearTimeout(selectionCopyResetTimer.current)
  }, [])

  const commitRename = async () => {
    if (renamePending) return
    const title = renameValue.trim()
    if (!title) {
      setRenameError('Pane title is required')
      renameInputRef.current?.focus()
      return
    }
    if (title === pane.title) {
      onRenameFinished()
      return
    }
    setRenamePending(true)
    setRenameError('')
    try {
      await onRename(title)
      onRenameFinished()
    } catch (cause) {
      setRenameError(cause instanceof Error ? cause.message : 'Unable to rename pane')
      window.setTimeout(() => {
        renameInputRef.current?.focus()
        renameInputRef.current?.select()
      }, 0)
    } finally {
      setRenamePending(false)
    }
  }

  const copyPath = async () => {
    clearTimeout(pathCopyResetTimer.current)
    try {
      await navigator.clipboard.writeText(pane.path)
      setPathCopyState('copied')
    } catch {
      setPathCopyState('failed')
    }
    pathCopyResetTimer.current = setTimeout(() => setPathCopyState('idle'), 1500)
  }

  const showSelectionCopied = () => {
    clearTimeout(selectionCopyResetTimer.current)
    setSelectionCopied(true)
    selectionCopyResetTimer.current = setTimeout(() => setSelectionCopied(false), 1500)
  }

  return (
    <article
      className={`terminal-pane${focused ? ' is-focused' : ''}${maximized ? ' is-maximized' : ''}${count === 1 ? ' is-solo' : ''}`}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onContextMenu={(event) => {
        if (!event.altKey) return
        event.preventDefault()
        onFocus()
        onOpenMenu(event.clientX, event.clientY)
      }}
      data-pane-id={pane.id}
    >
      <header
        className="pane-head"
        draggable={!renaming}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onKeyDown={(event) => {
          if ((event.shiftKey && event.key === 'F10') || event.key === 'ContextMenu') {
            event.preventDefault()
            const bounds = event.currentTarget.getBoundingClientRect()
            onOpenMenu(bounds.left + 24, bounds.bottom)
          }
        }}
        tabIndex={0}
        title={renaming ? undefined : 'Drag to reorder this pane; Option-right click for pane actions'}
      >
        <span className={`pane-icon provider-${status?.provider ?? 'unknown'}`}>
          {status ? <Bot aria-hidden="true" /> : <Terminal aria-hidden="true" />}
        </span>
        <span className="pane-heading">
          {renaming ? (
            <form
              className={`pane-title-form${renameError ? ' has-error' : ''}`}
              onSubmit={(event) => {
                event.preventDefault()
                void commitRename()
              }}
            >
              <input
                ref={renameInputRef}
                value={renameValue}
                maxLength={128}
                disabled={renamePending}
                aria-label={`Rename ${paneLabel}`}
                aria-invalid={Boolean(renameError)}
                title={renameError || 'Press Enter to save or Escape to cancel'}
                onChange={(event) => setRenameValue(event.target.value)}
                onBlur={() => { void commitRename() }}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') {
                    event.preventDefault()
                    event.stopPropagation()
                    onRenameFinished()
                  }
                }}
              />
            </form>
          ) : <strong>{paneLabel}</strong>}
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
        resizeOwner={resizeOwner}
        measurementKey={measurementKey}
        ariaLabel={`${pane.title || `Pane ${pane.index}`} terminal input${connected ? '' : ', disconnected'}`}
        onFocus={onFocus}
        onInput={onInput}
        onKey={onKey}
        onPaste={onPaste}
        onSelectionCopied={showSelectionCopied}
        onResize={onResize}
        registerSink={registerSink}
        registerFocusable={registerFocusable}
      />
      <footer className="pane-footer">
        <span className={`input-indicator${connected && focused ? ' live' : ''}`} />
        <span>{!connected ? 'Read only while offline' : focused ? 'Focused / keys go here' : 'Click to focus'}</span>
        <span>{pane.width}x{pane.height}</span>
        <PaneGitStats paneId={pane.id} panePath={pane.path} api={gitApi} connected={connected} />
        <button
          type="button"
          className="pane-path"
          data-copy-state={pathCopyState}
          onClick={() => void copyPath()}
          aria-label={`Copy path ${pane.path}`}
          title={pathCopyState === 'copied' ? 'Copied path' : pathCopyState === 'failed' ? 'Unable to copy path' : `Copy path: ${pane.path}`}
        >
          <span className="pane-path-status" aria-live="polite">
            {pathCopyState === 'copied' ? 'Copied' : pathCopyState === 'failed' ? 'Copy failed' : null}
          </span>
          <span className="pane-path-value">{pane.path}</span>
        </button>
      </footer>
      {selectionCopied ? (
        <div className="terminal-copy-toast" role="status" aria-live="polite">
          <Check aria-hidden="true" />
          <span>Copied</span>
        </div>
      ) : null}
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

function defaultOwnerName(email: string | null): string {
  const localPart = email?.split('@')[0] ?? 'Owner'
  return localPart
    .split(/[._-]+/)
    .filter(Boolean)
    .map((part) => `${part[0]?.toUpperCase() ?? ''}${part.slice(1)}`)
    .join(' ') || 'Owner'
}

export function AuthGate({
  bootstrap,
  initialError,
  tokenRejected,
  onAuthenticated,
  onToken,
}: {
  bootstrap: AuthBootstrap
  initialError: string
  tokenRejected: boolean
  onAuthenticated: (user: AuthUser) => void
  onToken: (token: string) => void
}) {
  const [name, setName] = useState(() => defaultOwnerName(bootstrap.ownerEmail))
  const [email, setEmail] = useState(bootstrap.ownerEmail ?? '')
  const [password, setPassword] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [tokenDraft, setTokenDraft] = useState('')
  const [error, setError] = useState(initialError)
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    if (!bootstrap.ownerEmail) return
    setEmail((current) => current || bootstrap.ownerEmail || '')
    setName((current) => current === 'Owner' ? defaultOwnerName(bootstrap.ownerEmail) : current)
  }, [bootstrap.ownerEmail])

  const submitEmail = async (event: FormEvent) => {
    event.preventDefault()
    if (bootstrap.needsOwner && password !== confirmation) {
      setError('Passwords do not match')
      return
    }
    setSubmitting(true)
    setError('')
    try {
      const user = bootstrap.needsOwner
        ? await createOwner(name.trim(), email.trim(), password)
        : await signInWithEmail(email.trim(), password)
      onAuthenticated(user)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Authentication failed')
    } finally {
      setSubmitting(false)
    }
  }

  const submitToken = (event: FormEvent) => {
    event.preventDefault()
    const nextToken = tokenDraft.trim()
    if (!nextToken) return
    storeToken(nextToken)
    onToken(nextToken)
  }

  return (
    <main className="auth-screen">
      <div className="auth-ambient" aria-hidden="true" />
      <section className="auth-card" aria-labelledby="auth-title">
        <div className="auth-mark"><Command aria-hidden="true" /></div>
        <span className="eyebrow">Local authority only</span>
        <h1 id="auth-title">
          {tokenRejected
            ? 'The automation token was rejected.'
            : bootstrap.needsOwner
              ? 'Create the owner account.'
              : 'Sign in to Commando.'}
        </h1>
        <p>
          {bootstrap.enabled
            ? 'Your session stays in a signed, HttpOnly cookie. Commando never stores the password in the browser.'
            : 'Email authentication is not configured for this daemon. Connect with its automation token.'}
        </p>

        {bootstrap.enabled ? (
          <form className="auth-form" onSubmit={(event) => void submitEmail(event)}>
            {bootstrap.needsOwner ? (
              <label>
                <span>Display name</span>
                <span className="auth-input"><UserRound aria-hidden="true" /><input value={name} onChange={(event) => setName(event.target.value)} autoComplete="name" required maxLength={80} /></span>
              </label>
            ) : null}
            <label>
              <span>Email</span>
              <span className="auth-input"><Mail aria-hidden="true" /><input type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" required /></span>
            </label>
            <label>
              <span>Password</span>
              <span className="auth-input"><LockKeyhole aria-hidden="true" /><input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete={bootstrap.needsOwner ? 'new-password' : 'current-password'} minLength={12} maxLength={128} required autoFocus={!bootstrap.needsOwner} /></span>
            </label>
            {bootstrap.needsOwner ? (
              <label>
                <span>Confirm password</span>
                <span className="auth-input"><ShieldCheck aria-hidden="true" /><input type="password" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} autoComplete="new-password" minLength={12} maxLength={128} required /></span>
              </label>
            ) : null}
            {error ? <p className="auth-error" role="alert">{error}</p> : null}
            <button className="auth-submit" type="submit" disabled={submitting}>
              {submitting ? 'Authenticating...' : bootstrap.needsOwner ? 'Create owner' : 'Sign in'}
            </button>
          </form>
        ) : initialError ? <p className="auth-error" role="alert">{initialError}</p> : null}

        <details className="token-fallback" open={!bootstrap.enabled || tokenRejected}>
          <summary>{bootstrap.enabled ? 'Use an automation token instead' : 'Connect with token'}</summary>
          <form onSubmit={submitToken}>
            <label htmlFor="daemon-token">Daemon automation token</label>
            <div className="token-field">
              <KeyRound aria-hidden="true" />
              <input id="daemon-token" type="password" value={tokenDraft} onChange={(event) => setTokenDraft(event.target.value)} placeholder="Paste token" autoComplete="off" autoFocus={!bootstrap.enabled} />
              <button type="submit" disabled={!tokenDraft.trim()}>Connect</button>
            </div>
          </form>
        </details>

        <div className="auth-boundary">
          <ShieldCheck aria-hidden="true" />
          <span>Expected endpoint: loopback or an explicitly enabled Tailscale interface.</span>
        </div>
      </section>
    </main>
  )
}

function PaletteGlyph({ kind }: { kind: PaletteCommand['kind'] }) {
  if (kind === 'pane') return <Terminal aria-hidden="true" />
  if (kind === 'session') return <Server aria-hidden="true" />
  if (kind === 'layout') return <LayoutGrid aria-hidden="true" />
  return <RefreshCw aria-hidden="true" />
}

export function App() {
  const [token, setToken] = useState(getInitialToken)
  const [authBootstrap, setAuthBootstrap] = useState<AuthBootstrap | null>(null)
  const [authUser, setAuthUser] = useState<AuthUser | null>(null)
  const [authPending, setAuthPending] = useState(true)
  const [authError, setAuthError] = useState('')
  const [snapshot, setSnapshot] = useState<CommandoSnapshot | null>(null)
  const [agentStatuses, setAgentStatuses] = useState<Record<string, AgentStatus>>({})
  const [workspaces, setWorkspaces] = useState<Record<string, SavedWorkspace>>({})
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null)
  const [focusedPaneId, setFocusedPaneId] = useState<string | null>(null)
  const [maximizedPaneId, setMaximizedPaneId] = useState<string | null>(null)
  const [webLayoutAuthoritative, setWebLayoutAuthoritative] = useState(true)
  const [webLayoutError, setWebLayoutError] = useState('')
  const [draggedPane, setDraggedPane] = useState<{ groupId: string; paneId: string } | null>(null)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [paletteQuery, setPaletteQuery] = useState('')
  const [paletteIndex, setPaletteIndex] = useState(0)
  const [themeName, setThemeName] = useState<ThemeName>(() => storedTheme())
  const [leftPanelOpen, setLeftPanelOpen] = useState(false)
  const [rightPanelOpen, setRightPanelOpen] = useState(false)
  const [leftPanelHidden, setLeftPanelHidden] = useState(() => storedPanelHidden(LEFT_PANEL_HIDDEN_STORAGE_KEY))
  const [rightPanelHidden, setRightPanelHidden] = useState(() => storedPanelHidden(RIGHT_PANEL_HIDDEN_STORAGE_KEY))
  const [pendingFocusPaneId, setPendingFocusPaneId] = useState<string | null>(null)
  const [paneMenu, setPaneMenu] = useState<{ paneId: string; x: number; y: number } | null>(null)
  const [renamingPaneId, setRenamingPaneId] = useState<string | null>(null)
  const [paneActionPending, setPaneActionPending] = useState(false)
  const [paneActionError, setPaneActionError] = useState('')
  const pendingMaximizePaneId = useRef<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void getAuthBootstrap()
      .then(async (bootstrap) => {
        const user = bootstrap.enabled ? await getAuthUser() : null
        if (cancelled) return
        setAuthBootstrap(bootstrap)
        setAuthUser(user)
      })
      .catch((cause: unknown) => {
        if (cancelled) return
        setAuthError(cause instanceof Error ? cause.message : 'Authentication initialization failed')
      })
      .finally(() => {
        if (!cancelled) setAuthPending(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => storePanelHidden(LEFT_PANEL_HIDDEN_STORAGE_KEY, leftPanelHidden), [leftPanelHidden])
  useEffect(() => storePanelHidden(RIGHT_PANEL_HIDDEN_STORAGE_KEY, rightPanelHidden), [rightPanelHidden])

  const [area, setArea] = useState<CommandoArea>('workspace')
  const [notesMounted, setNotesMounted] = useState(false)
  const paneRefs = useRef(new Map<string, HTMLElement>())
  const paneStreamsRef = useRef<PaneStreamRegistry | null>(null)
  if (!paneStreamsRef.current) paneStreamsRef.current = new PaneStreamRegistry()
  const paletteInputRef = useRef<HTMLInputElement>(null)
  const previousResizePaneId = useRef<string | null>(null)
  const paneLayoutCapacities = useRef(new Map<string, PaneLayoutCapacity & { key: string }>())
  const layoutTimers = useRef(new Map<string, number>())

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
        break
      case 'error':
        console.error(`[commando:${message.code}] ${message.message}`)
        if (
          message.code === 'tmux_layout_failed' ||
          message.code === 'invalid_window_layout' ||
          message.code === 'resize_window_busy'
        ) {
          setWebLayoutError(message.message)
        }
        break
    }
  }

  const { connection, send } = useDaemon(token, authUser !== null, handleServerMessage)
  const connected = connection.phase === 'live'

  useEffect(() => {
    if (!token && connection.phase === 'unauthorized') setAuthUser(null)
  }, [connection.phase, token])
  const activeResizePaneId = connected && area === 'workspace'
    ? maximizedPaneId ?? (webLayoutAuthoritative ? null : focusedPaneId)
    : null

  useEffect(() => {
    const previousPaneId = previousResizePaneId.current
    if (
      previousPaneId &&
      previousPaneId !== activeResizePaneId &&
      !webLayoutAuthoritative
    ) {
      send({
        type: 'release_resize',
        paneId: previousPaneId,
        requestId: requestId('resize-release'),
      })
    }
    previousResizePaneId.current = activeResizePaneId
  }, [activeResizePaneId, send, webLayoutAuthoritative])

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

  useEffect(() => {
    if (connection.phase !== 'live') {
      paneStreamsRef.current?.clear()
      return
    }
    setAgentStatuses({})
  }, [connection.phase])

  useEffect(() => {
    setMaximizedPaneId(pendingMaximizePaneId.current)
    pendingMaximizePaneId.current = null
    setFocusedPaneId(null)
  }, [selectedSessionId])

  useEffect(() => {
    if (maximizedPaneId && !snapshot?.panes.some((pane) => pane.id === maximizedPaneId)) {
      setMaximizedPaneId(null)
    }
    if (focusedPaneId && !snapshot?.panes.some((pane) => pane.id === focusedPaneId)) {
      setFocusedPaneId(null)
    }
    if (paneMenu && !snapshot?.panes.some((pane) => pane.id === paneMenu.paneId)) {
      setPaneMenu(null)
    }
    if (renamingPaneId && !snapshot?.panes.some((pane) => pane.id === renamingPaneId)) {
      setRenamingPaneId(null)
    }
  }, [focusedPaneId, maximizedPaneId, paneMenu, renamingPaneId, snapshot])

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
    setArea('workspace')
    setSelectedSessionId(pane.sessionId)
    setPendingFocusPaneId(paneId)
    setPaletteOpen(false)
    setLeftPanelOpen(false)
    setRightPanelOpen(false)
  }

  const openPaneMaximized = (paneId: string) => {
    if (!paneMap.has(paneId)) return
    pendingMaximizePaneId.current = paneId
    jumpToPane(paneId)
    setMaximizedPaneId(paneId)
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

  const windowLayoutTree = (windowId: string): WindowLayoutNode | null => {
    const window = windowMap.get(windowId)
    return window ? parseWindowLayout(window.layout) : null
  }

  const sendWindowLayout = (windowId: string, spec: LayoutSpec | null) => {
    if (!connected || !spec) return
    setWebLayoutError('')
    send({
      type: 'set_window_layout',
      windowId,
      spec,
      requestId: requestId('layout-set'),
    })
  }

  const swapWindowPanes = (windowId: string, firstPaneId: string, secondPaneId: string) => {
    const tree = windowLayoutTree(windowId)
    if (!tree || firstPaneId === secondPaneId) return
    const swapped = new Map([
      [firstPaneId, secondPaneId],
      [secondPaneId, firstPaneId],
    ])
    const swapLeaves = (spec: LayoutSpec): LayoutSpec => spec.kind === 'pane'
      ? { ...spec, paneId: swapped.get(spec.paneId) ?? spec.paneId }
      : { ...spec, children: spec.children.map(swapLeaves) }
    sendWindowLayout(windowId, swapLeaves(layoutSpecFromTree(tree)))
  }

  const movePane = (windowId: string, paneId: string, direction: -1 | 1) => {
    const tree = windowLayoutTree(windowId)
    if (!tree) return
    const paneIds = layoutTreePanes(tree).map((leaf) => leaf.paneId)
    const neighbor = paneIds[paneIds.indexOf(paneId) + direction]
    if (neighbor) swapWindowPanes(windowId, paneId, neighbor)
  }

  const dropPane = (windowId: string, groupId: string, targetPaneId: string) => {
    if (!draggedPane || draggedPane.groupId !== groupId || draggedPane.paneId === targetPaneId) return
    swapWindowPanes(windowId, draggedPane.paneId, targetPaneId)
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

  const clearLayoutTimers = () => {
    for (const timer of layoutTimers.current.values()) window.clearTimeout(timer)
    layoutTimers.current.clear()
  }

  const sendPaneResize = (
    windowId: string,
    paneId: string,
    measurementKey: string,
    cols: number,
    rows: number,
  ) => {
    if (!connected) return
    if (webLayoutAuthoritative && !maximizedPaneId) {
      paneLayoutCapacities.current.set(paneId, { paneId, cols, rows, key: measurementKey })
      const existingTimer = layoutTimers.current.get(windowId)
      if (existingTimer !== undefined) window.clearTimeout(existingTimer)
      layoutTimers.current.set(windowId, window.setTimeout(() => {
        layoutTimers.current.delete(windowId)
        const tree = windowLayoutTree(windowId)
        if (!tree) return
        const leaves = layoutTreePanes(tree)
        const capacities = leaves.map((leaf) => paneLayoutCapacities.current.get(leaf.paneId))
        if (
          capacities.some((capacity) => !capacity || capacity.key !== measurementKey)
        ) return
        const sizes = new Map(
          (capacities as Array<PaneLayoutCapacity & { key: string }>).map((capacity) => [
            capacity.paneId,
            { cols: capacity.cols, rows: capacity.rows },
          ]),
        )
        const stacked = window.matchMedia('(max-width: 680px)').matches && leaves.length > 1
        const spec: LayoutSpec = stacked
          ? {
              kind: 'split',
              direction: 'column',
              children: leaves.map((leaf) => ({
                kind: 'pane',
                paneId: leaf.paneId,
                ...(sizes.get(leaf.paneId) ?? { cols: leaf.cols, rows: leaf.rows }),
              })),
            }
          : layoutSpecFromTree(tree, sizes)
        send({
          type: 'apply_window_layout',
          windowId,
          spec,
          requestId: requestId('layout'),
        })
      }, 120))
      return
    }
    if (activeResizePaneId !== paneId) return
    send({ type: 'resize_pane', paneId, cols, rows, requestId: requestId('resize') })
  }

  /**
   * Writes splitter-drag proportions back to tmux while the web is not
   * authoritative; leaf weights come from the panes' current DOM extents.
   */
  const commitWindowLayout = (windowId: string) => {
    if (!connected || webLayoutAuthoritative || maximizedPaneId) return
    const tree = windowLayoutTree(windowId)
    if (!tree) return
    const sizes = new Map<string, { cols: number; rows: number }>()
    for (const leaf of layoutTreePanes(tree)) {
      const element = document.querySelector(`[data-pane-id="${CSS.escape(leaf.paneId)}"]`)
      if (!element) return
      const bounds = element.getBoundingClientRect()
      sizes.set(leaf.paneId, {
        cols: Math.min(500, Math.max(2, Math.round(bounds.width / 10))),
        rows: Math.min(200, Math.max(1, Math.round(bounds.height / 10))),
      })
    }
    sendWindowLayout(windowId, layoutSpecFromTree(tree, sizes))
  }

  const restructureWindow = (windowId: string, preset: GroupLayoutPreset) => {
    clearLayoutTimers()
    const tree = windowLayoutTree(windowId)
    if (!tree) return
    const paneIds = layoutTreePanes(tree).map((leaf) => leaf.paneId)
    sendWindowLayout(windowId, presetLayoutSpec(preset, paneIds))
  }

  const toggleWebLayoutAuthority = () => {
    clearLayoutTimers()
    paneLayoutCapacities.current.clear()
    setWebLayoutError('')
    if (webLayoutAuthoritative) {
      send({ type: 'release_all_resizes', requestId: requestId('layout-release') })
      setMaximizedPaneId(null)
      setFocusedPaneId(null)
      previousResizePaneId.current = null
    }
    setWebLayoutAuthoritative((current) => !current)
  }

  const refresh = () => {
    send({ type: 'refresh', requestId: requestId('refresh') })
    setPaletteOpen(false)
  }
  const tmuxCreateApi = createTmuxHttpApi(token)
  const paneManagementApi = createPaneManagementApi(token)
  const gitDiffApi = createGitDiffApi(token)

  const openPaneMenu = (paneId: string, x: number, y: number) => {
    setFocusedPaneId(paneId)
    setPaletteOpen(false)
    setPaneActionError('')
    setPaneMenu({ paneId, x, y })
  }

  const renamePane = async (paneId: string, title: string) => {
    await paneManagementApi.renamePane(paneId, title)
  }

  const splitPane = async (paneId: string, direction: PaneSplitDirection) => {
    const pane = paneMap.get(paneId)
    if (!pane || paneActionPending) return
    setPaneActionPending(true)
    setPaneActionError('')
    clearLayoutTimers()
    try {
      const before = direction === 'left' || direction === 'up'
      const created = await tmuxCreateApi.createPane({
        targetId: paneId,
        direction: direction === 'left' || direction === 'right' ? 'horizontal' : 'vertical',
        placement: before ? 'before' : 'after',
        cwd: pane.path,
      })
      setMaximizedPaneId(null)
      setPendingFocusPaneId(created.paneId)
    } catch (cause) {
      setPaneActionError(cause instanceof Error ? cause.message : 'Unable to split pane')
    } finally {
      setPaneActionPending(false)
    }
  }

  const killPane = async (paneId: string) => {
    const pane = paneMap.get(paneId)
    if (!pane || paneActionPending) return
    const label = pane.title || pane.command || `Pane ${pane.index}`
    if (!window.confirm(`Kill pane "${label}"? Its running process will be terminated.`)) return
    setPaneActionPending(true)
    setPaneActionError('')
    clearLayoutTimers()
    try {
      await paneManagementApi.deletePane(paneId)
      if (maximizedPaneId === paneId) setMaximizedPaneId(null)
      if (renamingPaneId === paneId) setRenamingPaneId(null)
    } catch (cause) {
      setPaneActionError(cause instanceof Error ? cause.message : 'Unable to kill pane')
    } finally {
      setPaneActionPending(false)
    }
  }

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
      detail: 'Restructure the tmux panes of every visible window now',
      kind: 'layout' as const,
      run: () => {
        for (const group of groups) restructureWindow(group.windowId, preset.id)
        setPaletteOpen(false)
      },
    })),
    ...THEMES.map((theme) => ({
      id: `theme:${theme.name}`,
      label: `Theme: ${theme.label}`,
      detail: theme.name === themeName ? 'Current color palette' : 'Switch color palette',
      kind: 'action' as const,
      run: () => {
        applyTheme(theme.name)
        setThemeName(theme.name)
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

  const disconnect = async () => {
    setSnapshot(null)
    if (token) {
      clearToken()
      setToken('')
      return
    }
    try {
      await signOut()
    } catch (cause) {
      console.error(cause)
    } finally {
      setAuthUser(null)
    }
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
  const contextPane = paneMenu ? paneMap.get(paneMenu.paneId) : undefined

  if (authPending && (!token || connection.phase === 'unauthorized')) {
    return (
      <main className="auth-screen">
        <div className="auth-ambient" aria-hidden="true" />
        <section className="auth-card" aria-labelledby="auth-title">
          <div className="auth-mark"><LoaderCircle className="spin" aria-hidden="true" /></div>
          <span className="eyebrow">Local authority only</span>
          <h1 id="auth-title">Checking this daemon.</h1>
          <p>Looking for an owner session and local authentication policy.</p>
        </section>
      </main>
    )
  }

  if ((!token && !authUser) || connection.phase === 'unauthorized') {
    return (
      <AuthGate
        bootstrap={authBootstrap ?? { enabled: false, needsOwner: false, ownerEmail: null }}
        initialError={authError}
        tokenRejected={Boolean(token && connection.phase === 'unauthorized')}
        onAuthenticated={(user) => {
          clearToken()
          setToken('')
          setSnapshot(null)
          setAuthUser(user)
          setAuthBootstrap((current) => current ? { ...current, needsOwner: false } : current)
        }}
        onToken={(nextToken) => {
          setSnapshot(null)
          setToken(nextToken)
        }}
      />
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
            className="icon-button auth-signout"
            onClick={() => void disconnect()}
            aria-label={token ? 'Disconnect automation token' : `Sign out ${authUser?.email ?? ''}`}
            title={token ? 'Disconnect automation token' : `Sign out ${authUser?.email ?? ''}`}
          >
            <LogOut aria-hidden="true" />
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
            className="icon-button mobile-panel-toggle sidebar-toggle"
            onClick={() => setLeftPanelOpen(true)}
            aria-label="Open session tree"
          >
            <SidebarOpen aria-hidden="true" />
          </button>
          <button
            type="button"
            className={`icon-button desktop-panel-toggle left-panel-visibility${leftPanelHidden ? ' is-collapsed' : ''}`}
            onClick={() => setLeftPanelHidden((current) => !current)}
            aria-label={leftPanelHidden ? 'Show session tree' : 'Hide session tree'}
            aria-pressed={!leftPanelHidden}
            title={leftPanelHidden ? 'Show session tree' : 'Hide session tree'}
          >
            <SidebarOpen aria-hidden="true" />
          </button>
          {area === 'workspace' ? <button
            type="button"
            className="icon-button mobile-panel-toggle hud-toggle"
            onClick={() => setRightPanelOpen(true)}
            aria-label="Open Agent HUD"
          >
            <PanelRightOpen aria-hidden="true" />
            {attentionCount ? <span className="attention-badge">{attentionCount}</span> : null}
          </button> : null}
          {area === 'workspace' ? <button
            type="button"
            className={`icon-button desktop-panel-toggle right-panel-visibility${rightPanelHidden ? ' is-collapsed' : ''}`}
            onClick={() => setRightPanelHidden((current) => !current)}
            aria-label={rightPanelHidden ? 'Show Agent HUD' : 'Hide Agent HUD'}
            aria-pressed={!rightPanelHidden}
            title={rightPanelHidden ? 'Show Agent HUD' : 'Hide Agent HUD'}
          >
            <PanelRightOpen aria-hidden="true" />
            {attentionCount ? <span className="attention-badge">{attentionCount}</span> : null}
          </button> : null}
        </div>
      </header>

      {connection.phase === 'reconnecting' ? (
        <div className="connection-banner" role="status">
          <WifiOff aria-hidden="true" />
          <span>{connection.detail}. Pane snapshots remain visible; input resumes after reconnect.</span>
          <strong>Attempt {connection.attempt}</strong>
        </div>
      ) : null}

      <div className={`cockpit-body area-${area}${leftPanelHidden ? ' left-panel-hidden' : ''}${rightPanelHidden ? ' right-panel-hidden' : ''}`}>
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
              onClick={() => { setLeftPanelOpen(false); setLeftPanelHidden(true) }}
              aria-label="Hide session tree"
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
            <button type="button" className={area === 'notes' ? 'active' : ''} aria-current={area === 'notes' ? 'page' : undefined} onClick={() => { setNotesMounted(true); setArea('notes'); setLeftPanelOpen(false) }}>
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
              displayedPaneIds={allVisiblePaneIds}
              statuses={agentStatuses}
              selectedSessionId={selectedSessionId}
              focusedPaneId={focusedPaneId}
              onSelectSession={selectSession}
              onSelectWindow={jumpToGroup}
              onSelectPane={jumpToPane}
              onOpenPaneMaximized={openPaneMaximized}
              onWindowDeleting={clearLayoutTimers}
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
          <PortsSection sessions={snapshot?.sessions ?? []} ports={snapshot?.ports ?? []} />
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
              <h1
                title={activeWindow
                  ? `Active window ${activeWindow.index}: ${activeWindow.name} / ${groups.length} groups / ${allVisiblePaneIds.length} visible panes`
                  : undefined}
              >
                {selectedSession?.name ?? 'Waiting for tmux'}
              </h1>
              {groups.length > 1 ? (
                <nav className="window-strip" aria-label="Jump to window">
                  {groups.map((group) => {
                    const window = windowMap.get(group.windowId)
                    const focusedInGroup = focusedPaneId !== null && group.paneIds.includes(focusedPaneId)
                    const active = focusedPaneId ? focusedInGroup : activeWindow?.id === group.windowId
                    return (
                      <button
                        type="button"
                        className={active ? 'active' : ''}
                        onClick={() => jumpToGroup(group.windowId)}
                        title={`Scroll to ${group.name}`}
                        key={group.id}
                      >
                        {window ? `${window.index} ${group.name}` : group.name}
                      </button>
                    )
                  })}
                </nav>
              ) : null}
            </div>
            <div className="workspace-actions">
              <label
                className={`web-layout-toggle${webLayoutAuthoritative ? ' active' : ''}${webLayoutError ? ' has-error' : ''}`}
                title={webLayoutError || 'Keep tmux window geometry synchronized with the web workspace until unchecked'}
              >
                <input
                  type="checkbox"
                  checked={webLayoutAuthoritative}
                  disabled={!connected || !selectedSession}
                  onChange={toggleWebLayoutAuthority}
                />
                <span>Web owns tmux</span>
              </label>
              {selectedWorkspace ? (
                <span className="save-state saved"><ShieldCheck aria-hidden="true" /> Saved groups</span>
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
              const windowTree = window ? parseWindowLayout(window.layout) : null
              const visibleTree = windowTree
                ? filterLayoutTree(windowTree, new Set(visibleGroupPanes.map((pane) => pane.id)))
                : null
              const leafPaneIds = windowTree
                ? layoutTreePanes(windowTree).map((leaf) => leaf.paneId)
                : []
              const measurementKey = windowTree
                ? [
                    group.id,
                    layoutShapeKey(windowTree),
                    maximizedPaneId ?? 'grid',
                    webLayoutAuthoritative ? 'authoritative' : 'focused',
                  ].join(':')
                : ''
              return (
                <section className="pane-group" data-group-id={group.id} key={group.id}>
                  <header className="group-head">
                    <div className="group-title">
                      <span>{window ? `Window ${window.index}` : 'Saved group'}</span>
                      <h2>{group.name}</h2>
                      <p>{groupPanes.length} panes</p>
                    </div>
                    <div className="layout-controls" role="group" aria-label={`Restructure ${group.name}`}>
                      {PRESETS.map((preset) => (
                        <button
                          type="button"
                          onClick={() => restructureWindow(group.windowId, preset.id)}
                          disabled={!connected || !windowTree}
                          aria-label={preset.label}
                          title={`${preset.label} — restructure panes now`}
                          key={preset.id}
                        >
                          {preset.icon}
                        </button>
                      ))}
                    </div>
                  </header>
                  {visibleTree && visibleGroupPanes.length ? (
                    <ResizablePaneLayout
                      key={`${group.id}:${maximizedPaneId ?? 'grid'}`}
                      layoutKey={webLayoutAuthoritative
                        // The DOM owns geometry while authoritative: only a shape
                        // change may discard local splitter weights, else the echo
                        // of an in-flight apply undoes a fresh drag.
                        ? `shape:${layoutShapeKey(visibleTree)}`
                        : window?.layout ?? ''}
                      tree={visibleTree}
                      onCommit={() => commitWindowLayout(group.windowId)}
                      panes={new Map(visibleGroupPanes.map((pane) => [
                        pane.id,
                        <TerminalPaneCard
                          key={pane.id}
                          pane={pane}
                          status={agentStatuses[pane.id]}
                          index={leafPaneIds.indexOf(pane.id)}
                          count={leafPaneIds.length}
                          maximized={maximizedPaneId === pane.id}
                          focused={focusedPaneId === pane.id}
                          resizeOwner={
                            activeResizePaneId === pane.id ||
                            (webLayoutAuthoritative && !maximizedPaneId)
                          }
                          measurementKey={measurementKey}
                          connected={connected}
                          renaming={renamingPaneId === pane.id}
                          gitApi={gitDiffApi}
                          onFocus={() => setFocusedPaneId(pane.id)}
                          onOpenMenu={(x, y) => openPaneMenu(pane.id, x, y)}
                          onRename={(title) => renamePane(pane.id, title)}
                          onRenameFinished={() => setRenamingPaneId((current) => current === pane.id ? null : current)}
                          onMove={(direction) => {
                            clearLayoutTimers()
                            movePane(group.windowId, pane.id, direction)
                          }}
                          onMaximize={() => {
                            clearLayoutTimers()
                            setFocusedPaneId(pane.id)
                            setMaximizedPaneId((current) => current === pane.id ? null : pane.id)
                          }}
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
                            clearLayoutTimers()
                            dropPane(group.windowId, group.id, pane.id)
                          }}
                          onInput={(data) => sendPaneInput(pane.id, data)}
                          onKey={(key) => sendPaneKey(pane.id, key)}
                          onPaste={(data) => sendPanePaste(pane.id, data)}
                          onResize={(cols, rows) => sendPaneResize(
                            group.windowId,
                            pane.id,
                            measurementKey,
                            cols,
                            rows,
                          )}
                          registerSink={registerTerminalSink}
                          registerFocusable={registerFocusable}
                        />,
                      ]))}
                    />
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
          </> : area === 'linear' ? <LinearSection token={token} /> : null}
          {notesMounted ? (
            <Suspense fallback={<section className="workspace-empty"><LoaderCircle className="spin" /><p>Opening Markdown vault...</p></section>}>
              <NotesSection token={token} isActive={area === 'notes'} />
            </Suspense>
          ) : null}
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
              onClick={() => { setRightPanelOpen(false); setRightPanelHidden(true) }}
              aria-label="Hide Agent HUD"
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

      {paneActionError ? (
        <div className="pane-action-error" role="alert">
          <span>{paneActionError}</span>
          <button type="button" onClick={() => setPaneActionError('')} aria-label="Dismiss pane action error">
            <X aria-hidden="true" />
          </button>
        </div>
      ) : null}

      {paneMenu && contextPane ? (
        <PaneContextMenu
          paneLabel={contextPane.title || contextPane.command || `Pane ${contextPane.index}`}
          x={paneMenu.x}
          y={paneMenu.y}
          busy={paneActionPending || !connected}
          onClose={() => setPaneMenu(null)}
          onRename={() => setRenamingPaneId(paneMenu.paneId)}
          onSplit={(direction) => { void splitPane(paneMenu.paneId, direction) }}
          onKill={() => { void killPane(paneMenu.paneId) }}
        />
      ) : null}

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
