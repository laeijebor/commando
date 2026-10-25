import { commanderInbox } from './commanderInbox'
import { GROUP_ORDER } from './chat/AgentsInbox'
import { CommanderTranscriptView, type CommanderPeek } from './chat/CommanderReadingPane'
import { createCommanderApi } from './commanderApi'
import { initialCommanderClientState, reduceCommanderMessage } from './commanderClientState'
import { isSessionName } from '../shared/session-identity'
import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Bookmark,
  Bot,
  Check,
  CircleDotDashed,
  Archive,
  Code2,
  FolderX,
  Pencil,
  RotateCcw,
  Trash2,
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
  Settings,
  Smartphone,
  Terminal,
  UserRound,
  WifiOff,
  X,
} from 'lucide-react'
import {

  type CSSProperties,
  type DragEvent,
  type FormEvent,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  type TransitionEvent,
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react'

import type {
  AgentInteractionAnswer,
  AgentInteractionRequest,
  AgentStatus,
  CommandoSnapshot,
  LayoutSpec,
  PaneLayoutCapacity,
  PaneMark,
  AgentResume,
  PaneMarkTone,
  SavedWorkspace,
  ServerMessage,
  SessionBrief,
  SessionIde,
  SpecialKey,
  TmuxPane,
  WebPane,
  WebPaneEngine,
  WebPaneFeedbackInfo,
  WebPaneNavigateRequest,
  ClientMessage,
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
  resolveActiveGroup,
  type GroupLayoutPreset,
} from './layout'
import { decodeBase64Bytes, PaneStreamRegistry, type PaneTerminalSink } from './paneStream'
import { dispatchBoundedPaste } from './terminalInput'
import { THEMES, activeTheme, applyTheme, onThemeChange, storedTheme, type ThemeName } from './theme'
import { type ConnectionPhase, useDaemon } from './useDaemon'
import { TerminalPaneRenderer, type TerminalRendererKind } from './TerminalPaneRenderer'
import { LinearSection } from './LinearSection'
import { PrsSection } from './PrsSection'
import { GitDiffView } from './GitDiffView'
import { ResizablePaneLayout } from './ResizablePaneLayout'
import { createAgentProfilesApi } from './agentProfilesApi'
import { SessionTree, type SessionActions } from './SessionTree'
import { auxiliarySessionIds } from '../shared/auxiliary-session'
import { ARCHIVE_RESTORE_NOTE, sessionProcesses, sessionProcessesWarning } from './sessionProcesses'
import type { AgentChatRequest } from '../shared/agent-chats'
import { AgentChatRequestCard } from './AgentChatRequestCard'
import { PaneAttributionToast, usePaneAttribution } from './PaneAttributionToast'
import { createAgentChatsApi } from './agentChatsApi'
import type { LineageSnapshot } from './chatLineage'
import { SessionIdeView } from './SessionIdeView'
import { createSessionIdesApi } from './sessionIdesApi'
import { createTmuxHttpApi } from './tmuxCreateApi'
import { createChatConversationsApi } from './chatConversationsApi'
import { ConversationPicker } from './ConversationPicker'
import { PanePaletteMenu, panePaletteEntries, type PanePaletteScreen } from './PanePalette'
import { McpSettings } from './McpSettings'
import type { ChatMcpRequest, ChatMcpResult } from '../shared/chat-mcp'
import { providerLabel } from '../shared/chat-composer'
import { chatConversationKey } from '../shared/chat-conversations'
import { PaneContextMenu, type PaneSplitDirection } from './PaneContextMenu'
import { createPaneManagementApi, type PaneManagementApiClient } from './paneManagementApi'
import { PANE_MARK_PRESETS } from './paneMarks'
import { createWebPanesApi } from './webPanesApi'
import { WebPaneCard } from './WebPaneCard'
import { SidePanel, type PanePanelData } from './SidePanel'
import { CommanderPeekTabs } from './CommanderPeekTabs'
import { activePanelTab, builtinPanelTab, openedPanelTabs, effectiveFocusedPane, NARROW_PANEL_QUERY, isNarrowPanel, isBuiltinTab, panelTabKey, panelTabs, resolveActivePanelTab, type BuiltinPanelTab, type PanelTab } from './sidePanelState'
import { parsePrPanelKey, prPanelKey, type BuiltinPanelKey, neighbouringTab } from '../shared/web-pane-placement'
import { dropPlacementFor, type DraggedItem } from './paneDrag'
import {
  insertWebPaneLeaves,
  isWebPaneLeafId,
} from './webPaneLayout'
import { createGitDiffApi, type GitDiffApiClient } from './gitApi'
import { createPrsApi, type PrsApiClient, type PrSummary } from './prsApi'
import type { PrQuickLookTab } from './PrQuickLook'
import { cachedPanePrs, refreshPanePrs } from './prStore'
import { PaneGitStats } from './PaneGitStats'
import { PanePathMenu } from './PanePathMenu'
import { openPortUrl, PortsSection } from './PortsSection'
import { AgentHudCard, type AgentHudAnswerState } from './AgentHudCard'
import { HudPinnedNote } from './HudPinnedNote'
import { PaneWorklog } from './PaneWorklog'
import { ChatPane, type ChatFlowServices } from './chat/ChatPane'
import { ChatStashContext, createChatStashApi, type ChatStash } from './chat/chatStash'
import { PlanUsageContext, newestPlanUsage } from './chat/planUsage'
import { MAX_PANE_PROMPT_BYTES, implementPlanFilePrompt, launchPermissionMode } from './chat/turnFlow'
import { CHAT_SEND_REFUSAL_MS, type ChatDraft, type ChatInputServices, type ChatSendError } from './chat/ChatComposer'
import { PaneAgentSwitch, paneChatHandoff } from './PaneAgentSwitch'
import { openPullRequestsForPane, saveChatPlan, stashChatPlan, uploadChatImage, uploadChatVideo } from './chatInputApi'
import { loadChatLaunch } from './chatLaunchPreferences'
import { chatLaunchPermission, chatProfileConfigDir, type SessionAgentLaunch } from '../shared/tmux-create'
import { EmptyPane, type EmptyPaneChoice } from './EmptyPane'
import {
  hostTakesMcp,
  hostTakesSwitch,
  mergeChatItems,
  planImplementationPrompt,
  type ExternalAgentRun,
  type ChatAnswer,
  type ChatFileSearchResult,
  type ChatHandoffInfo,
  type ChatImageRef,
  type ChatSendOptions,
  type ChatSessionPermissionMode,
  type ChatSettingsChange,
  type ChatState,
  type ChatSubagentTranscript,
  type ChatSwitchAction,
  type ChatProvider,
  providerTuiLabel,
} from '../shared/agent-chat'
import type { ChatCardEvent } from '../shared/chat-tile-events'
import type { ChatStashEntry } from '../shared/chat-stash'
import { createSimsApi, type SimsApiClient } from './simsApi'
import { PaneScreenshotLightbox, type PaneScreenshotLightboxRequest } from './PaneScreenshotLightbox'
import { createPaneScreenshotsApi, type PaneScreenshotsApiClient } from './paneScreenshotsApi'
import { createNotesApi } from './notesApi'
import { pinnedNoteFrom, storePinnedNote, storedPinnedNote, type NoteRequest, type PinnedNote } from './pinnedNote'
import {
  agentHudGroups,
  agentNeedsAttention,
  filterAgentHudGroups,
  storedAgentHudDismissals,
  storeAgentHudDismissals,
  type AgentHudDismissals,
  type AgentHudFilter,
} from './agentHud'
import { createSessionManagementApi, type SessionTreePreferences } from './sessionManagementApi'
import { EMPTY_SESSION_TREE_PREFERENCES } from './sessionTreePreferences'
import { getNativeTerminalBridge, NATIVE_TERMINAL_SHORTCUT_EVENT } from './nativeTerminalBridge'
import { useDesktopWindowActivity } from './desktopWindowActivity'
import { paneAttention, paneAttentionLabels } from './sessionIndicator'
import { SessionTokenBroker } from './sessionTokenBroker'
import { clearToken, getInitialToken, storeToken } from './sessionTokenStorage'
import { getNativeWindowBridge, useDetachedWebPaneIds } from './nativeWindowBridge'
import {
  createOwner,
  getAuthBootstrap,
  getAuthUser,
  signInWithEmail,
  signOut,
  type AuthBootstrap,
  type AuthUser,
} from './authClient'

const PrPanel = lazy(() => import('./PrPanel').then((module) => ({ default: module.PrPanel })))

const RESPONSIVE_DRAWER_OCCLUSION_FALLBACK_MS = 250
export const PANE_JUMP_HIGHLIGHT_MS = 1600
export const PR_PANE_LOOKUP_TIMEOUT_MS = 5_000

const NotesSection = lazy(() => import('./NotesSection').then((module) => ({ default: module.NotesSection })))
const SimsView = lazy(() => import('./SimsView').then((module) => ({ default: module.SimsView })))
const SettingsView = lazy(() => import('./SettingsView').then((module) => ({ default: module.SettingsView })))

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

const LEFT_PANEL_HIDDEN_STORAGE_KEY = 'commando.panel.left-hidden'
const LEFT_PANEL_WIDTH_STORAGE_KEY = 'commando.panel.left-width'
const LEFT_PANEL_DEFAULT_WIDTH = 230
const LEFT_PANEL_MIN_WIDTH = 180
const LEFT_PANEL_MAX_WIDTH = 480
const RIGHT_PANEL_HIDDEN_STORAGE_KEY = 'commando.panel.right-hidden'
const HUD_TAB_STORAGE_KEY = 'commando.hud.tab'

type HudTab = 'agents' | 'prs'

function storedHudTab(): HudTab {
  try {
    return window.localStorage.getItem(HUD_TAB_STORAGE_KEY) === 'prs' ? 'prs' : 'agents'
  } catch {
    return 'agents'
  }
}

function storeHudTab(tab: HudTab): void {
  try {
    window.localStorage.setItem(HUD_TAB_STORAGE_KEY, tab)
  } catch {
    // Tab selection still works in memory when storage is unavailable.
  }
}
export const RESIZE_LEASE_RETRY_LIMIT = 12
export const RESIZE_LEASE_RETRY_MAX_DELAY_MS = 1_000

type PaneRendererControl = {
  identity: string
  actual: TerminalRendererKind
  manualXterm: boolean
  retryKey: number
}

function paneRendererIdentity(pane: TmuxPane): string {
  return JSON.stringify([pane.targetId, pane.sessionId, pane.windowId, pane.id, pane.processId ?? null])
}

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

function storedLeftPanelWidth(): number {
  try {
    const raw = window.localStorage.getItem(LEFT_PANEL_WIDTH_STORAGE_KEY)
    if (raw === null) return LEFT_PANEL_DEFAULT_WIDTH
    const value = Number(raw)
    return Number.isFinite(value) ? Math.max(LEFT_PANEL_MIN_WIDTH, Math.min(LEFT_PANEL_MAX_WIDTH, value)) : LEFT_PANEL_DEFAULT_WIDTH
  } catch {
    return LEFT_PANEL_DEFAULT_WIDTH
  }
}

function storeLeftPanelWidth(width: number): void {
  try {
    window.localStorage.setItem(LEFT_PANEL_WIDTH_STORAGE_KEY, String(width))
  } catch {
    // The width remains adjustable when storage is unavailable.
  }
}

let requestSequence = 0

function requestId(prefix: string) {
  requestSequence += 1
  return `${prefix}-${Date.now()}-${requestSequence}`
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
  lineageSnapshot?: LineageSnapshot
  lineageStatuses?: Record<string, AgentStatus>
  commander?: Parameters<typeof ChatPane>[0]['commander']
  onSelectPane?: (id: string) => void
  attributionVisible?: boolean
  agentChatRequests?: AgentChatRequest[]
  /** Shown over this pane only, such as the ⌘P conversation picker. */
  overlay?: ReactNode
  onAnswerAgentChatRequest?: (id: string, decision: 'accepted' | 'dismissed') => Promise<void>
  status?: AgentStatus
  brief?: SessionBrief
  panelTabs?: WebPane[]
  panelTrigger?: ReactNode
  mark?: PaneMark
  resume?: AgentResume
  index: number
  count: number
  solo: boolean
  maximized: boolean
  focused: boolean
  jumpHighlighted: boolean
  resizeOwner: boolean
  measurementKey: string
  connected: boolean
  renaming: boolean
  nativeRetryKey: number
  useXtermFallback: boolean
  gitApi: GitDiffApiClient
  prsApi?: PrsApiClient
  screenshotsApi?: PaneScreenshotsApiClient
  simsApi?: SimsApiClient
  onShowSimulator?: (udid: string) => void
  paneManagementApi?: PaneManagementApiClient
  revealInFinder?: boolean
  onOpenPath: () => Promise<void>
  onOpenScreenshot?: (request: Omit<PaneScreenshotLightboxRequest, 'paneId'>) => void
  onFocus: () => void
  onOpenChanges?: () => void
  onOpenMenu: (x: number, y: number) => void
  onAcknowledgeMark?: () => void
  onRetryResume?: () => void
  /** Set when an agent host drives this pane: the card can show a chat instead of the terminal. */
  chat?: ChatState
  externalRuns?: readonly ExternalAgentRun[]
  tileEvents?: readonly ChatCardEvent[]
  onOpenTile?: (webPaneId: string) => boolean
  chatView?: 'chat' | 'terminal'
  onChatView?: (view: 'chat' | 'terminal') => void
  onChatSend?: (text: string, images?: ChatImageRef[], options?: ChatSendOptions) => string | void
  onChatInterrupt?: (dropQueued?: string[]) => void
  onChatAnswer?: (requestId: string, answer: ChatAnswer) => void
  onChatConfigure?: (change: ChatSettingsChange) => void
  onChatRestart?: () => void
  onChatOpenPr?: (repo: string, number: number, tab: PrQuickLookTab) => void
  chatServices?: ChatInputServices
  chatFlow?: ChatFlowServices
  /** Why the daemon refused one of this pane's chat sends. */
  chatSendError?: ChatSendError
  onDismissChatSendError?: () => void
  /** Why the daemon refused a queue, subagent or interrupt action in this pane. */
  chatActionError?: string
  onDismissChatActionError?: () => void
  /** The pane runs Claude Code on a conversation that started as a chat. */
  claudeCodeFromChat?: boolean
  handoffProvider?: ChatProvider
  /** The chat's composer has an image still uploading. */
  chatUploading?: boolean
  onSwitchToClaudeCode?: () => void
  onReturnToChat?: () => void
  onRename: (title: string) => Promise<void>
  onRenameFinished: () => void
  onMove: (direction: -1 | 1) => void
  onMaximize: () => void
  onClose: () => void
  closeDisabled?: boolean
  onDragStart: (event: DragEvent<HTMLElement>) => void
  onDragEnd: () => void
  onDragOver: (event: DragEvent<HTMLElement>) => void
  onDragLeave: () => void
  onDrop: (event: DragEvent<HTMLElement>) => void
  dropPreview: 'right' | 'below' | null
  onInput: (data: string) => void
  onInputBytes: (data: string) => void
  onKey: (key: SpecialKey) => void
  onPaste: (data: string) => void
  onResize: (cols: number, rows: number) => void
  onRequestReset: () => void
  onRendererChange: (renderer: TerminalRendererKind) => void
  registerSink: (paneId: string, sink: PaneTerminalSink) => () => void
  registerFocusable: (paneId: string, node: HTMLElement | null) => void
}

/** What clicking Claude Code in a chat's header does, or why it can't. */
function claudeCodeSwitchTitle(chat: ChatState): string {
  if (chat.session.provider === 'cursor') return 'Cursor chat does not support switching to a terminal UI'
  const label = providerTuiLabel(chat.session.provider)
  if (!chat.hostConnected) return 'The agent host is disconnected'
  if (!hostTakesSwitch(chat.session)) return `This chat started before switching to ${label}; restart it to switch`
  if (!chat.session.sessionId) return `Send a message first: ${label} resumes a conversation`
  if (chat.session.claudeCodeSwitch) return `Switching to ${label}…`
  const running = chat.session.status === 'running' || chat.session.status === 'waiting'
  return running
    ? `Continue in ${label}, in this pane, when this turn ends`
    : `Continue this conversation in ${label}, in this pane`
}

export function TerminalPaneCard({
  pane,
  lineageSnapshot,
  lineageStatuses = {},
  commander,
  onSelectPane,
  attributionVisible,
  agentChatRequests = [],
  overlay,
  onAnswerAgentChatRequest,
  status,
  brief: suppliedBrief,
  panelTabs: paneTabs = [],
  panelTrigger,
  mark,
  index,
  count,
  solo,
  maximized,
  focused,
  jumpHighlighted,
  resizeOwner,
  measurementKey,
  connected,
  renaming,
  nativeRetryKey,
  useXtermFallback,
  gitApi,
  prsApi,
  onOpenPath,
  onFocus,
  onOpenChanges,
  onOpenMenu,
  onAcknowledgeMark,
  chat,
  externalRuns,
  tileEvents,
  onOpenTile,
  chatView = 'chat',
  onChatView,
  onChatSend,
  onChatInterrupt,
  onChatAnswer,
  onChatConfigure,
  onChatRestart,
  onChatOpenPr,
  chatServices,
  chatFlow,
  chatSendError,
  onDismissChatSendError,
  chatActionError,
  onDismissChatActionError,
  claudeCodeFromChat = false,
  handoffProvider,
  chatUploading = false,
  onSwitchToClaudeCode,
  onReturnToChat,
  onRename,
  onRenameFinished,
  onMove,
  onMaximize,
  onClose,
  closeDisabled,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDragLeave,
  onDrop,
  dropPreview,
  onInput,
  onInputBytes,
  onKey,
  onPaste,
  onResize,
  onRequestReset,
  onRendererChange,
  registerSink,
  registerFocusable,
}: TerminalPaneProps) {
  const paneLabel = pane.title || pane.command || `Pane ${pane.index}`
  // The header is on screen, so a finished turn here reads as seen.
  const headerAttention = status ? paneAttention(status, Number.POSITIVE_INFINITY) : null
  const showChat = Boolean(chat) && chatView === 'chat'
  const brief = suppliedBrief && (!suppliedBrief.targetId || suppliedBrief.targetId === pane.targetId) ? suppliedBrief : undefined
  const renameInputRef = useRef<HTMLInputElement>(null)
  const [renameValue, setRenameValue] = useState(paneLabel)
  const [renamePending, setRenamePending] = useState(false)
  const [renameError, setRenameError] = useState('')
  const [pathActionState, setPathActionState] = useState<'idle' | 'copied' | 'copy-failed' | 'opened' | 'open-failed'>('idle')
  const [pathMenu, setPathMenu] = useState<{ x: number; y: number } | null>(null)
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
      setPathActionState('copied')
    } catch {
      setPathActionState('copy-failed')
    }
    pathCopyResetTimer.current = setTimeout(() => setPathActionState('idle'), 1500)
  }

  const openPath = async () => {
    clearTimeout(pathCopyResetTimer.current)
    try {
      await onOpenPath()
      setPathActionState('opened')
    } catch {
      setPathActionState('open-failed')
    }
    pathCopyResetTimer.current = setTimeout(() => setPathActionState('idle'), 1500)
  }

  const showSelectionCopied = () => {
    clearTimeout(selectionCopyResetTimer.current)
    setSelectionCopied(true)
    selectionCopyResetTimer.current = setTimeout(() => setSelectionCopied(false), 1500)
  }

  return (
    <article
      className={`terminal-pane${focused ? ' is-focused' : ''}${jumpHighlighted ? ' is-jump-highlighted' : ''}${maximized ? ' is-maximized' : ''}${solo ? ' is-solo' : ''}${mark ? ` has-pane-mark tone-${mark.tone}` : ''}${mark?.activityCount ? ' has-pane-mark-activity' : ''}`}
      onPointerDownCapture={(event) => { if (!(event.target as Element).closest('[data-panel-chip]')) onFocus() }}
      onFocusCapture={(event) => { if (!(event.target as Element).closest('[data-panel-chip]')) onFocus() }}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
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
          <small title={brief?.headline || pane.command || pane.path}>{brief?.headline || pane.command || pane.path}</small>
        </span>
        {panelTrigger ?? (paneTabs.length > 0 && <span className={`pane-tab-count${paneTabs.some((tab) => tab.unseen) ? ' has-new' : ''}`}>
          {paneTabs.length}<span className="pane-tab-count-detail"> {paneTabs.length === 1 ? 'tab' : 'tabs'}{paneTabs.some((tab) => tab.unseen) ? ` · ${paneTabs.filter((tab) => tab.unseen).length} new` : ''}</span>
        </span>)}
        {pane.dead ? <span className="pane-state dead">Dead</span> : null}
        {headerAttention ? <span className={`pane-state ${headerAttention}`}>{paneAttentionLabels[headerAttention]}</span> : null}
        {mark ? (
          <span className={`pane-mark-chip tone-${mark.tone}`} title={`Pane status: ${mark.label}`}>
            <Bookmark aria-hidden="true" />
            <span>{mark.label}</span>
          </span>
        ) : null}
        <span className="pane-index">{pane.index}</span>
        {chat || claudeCodeFromChat ? (
          <PaneAgentSwitch
            mode={chat ? 'chat' : 'claude-code'}
            provider={chat?.session.provider ?? handoffProvider ?? 'claude'}
            hostLogShown={Boolean(chat) && !showChat}
            chatDisabled={!chat && !connected}
            claudeCodeDisabled={!connected || !chat?.hostConnected || !chat || !hostTakesSwitch(chat.session) || !chat.session.sessionId || Boolean(chat.session.claudeCodeSwitch) || chatUploading}
            {...(chat ? { claudeCodeTitle: chatUploading ? 'Waiting for image upload…' : claudeCodeSwitchTitle(chat) } : {})}
            onChat={() => (chat ? onChatView?.('chat') : onReturnToChat?.())}
            onClaudeCode={() => onSwitchToClaudeCode?.()}
          />
        ) : null}
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
          <button
            type="button"
            className="icon-button compact"
            onClick={onClose}
            disabled={closeDisabled || !connected}
            aria-label={`Close ${paneLabel}`}
            aria-keyshortcuts="Meta+W"
            title="Kill pane (⌘W)"
          >
            <X aria-hidden="true" />
          </button>
        </span>
      </header>
      {dropPreview && (
        <div
          className={`pane-drop-preview is-${dropPreview}`}
          data-native-terminal-occluder=""
          aria-hidden="true"
        />
      )}
      {!showChat && chatActionError ? (
        <div className="pane-chat-alert" role="alert">
          <span>{chatActionError}</span>
          <button type="button" className="icon-button compact" aria-label="Dismiss" onClick={onDismissChatActionError}>
            <X aria-hidden="true" />
          </button>
        </div>
      ) : null}
      {mark?.activityCount ? (
        <button
          type="button"
          className="pane-mark-alarm"
          onClick={onAcknowledgeMark}
          aria-live="polite"
          aria-atomic="true"
          aria-label={`Acknowledge ${mark.activityCount} ${mark.activityCount === 1 ? 'activity' : 'activities'} since ${mark.label} was applied`}
          title="Acknowledge activity and keep the pane status"
        >
          <Activity aria-hidden="true" />
          <strong>Activity since mark</strong>
          <span><b>{mark.activityCount}</b>{mark.lastActivityAt ? <time dateTime={new Date(mark.lastActivityAt).toISOString()}> · {displayTime(mark.lastActivityAt)}</time> : null}</span>
        </button>
      ) : null}
      <div className="terminal-pane-body">
        {showChat && chat ? (
          <ChatPane
            paneId={pane.id}
            registerFocusable={registerFocusable}
            pane={pane}
            snapshot={lineageSnapshot}
            statuses={lineageStatuses}
            commander={commander}
            onSelectPane={onSelectPane}
            {...(prsApi ? { prsApi } : {})}
            chat={chat}
            externalRuns={externalRuns}
            {...(tileEvents ? { tileEvents } : {})}
            {...(onOpenTile ? { onOpenTile } : {})}
            connected={connected}
            focused={focused}
            onFocus={onFocus}
            onSelectionCopied={showSelectionCopied}
            onSend={(text, images, options) => onChatSend?.(text, images, options)}
            onInterrupt={(dropQueued) => onChatInterrupt?.(dropQueued)}
            onAnswer={(requestId, answer) => onChatAnswer?.(requestId, answer)}
            onConfigure={(change) => onChatConfigure?.(change)}
            {...(onChatRestart ? { onRestart: onChatRestart } : {})}
            {...(onChatOpenPr ? { onOpenPr: onChatOpenPr } : {})}
            {...(chatServices ? { services: chatServices } : {})}
            {...(chatFlow ? { flow: chatFlow } : {})}
            {...(chatSendError ? { sendError: chatSendError } : {})}
            {...(onDismissChatSendError ? { onDismissSendError: onDismissChatSendError } : {})}
            {...(chatActionError ? { actionError: chatActionError } : {})}
            {...(onDismissChatActionError ? { onDismissActionError: onDismissChatActionError } : {})}
          />
        ) : <TerminalPaneRenderer
          paneId={pane.id}
          cols={pane.width}
          rows={pane.height}
          terminalState={pane}
          connected={connected}
          resizeOwner={resizeOwner}
          measurementKey={measurementKey}
          ariaLabel={`${pane.title || `Pane ${pane.index}`} terminal input${connected ? '' : ', disconnected'}`}
          order={index}
          nativeRetryKey={nativeRetryKey}
          useXtermFallback={useXtermFallback}
          onFocus={onFocus}
          onInput={onInput}
          onInputBytes={onInputBytes}
          onOpenMenu={(x, y) => {
            onFocus()
            onOpenMenu(x, y)
          }}
          onKey={onKey}
          onPaste={onPaste}
          onSelectionCopied={showSelectionCopied}
          onResize={onResize}
          onRequestReset={onRequestReset}
          onRendererChange={onRendererChange}
          registerSink={registerSink}
          registerFocusable={registerFocusable}
        />}

        {attributionVisible && lineageSnapshot ? <PaneAttributionToast pane={pane} snapshot={lineageSnapshot} statuses={lineageStatuses} /> : null}
        {onAnswerAgentChatRequest && agentChatRequests.length ? <div className="agent-chat-requests">
          {agentChatRequests.map((request) => <AgentChatRequestCard key={request.id} request={request} onAnswer={onAnswerAgentChatRequest} />)}
        </div> : null}
      </div>
      {overlay}
      <footer className="pane-footer">
        <span className={`input-indicator${connected && focused ? ' live' : ''}`} />
        <span className="pane-footer-focus">{!connected ? 'Read only while offline' : focused ? 'Focused / keys go here' : 'Click to focus'}</span>
        <span className="pane-footer-dimensions">{pane.width}x{pane.height}</span>
        <PaneGitStats paneId={pane.id} panePath={pane.path} api={gitApi} connected={connected} onOpenChanges={() => { onFocus(); onOpenChanges?.() }} />
        <button
          type="button"
          className="pane-path"
          data-action-state={pathActionState}
          onClick={(event) => {
            const bounds = event.currentTarget.getBoundingClientRect()
            setPathMenu({ x: bounds.right - 132, y: bounds.bottom + 4 })
          }}
          aria-haspopup="menu"
          aria-expanded={pathMenu !== null}
          aria-label={`Path actions for ${pane.path}`}
          title={pathActionState === 'copied'
            ? 'Copied path'
            : pathActionState === 'copy-failed'
              ? 'Unable to copy path'
              : pathActionState === 'opened'
                ? 'Opened folder in Finder'
                : pathActionState === 'open-failed'
                  ? 'Unable to open folder in Finder'
                  : `Path actions: ${pane.path}`}
        >
          <span className="pane-path-status" aria-live="polite">
            {pathActionState === 'copied'
              ? 'Copied'
              : pathActionState === 'copy-failed'
                ? 'Copy failed'
                : pathActionState === 'opened'
                  ? 'Opened'
                  : pathActionState === 'open-failed'
                    ? 'Open failed'
                    : null}
          </span>
          <span className="pane-path-value">{pane.path}</span>
        </button>
      </footer>
      {pathMenu ? (
        <PanePathMenu
          path={pane.path}
          x={pathMenu.x}
          y={pathMenu.y}
          onClose={() => setPathMenu(null)}
          onCopy={() => void copyPath()}
          onOpen={() => void openPath()}
        />
      ) : null}
      {selectionCopied ? (
        <div
          className="terminal-copy-toast"
          role="status"
          aria-live="polite"
          data-native-terminal-occluder=""
        >
          <Check aria-hidden="true" />
          <span>Copied</span>
        </div>
      ) : null}
    </article>
  )
}

export function PaneActionErrorFeedback({
  message,
  onDismiss,
}: {
  message: string
  onDismiss: () => void
}) {
  return (
    <div className="pane-action-error" role="alert" data-native-terminal-occluder="">
      <span>{message}</span>
      <button type="button" onClick={onDismiss} aria-label="Dismiss pane action error">
        <X aria-hidden="true" />
      </button>
    </div>
  )
}

type PaletteCommand = {
  id: string
  label: string
  detail: string
  kind: 'pane' | 'session' | 'action' | 'layout'
  run: () => void
}

/**
 * Reads a URL out of the palette query so typing one offers "open as a web
 * tile". Accepts full http(s) URLs, bare localhost/loopback hosts, and the
 * `:5173` port shorthand.
 */
export function webPaneUrlFromQuery(query: string): string | null {
  const trimmed = query.trim()
  if (!trimmed || /\s/.test(trimmed)) return null
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      return new URL(trimmed).toString()
    } catch {
      return null
    }
  }
  if (/^:\d+/.test(trimmed)) return webPaneUrlFromQuery(`http://localhost${trimmed}`)
  if (/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(trimmed)) {
    return webPaneUrlFromQuery(`http://${trimmed}`)
  }
  return null
}

export function runCommandFromQuery(query: string): string | null {
  const match = /^run\s+(.+)$/i.exec(query.trim())
  const command = match?.[1]?.trim()
  return command || null
}

type CommandoArea = 'workspace' | 'ide' | 'linear' | 'notes' | 'sims' | 'settings'

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
  const desktopWindowActive = useDesktopWindowActivity()
  const [narrowPanel, setNarrowPanel] = useState(() => isNarrowPanel(window.matchMedia(NARROW_PANEL_QUERY)))
  const [openDrawers, setOpenDrawers] = useState<Record<string, boolean>>({})
  useEffect(() => {
    const media = window.matchMedia(NARROW_PANEL_QUERY)
    const onChange = () => setNarrowPanel(isNarrowPanel(media))
    onChange()
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  }, [])
  useEffect(() => { setOpenDrawers({}) }, [narrowPanel])
  const nativeWindowBridge = getNativeWindowBridge()
  const detachedWebPaneIds = useDetachedWebPaneIds()
  const [token, setToken] = useState(getInitialToken)
  const [authBootstrap, setAuthBootstrap] = useState<AuthBootstrap | null>(null)
  const [authUser, setAuthUser] = useState<AuthUser | null>(null)
  const [authPending, setAuthPending] = useState(true)
  const [authError, setAuthError] = useState('')
  const [snapshot, setSnapshot] = useState<CommandoSnapshot | null>(null)
  const [agentStatuses, setAgentStatuses] = useState<Record<string, AgentStatus>>({})
  const [paneBriefs, setPaneBriefs] = useState<Record<string, SessionBrief>>({})
  const [paneMarks, setPaneMarks] = useState<Record<string, PaneMark>>({})
  const [paneSeen, setPaneSeen] = useState<Record<string, number>>({})
  const [{ turnBriefs, relays, commanderState }, dispatchCommander] = useReducer(reduceCommanderMessage, initialCommanderClientState)
  // The agent whose chat Commander's reading pane shows.
  const [commanderPeek, setCommanderPeek] = useState<{ paneId: string; targetId: string } | null>(null)
  const [commanderOpening, setCommanderOpening] = useState(false)
  const commanderStateVersion = useRef(0)
  const [agentResumes, setAgentResumes] = useState<Record<string, AgentResume>>({})
  const [externalRuns, setExternalRuns] = useState<Record<string, ExternalAgentRun[]>>({})
  const [tileEvents, setTileEvents] = useState<Record<string, ChatCardEvent[]>>({})
  const [chats, setChats] = useState<Record<string, ChatState>>({})
  /** Conversations running in Claude Code that started as a chat. */
  const [chatHandoffs, setChatHandoffs] = useState<ReadonlySet<string>>(() => new Set())
  const [chatHandoffEntries, setChatHandoffEntries] = useState<ChatHandoffInfo[]>([])
  /** Chat panes whose composer has an image still uploading; a switch waits for it. */
  const [chatUploads, setChatUploads] = useState<ReadonlySet<string>>(() => new Set())
  const [chatStashEntries, setChatStashEntries] = useState<ChatStashEntry[]>([])
  const [chatSendErrors, setChatSendErrors] = useState<Record<string, ChatSendError>>({})
  const [chatActionErrors, setChatActionErrors] = useState<Record<string, string>>({})
  /** Queue, subagent and interrupt requests by id, so a refusal shows in their pane. */
  const chatActionPanes = useRef(new Map<string, string>())
  /** The last answer each HUD card sent, by pane, and the panes of those still in flight. */
  const [hudAnswers, setHudAnswers] = useState<Record<string, AgentHudAnswerState>>({})
  const hudAnswerPanes = useRef(new Map<string, string>())
  /** Pending `@` searches by request id, answered by `chat_file_search_result`. */
  const chatFileSearches = useRef(new Map<string, (result: ChatFileSearchResult) => void>())
  /** Pending subagent transcript reads, answered by `chat_subagent_transcript_result`. */
  const chatTranscripts = useRef(new Map<string, (result: ChatSubagentTranscript) => void>())
  /** Pending MCP reads and actions, answered by `chat_mcp_result`. */
  const chatMcpReplies = useRef(new Map<string, (result: ChatMcpResult) => void>())
  /** One loader per pane, so the MCP screen's polling keeps a stable callback. */
  const chatMcpLoaders = useRef(new Map<string, (request: ChatMcpRequest) => Promise<ChatMcpResult>>())
  /** Recent chat sends by request id, so a refusal shows on the right pane. */
  const chatSendPanes = useRef(new Map<string, string>())
  const [chatViews, setChatViews] = useState<Record<string, 'chat' | 'terminal'>>({})
  const [agentHudDismissals, setAgentHudDismissals] = useState<AgentHudDismissals>(storedAgentHudDismissals)
  const [agentHudFilter, setAgentHudFilter] = useState<AgentHudFilter | null>(null)
  const [sessionTreePreferences, setSessionTreePreferences] = useState<SessionTreePreferences>(EMPTY_SESSION_TREE_PREFERENCES)
  const [workspaces, setWorkspaces] = useState<Record<string, SavedWorkspace>>({})
  const [activeSimulatorTileId, setActiveSimulatorTileId] = useState<string | null>(null)
  const [pendingSimulatorTileId, setPendingSimulatorTileId] = useState<string | null>(null)
  const [panelRevealRequest, setPanelRevealRequest] = useState<{ tabId: string; onVisible: () => void; onUnavailable?: () => void } | null>(null)
  const [dismissedPrTabs, setDismissedPrTabs] = useState<Record<string, Record<string, string>>>({})
  const [panelActiveTabs, setPanelActiveTabs] = useState<Record<string, string>>({})
  const [sessionAttention, setSessionAttention] = useState<Record<string, boolean>>({})
  const [sessionWarnings, setSessionWarnings] = useState<Record<string, boolean>>({})
  const [maximizedBuiltinTab, setMaximizedBuiltinTab] = useState<BuiltinPanelTab | null>(null)
  const reportSessionAttention = useCallback((id: string, unseen: boolean, warning = false) => {
    setSessionWarnings((current) => current[id] === warning ? current : { ...current, [id]: warning })
    setSessionAttention((current) => current[id] === unseen ? current : { ...current, [id]: unseen })
  }, [])
  const [webPanes, setWebPanes] = useState<WebPane[]>([])
  const [simulatorNames, setSimulatorNames] = useState<Record<string, string>>({})
  const [webPaneTitles, setWebPaneTitles] = useState<Record<string, string>>({})
  const panelTabSets = useRef(new Map<string, PanelTab[]>())
  const rememberPanelTabs = useCallback((tabs: PanelTab[]) => {
    setMaximizedBuiltinTab((current) => current && !tabs.some((tab) => tab.id === current.id) ? null : current)
    for (const anchor of new Set(tabs.map((tab) => tab.anchorPaneId))) panelTabSets.current.set(anchor, tabs.filter((tab) => tab.anchorPaneId === anchor))
  }, [])
  const knownPanelTabs = useRef<Map<string, number> | null>(null)
  const pendingTabSelection = useRef(new Map<string, string>())
  const seenPanelTabs = useRef(new Map<string, number>())
  const [sessionIdes, setSessionIdes] = useState<SessionIde[]>([])
  const [openedIdeIds, setOpenedIdeIds] = useState<ReadonlySet<string>>(() => new Set())
  const [idePendingSessions, setIdePendingSessions] = useState<ReadonlySet<string>>(() => new Set())
  const [ideErrors, setIdeErrors] = useState<Record<string, string>>({})
  const ideRequests = useRef(new Set<string>())
  const [webPaneFeedback, setWebPaneFeedback] = useState<Record<string, WebPaneFeedbackInfo>>({})
  const { observe: observePaneAttribution, isRecentTarget: isRecentPaneTarget, visibleTargets: attributionTargets } = usePaneAttribution()
  const [agentChatRequests, setAgentChatRequests] = useState<Record<string, AgentChatRequest>>({})
  const agentChatsApi = useMemo(() => createAgentChatsApi(token), [token])
  const [webPaneNavigateRequests, setWebPaneNavigateRequests] = useState<Record<string, WebPaneNavigateRequest>>({})
  const [webPaneReloads, setWebPaneReloads] = useState<Record<string, number>>({})
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null)
  const [activeTabs, setActiveTabs] = useState<Record<string, string>>({})
  const [focusedPaneId, setFocusedPaneId] = useState<string | null>(null)
  const [jumpHighlightedPaneId, setJumpHighlightedPaneId] = useState<string | null>(null)
  const [maximizedPaneId, setMaximizedPaneId] = useState<string | null>(null)
  const [webLayoutAuthoritative, setWebLayoutAuthoritative] = useState(true)
  const [webLayoutError, setWebLayoutError] = useState('')
  const [draggedPane, setDraggedPane] = useState<DraggedItem | null>(null)
  const [dropPreview, setDropPreview] = useState<{ paneId: string; placement: 'right' | 'below' } | null>(null)
  const [paletteOpen, setPaletteOpen] = useState(false)
  /** The workspace pane whose conversation picker is open. */
  /** The ⌘P palette over one pane, and the screen it shows. */
  const [panePalette, setPanePalette] = useState<{ paneId: string; screen: PanePaletteScreen; sessionFilter?: { id: string; name: string } } | null>(null)
  const palettePaneId = panePalette?.paneId ?? null
  const reopeningConversation = useRef(false)
  const [paletteQuery, setPaletteQuery] = useState('')
  const [paletteIndex, setPaletteIndex] = useState(0)
  const [themeName, setThemeName] = useState<ThemeName>(() => storedTheme())
  const [leftPanelOpen, setLeftPanelOpen] = useState(false)
  const [rightPanelOpen, setRightPanelOpen] = useState(false)
  const [drawerTransitionOcclusion, setDrawerTransitionOcclusion] = useState(false)
  const [leftPanelHidden, setLeftPanelHidden] = useState(() => storedPanelHidden(LEFT_PANEL_HIDDEN_STORAGE_KEY))
  const [leftPanelWidth, setLeftPanelWidth] = useState(storedLeftPanelWidth)
  const [resizingLeftPanel, setResizingLeftPanel] = useState(false)
  const [rightPanelHidden, setRightPanelHidden] = useState(() => storedPanelHidden(RIGHT_PANEL_HIDDEN_STORAGE_KEY))
  const [hudTab, setHudTab] = useState<HudTab>(() => storedHudTab())
  const [prsAttention, setPrsAttention] = useState(false)
  const prHudActionVersion = useRef(0)
  useEffect(() => () => { prHudActionVersion.current += 1 }, [token])
  const [prSelections, setPrSelections] = useState<Record<string, { tab: PrQuickLookTab; revision: number }>>({})
  const switchHudTab = useCallback((tab: HudTab) => {
    setHudTab(tab)
    storeHudTab(tab)
  }, [])
  const [pendingPaneFocus, setPendingPaneFocus] = useState<{
    paneId: string
    expectedTargetId?: string
    highlight?: boolean
    waitForCreation?: boolean
  } | null>(null)
  const [paneMenu, setPaneMenu] = useState<{ paneId: string; x: number; y: number } | null>(null)
  const [renamingPaneId, setRenamingPaneId] = useState<string | null>(null)
  const [paneRendererControls, setPaneRendererControls] = useState<ReadonlyMap<string, PaneRendererControl>>(
    () => new Map(),
  )
  const [nativeTerminalAvailable, setNativeTerminalAvailable] = useState(false)
  const [paneActionPending, setPaneActionPending] = useState(false)
  const [paneActionError, setPaneActionError] = useState('')
  const [screenshotLightbox, setScreenshotLightbox] = useState<PaneScreenshotLightboxRequest | null>(null)
  const [revealInFinder, setRevealInFinder] = useState(false)
  const [pinnedNote, setPinnedNote] = useState<PinnedNote | null>(storedPinnedNote)
  const [requestedNote, setRequestedNote] = useState<NoteRequest | null>(null)
  const [resizeRetryVersion, setResizeRetryVersion] = useState(0)
  const tokenBrokerRef = useRef<SessionTokenBroker | null>(null)
  const previousSnapshotRef = useRef<CommandoSnapshot | null>(null)
  const resizeAuthorityActiveRef = useRef(false)
  const previousResizeAuthorityActive = useRef(false)
  const previousResizeSessionId = useRef<string | null>(null)
  const resizeRetryAttempts = useRef(0)
  const resizeRetryTimer = useRef<number | null>(null)
  const paneJumpHighlightTimer = useRef<number | null>(null)
  const leftPanelResizePointer = useRef<number | null>(null)
  const leftPanelResizeWidth = useRef(leftPanelWidth)
  const cockpitBodyRef = useRef<HTMLDivElement | null>(null)
  const sessionActionsRef = useRef<SessionActions | null>(null)
  const responsiveDrawersOpen = leftPanelOpen || rightPanelOpen
  const drawerOcclusionActive = responsiveDrawersOpen || drawerTransitionOcclusion

  useEffect(() => {
    if (responsiveDrawersOpen) {
      setDrawerTransitionOcclusion(true)
      return
    }
    if (!drawerTransitionOcclusion) return
    const timer = window.setTimeout(
      () => setDrawerTransitionOcclusion(false),
      RESPONSIVE_DRAWER_OCCLUSION_FALLBACK_MS,
    )
    return () => window.clearTimeout(timer)
  }, [drawerTransitionOcclusion, responsiveDrawersOpen])

  const finishResponsiveDrawerTransition = (event: TransitionEvent<HTMLElement>) => {
    if (
      event.target === event.currentTarget &&
      event.propertyName === 'transform' &&
      !responsiveDrawersOpen
    ) setDrawerTransitionOcclusion(false)
  }

  const changePinnedNote = useCallback((next: PinnedNote | null) => {
    setPinnedNote(next)
    storePinnedNote(next)
  }, [])

  const savePinnedNote = useCallback(async (note: PinnedNote) => {
    const updated = await createNotesApi(token).update(note.vaultId, note.id, {
      title: note.title,
      body: note.body,
      folder: note.folder,
      expectedUpdatedAt: note.updatedAt,
    })
    const next = pinnedNoteFrom(note.vaultId, updated)
    setPinnedNote((current) => {
      if (current?.vaultId !== note.vaultId || current.id !== note.id) return current
      storePinnedNote(next)
      return next
    })
    return next
  }, [token])

  const uploadPinnedNoteImage = useCallback(
    (note: PinnedNote, file: File) => createNotesApi(token).uploadImage(note.vaultId, note.id, file),
    [token],
  )

  const resolvePinnedNoteImageUrl = useCallback(
    (note: PinnedNote, url: string) => createNotesApi(token).resolveImageUrl(url, note.vaultId),
    [token],
  )

  useEffect(() => {
    const broker = new SessionTokenBroker()
    tokenBrokerRef.current = broker
    let active = true
    const removeClearListener = broker.onClear(() => {
      clearToken()
      setToken('')
      setSnapshot(null)
    })
    const acceptSharedToken = (sharedToken: string) => {
      if (!active || !sharedToken) return
      storeToken(sharedToken)
      broker.setToken(sharedToken)
      setToken(sharedToken)
    }
    const removeTokenListener = broker.onToken(acceptSharedToken)
    if (!token) {
      void broker.requestToken().then(acceptSharedToken)
    }
    return () => {
      active = false
      removeClearListener()
      removeTokenListener()
      broker.close()
      if (tokenBrokerRef.current === broker) tokenBrokerRef.current = null
    }
  }, [])

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

  const limitLeftPanelWidth = (width: number) => Math.max(
    LEFT_PANEL_MIN_WIDTH,
    Math.min(LEFT_PANEL_MAX_WIDTH, window.innerWidth - 320, Math.round(width)),
  )

  const moveLeftPanelResize = (event: PointerEvent<HTMLDivElement>) => {
    if (leftPanelResizePointer.current !== event.pointerId) return
    const left = cockpitBodyRef.current?.getBoundingClientRect().left ?? 0
    const width = limitLeftPanelWidth(event.clientX - left)
    leftPanelResizeWidth.current = width
    setLeftPanelWidth(width)
  }

  const finishLeftPanelResize = (event: PointerEvent<HTMLDivElement>) => {
    if (leftPanelResizePointer.current !== event.pointerId) return
    leftPanelResizePointer.current = null
    setResizingLeftPanel(false)
    storeLeftPanelWidth(leftPanelResizeWidth.current)
  }

  const resizeLeftPanelWithKeyboard = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight' && event.key !== 'Home') return
    event.preventDefault()
    const width = event.key === 'Home'
      ? LEFT_PANEL_DEFAULT_WIDTH
      : limitLeftPanelWidth(leftPanelWidth + (event.key === 'ArrowRight' ? 1 : -1) * (event.shiftKey ? 40 : 10))
    setLeftPanelWidth(width)
    storeLeftPanelWidth(width)
  }

  useEffect(() => {
    const bridge = getNativeTerminalBridge()
    if (!bridge) return
    let active = true
    let unsubscribeTheme = () => {}
    void bridge.connect().then((result) => {
      if (!active) return
      setNativeTerminalAvailable(result.available)
      if (!result.available) return
      bridge.setTheme(activeTheme().terminal)
      unsubscribeTheme = onThemeChange((theme) => bridge.setTheme(theme.terminal))
    })
    return () => {
      active = false
      unsubscribeTheme()
    }
  }, [])

  const [area, setArea] = useState<CommandoArea>('workspace')
  const [notesMounted, setNotesMounted] = useState(false)
  const paneRefs = useRef(new Map<string, HTMLElement>())
  const paneStreamsRef = useRef<PaneStreamRegistry | null>(null)
  if (!paneStreamsRef.current) paneStreamsRef.current = new PaneStreamRegistry()
  const paletteInputRef = useRef<HTMLInputElement>(null)
  const previousResizePaneId = useRef<string | null>(null)
  const paneLayoutCapacities = useRef(new Map<string, PaneLayoutCapacity & { key: string }>())
  const lastFocusedResize = useRef<{ paneId: string; cols: number; rows: number } | null>(null)
  const layoutTimers = useRef(new Map<string, number>())

  const handleServerMessage = (message: ServerMessage) => {
    switch (message.type) {
      case 'capabilities':
        setRevealInFinder(message.capabilities.revealInFinder)
        break
      case 'snapshot':
        if (
          previousSnapshotRef.current &&
          message.snapshot.revision < previousSnapshotRef.current.revision
        ) {
          setPaneRendererControls(new Map())
        }
        observePaneAttribution(message.snapshot.panes)
        // Consume tmux focus transitions at snapshot time so a later click
        // cannot be overridden by an unchanged active pane on a rerender.
        if (activeGroup && previousSnapshotRef.current) {
          const previousActive = previousSnapshotRef.current.panes.find((pane) =>
            pane.windowId === activeGroup.windowId && pane.active)?.id
          const nextActive = message.snapshot.panes.find((pane) =>
            pane.windowId === activeGroup.windowId && pane.active)?.id
          // Lineage can follow the structural snapshot; hold focus during that grace period.
          const newlyOpenedByAgent = message.snapshot.panes.some((pane) => pane.id === nextActive && isRecentPaneTarget(pane.targetId))
          if (previousActive && nextActive && previousActive !== nextActive && !newlyOpenedByAgent) setFocusedPaneId(nextActive)
        }
        previousSnapshotRef.current = message.snapshot
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
      case 'agent_status_snapshot':
        setAgentStatuses(Object.fromEntries(
          message.statuses.map((status) => [status.paneId, status]),
        ))
        break
      case 'agent_status_removed':
        setAgentStatuses((current) => {
          if (!(message.paneId in current)) return current
          const next = { ...current }
          delete next[message.paneId]
          return next
        })
        break
      case 'session_brief':
        setPaneBriefs((current) => ({
          ...current,
          [message.brief.paneId]: message.brief,
        }))
        break
      case 'session_brief_snapshot':
        setPaneBriefs(Object.fromEntries(
          message.briefs.map((brief) => [brief.paneId, brief]),
        ))
        break
      case 'turn_brief':
      case 'turn_brief_snapshot':
      case 'commander_relay':
      case 'commander_relay_snapshot':
        dispatchCommander(message)
        break
      case 'commander_state':
        commanderStateVersion.current += 1
        dispatchCommander(message)
        break
      case 'pane_mark':
        setPaneMarks((current) => ({ ...current, [message.mark.targetId]: message.mark }))
        break
      case 'pane_seen':
        setPaneSeen((current) => message.snapshot ? message.seen : { ...current, ...message.seen })
        break
      case 'pane_mark_snapshot':
        setPaneMarks(Object.fromEntries(message.marks.map((mark) => [mark.targetId, mark])))
        break
      case 'pane_mark_removed':
        setPaneMarks((current) => {
          if (!(message.targetId in current)) return current
          const next = { ...current }
          delete next[message.targetId]
          return next
        })
        break
      case 'agent_resume':
        setAgentResumes((current) => ({ ...current, [message.resume.targetId]: message.resume }))
        break
      case 'agent_resume_snapshot':
        setAgentResumes(Object.fromEntries(message.resumes.map((resume) => [resume.targetId, resume])))
        break
      case 'agent_resume_removed':
        setAgentResumes((current) => {
          if (!(message.targetId in current)) return current
          const next = { ...current }
          delete next[message.targetId]
          return next
        })
        break
      case 'agent_request_answered': {
        const paneId = hudAnswerPanes.current.get(message.requestId)
        if (!paneId) break
        hudAnswerPanes.current.delete(message.requestId)
        setHudAnswers((current) => {
          const next = { ...current }
          delete next[paneId]
          return next
        })
        break
      }
      case 'chat_external_runs':
        setExternalRuns((current) => ({ ...current, [message.paneId]: message.runs }))
        break
      case 'chat_tile_events':
        setTileEvents((current) => ({ ...current, [message.paneId]: message.events }))
        break
      case 'chat_snapshot':
        setExternalRuns({})
        setTileEvents({})
        setChats(Object.fromEntries(message.chats.map((chat) => [chat.paneId, chat])))
        break
      case 'chat_stash':
        setChatStashEntries(message.entries)
        break
      case 'chat_state':
        setChats((current) => ({ ...current, [message.chat.paneId]: message.chat }))
        break
      case 'chat_session':
        setChats((current) => {
          const chat = current[message.paneId]
          return chat ? { ...current, [message.paneId]: { ...chat, session: message.session, hostConnected: message.hostConnected } } : current
        })
        break
      case 'chat_items':
        setChats((current) => {
          const chat = current[message.paneId]
          return chat ? { ...current, [message.paneId]: { ...chat, items: mergeChatItems(message.replace ? [] : chat.items, message.items) } } : current
        })
        break
      case 'chat_commands':
        setChats((current) => {
          const chat = current[message.paneId]
          return chat ? { ...current, [message.paneId]: { ...chat, commands: message.commands } } : current
        })
        break
      case 'chat_file_search_result': {
        const { type: _type, paneId: _paneId, requestId: searchId, ...result } = message
        chatFileSearches.current.get(searchId)?.(result)
        break
      }
      case 'chat_subagent_transcript_result': {
        const { type: _type, paneId: _paneId, requestId: readId, ...result } = message
        chatTranscripts.current.get(readId)?.(result)
        break
      }
      case 'chat_mcp_result': {
        const { type: _type, paneId: _paneId, requestId: mcpId, ...result } = message
        chatMcpReplies.current.get(mcpId)?.(result)
        break
      }
      case 'chat_handoffs':
        setChatHandoffs(new Set(message.sessionIds))
        setChatHandoffEntries(message.handoffs ?? [])
        break
      case 'chat_removed':
        setChats((current) => {
          if (!(message.paneId in current)) return current
          const next = { ...current }
          delete next[message.paneId]
          return next
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
      case 'web_panes':
        if (knownPanelTabs.current === null) {
          knownPanelTabs.current = new Map(message.webPanes.filter((tab) => tab.dock !== 'split').map((tab) => [tab.id, tab.openRevision ?? 0]))
        }
        setPanelActiveTabs(message.activeTabs ?? {})
        setDismissedPrTabs(message.dismissedPrTabs ?? {})
        setWebPanes(message.webPanes)
        setWebPaneFeedback(message.feedback ?? {})
        setWebPaneNavigateRequests(message.navigateRequests ?? {})
        setAgentChatRequests(message.agentChatRequests ?? {})
        setWebPaneReloads(message.reloads ?? {})
        break
      case 'session_ides':
        // Origin URLs are authorized per browser by open(); broadcasts contain
        // only the neutral proxy path. Preserve already-authorized frame URLs.
        setSessionIdes((current) => message.ides.map((ide) => {
          const previous = current.find((item) => item.id === ide.id)
          return previous && previous.generation === ide.generation ? { ...ide, url: previous.url } : ide
        }))
        break
      case 'error':
        console.error(`[commando:${message.code}] ${message.message}`)
        if (message.requestId) {
          chatFileSearches.current.get(message.requestId)?.({ entries: [], truncated: false, error: message.message })
          chatTranscripts.current.get(message.requestId)?.({ items: [], error: message.message })
          const chatPane = chatSendPanes.current.get(message.requestId)
          if (chatPane) {
            chatSendPanes.current.delete(message.requestId)
            const refused = { requestId: message.requestId, code: message.code }
            setChatSendErrors((current) => ({
              ...current,
              [chatPane]: { message: message.message, refused: [...(current[chatPane]?.refused ?? []), refused] },
            }))
          }
          const actionPane = chatActionPanes.current.get(message.requestId)
          if (actionPane) {
            chatActionPanes.current.delete(message.requestId)
            setChatActionErrors((current) => ({ ...current, [actionPane]: message.message }))
          }
          const hudPane = hudAnswerPanes.current.get(message.requestId)
          if (hudPane) {
            hudAnswerPanes.current.delete(message.requestId)
            const error = message.code === 'request_unavailable'
              ? "It isn't waiting here any more; answer it in the pane"
              : message.message
            setHudAnswers((current) => current[hudPane]
              ? { ...current, [hudPane]: { ...current[hudPane], pending: false, error } }
              : current)
          }
        }
        if (
          message.code === 'tmux_layout_failed' ||
          message.code === 'invalid_window_layout' ||
          message.code === 'resize_window_busy'
        ) {
          setWebLayoutError(message.message)
        }
        if (
          message.code === 'resize_window_busy' &&
          resizeAuthorityActiveRef.current &&
          resizeRetryAttempts.current < RESIZE_LEASE_RETRY_LIMIT &&
          resizeRetryTimer.current === null
        ) {
          resizeRetryAttempts.current += 1
          resizeRetryTimer.current = window.setTimeout(() => {
            resizeRetryTimer.current = null
            if (resizeAuthorityActiveRef.current) {
              setResizeRetryVersion((current) => current + 1)
            }
          }, Math.min(150 * resizeRetryAttempts.current, RESIZE_LEASE_RETRY_MAX_DELAY_MS))
        }
        break
    }
  }

  const { connection, send } = useDaemon(token, authUser !== null, handleServerMessage)
  const connected = connection.phase === 'live'
  const resizeAuthorityActive = desktopWindowActive && connected && area === 'workspace'
  resizeAuthorityActiveRef.current = resizeAuthorityActive

  useEffect(() => {
    if (!token && connection.phase === 'unauthorized') setAuthUser(null)
  }, [connection.phase, token])
  useEffect(() => {
    const broker = tokenBrokerRef.current
    if (!broker) return
    if (token && connection.phase !== 'unauthorized') {
      broker.setToken(token)
    } else {
      broker.forgetToken()
    }
  }, [connection.phase, token])
  const maximizedTmuxPaneId =
    maximizedPaneId && !isWebPaneLeafId(maximizedPaneId) ? maximizedPaneId : null
  const activeResizePaneId = resizeAuthorityActive
    ? maximizedTmuxPaneId ?? (webLayoutAuthoritative ? null : focusedPaneId)
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

  useEffect(() => {
    const wasActive = previousResizeAuthorityActive.current
    previousResizeAuthorityActive.current = resizeAuthorityActive
    if (resizeAuthorityActive) {
      if (!wasActive) {
        resizeRetryAttempts.current = 0
        setResizeRetryVersion((current) => current + 1)
      }
      return
    }

    for (const timer of layoutTimers.current.values()) window.clearTimeout(timer)
    layoutTimers.current.clear()
    paneLayoutCapacities.current.clear()
    lastFocusedResize.current = null
    previousResizePaneId.current = null
    resizeRetryAttempts.current = 0
    if (resizeRetryTimer.current !== null) {
      window.clearTimeout(resizeRetryTimer.current)
      resizeRetryTimer.current = null
    }
    if (wasActive && connected) {
      send({ type: 'release_all_resizes', requestId: requestId('window-inactive-release') })
    }
  }, [connected, resizeAuthorityActive, send])

  useEffect(() => {
    const previousSessionId = previousResizeSessionId.current
    previousResizeSessionId.current = selectedSessionId
    if (!previousSessionId || previousSessionId === selectedSessionId) return

    previousResizePaneId.current = null
    paneLayoutCapacities.current.clear()
    lastFocusedResize.current = null
    for (const timer of layoutTimers.current.values()) window.clearTimeout(timer)
    layoutTimers.current.clear()
    resizeRetryAttempts.current = 0
    if (resizeRetryTimer.current !== null) {
      window.clearTimeout(resizeRetryTimer.current)
      resizeRetryTimer.current = null
    }
    if (resizeAuthorityActiveRef.current) {
      send({ type: 'release_all_resizes', requestId: requestId('session-release') })
      setResizeRetryVersion((current) => current + 1)
    }
  }, [selectedSessionId, send])

  useEffect(() => {
    const releaseOnPageHide = () => {
      if (!resizeAuthorityActiveRef.current) return
      resizeAuthorityActiveRef.current = false
      send({ type: 'release_all_resizes', requestId: requestId('page-hide-release') })
    }
    window.addEventListener('pagehide', releaseOnPageHide)
    return () => window.removeEventListener('pagehide', releaseOnPageHide)
  }, [send])

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
  const livePaneTargetIds = new Set(snapshot?.panes.map((pane) => pane.targetId) ?? [])
  const windowMap = new Map(snapshot?.windows.map((window) => [window.id, window]) ?? [])
  const sessionMap = new Map(snapshot?.sessions.map((session) => [session.id, session]) ?? [])
  const paneSessionNames = new Map<string, string | undefined>()
  for (const pane of snapshot?.panes ?? []) {
    // An ambiguous durable target must not identify a producing session.
    paneSessionNames.set(pane.targetId, paneSessionNames.has(pane.targetId)
      ? undefined
      : sessionMap.get(pane.sessionId)?.name)
  }
  const selectedTabWindowId = selectedSessionId ? activeTabs[selectedSessionId] : undefined
  const activeGroup = resolveActiveGroup(
    groups,
    selectedTabWindowId,
    selectedSession?.activeWindowId ?? undefined,
  )
  const allVisiblePaneIds = activeGroup
    ? activeGroup.paneIds.filter((paneId) => paneMap.has(paneId))
    : []
  const tmuxActivePaneId = allVisiblePaneIds.find((id) => paneMap.get(id)?.active)
  const effectivePaneId = effectiveFocusedPane(focusedPaneId, allVisiblePaneIds, tmuxActivePaneId)
  useEffect(() => {
    setFocusedPaneId((current) => effectiveFocusedPane(current, allVisiblePaneIds, tmuxActivePaneId) ?? null)
  }, [snapshot, activeGroup?.windowId, focusedPaneId])

  const selectPanelTabLocally = useCallback((tab: PanelTab) => {
    const maximized = maximizedBuiltinTab?.anchorPaneId === tab.anchorPaneId || webPanes.some((pane) => pane.id === maximizedPaneId && pane.dock !== 'split' && pane.anchorPaneId === tab.anchorPaneId)
    if (maximized) {
      setMaximizedBuiltinTab(isBuiltinTab(tab) ? tab : null)
      setMaximizedPaneId(isBuiltinTab(tab) ? null : tab.id)
    }
    setPanelActiveTabs((current) => ({ ...current, [tab.anchorPaneId]: panelTabKey(tab) }))
    setWebPanes((current) => current.map((pane) => pane.anchorPaneId === tab.anchorPaneId
      ? { ...pane, activeTab: pane.id === tab.id }
      : pane))
  }, [webPanes, maximizedPaneId, maximizedBuiltinTab])

  const selectPanelTab = useCallback(async (tab: PanelTab) => {
    selectPanelTabLocally(tab)
    try { await createWebPanesApi(token).setActiveTab(panelTabKey(tab), tab.anchorPaneId) } catch (error) {
      setPaneActionError(error instanceof Error ? error.message : 'Could not select tab')
    }
  }, [selectPanelTabLocally, token])

  useEffect(() => {
    const tabs = webPanes.filter((tab) => tab.dock !== 'split')
    const previous = knownPanelTabs.current
    if (previous === null) return
    knownPanelTabs.current = new Map(tabs.map((tab) => [tab.id, tab.openRevision ?? 0]))
    if (!effectivePaneId || !activeGroup || !connected) return
    const focusedTabs = panelTabs(tabs.filter((tab) => tab.windowId === activeGroup.windowId), effectivePaneId)
    const newTabs = openedPanelTabs(focusedTabs, previous)
    const selected = newTabs.at(-1)
    if (!selected) return
    if (pendingTabSelection.current.get(effectivePaneId) === selected.id) return
    pendingTabSelection.current.set(effectivePaneId, selected.id)
    void selectPanelTab(selected).finally(() => {
      if (pendingTabSelection.current.get(effectivePaneId) === selected.id) pendingTabSelection.current.delete(effectivePaneId)
    })
  }, [webPanes, effectivePaneId, activeGroup?.windowId, connected, selectPanelTab])

  const currentPrPane = (
    (maximizedTmuxPaneId ? paneMap.get(maximizedTmuxPaneId) : undefined) ??
    (focusedPaneId && allVisiblePaneIds.includes(focusedPaneId) ? paneMap.get(focusedPaneId) : undefined) ??
    allVisiblePaneIds.map((paneId) => paneMap.get(paneId)).find((pane) => pane?.active) ??
    (allVisiblePaneIds[0] ? paneMap.get(allVisiblePaneIds[0]) : undefined)
  )
  const subscribedPaneIds = area === 'workspace'
    ? maximizedPaneId
      ? isWebPaneLeafId(maximizedPaneId) ? allVisiblePaneIds : [maximizedPaneId]
      : allVisiblePaneIds
    : []
  const statusOnlyPaneIds = area === 'workspace' && selectedSessionId
    ? (snapshot?.panes ?? [])
        .filter((pane) => pane.sessionId === selectedSessionId && !subscribedPaneIds.includes(pane.id))
        .map((pane) => pane.id)
    : []
  const subscriptionKey = subscribedPaneIds.join('\u0000')
  const statusSubscriptionKey = statusOnlyPaneIds.join('\u0000')
  // The selected session's panes are in front of the user while the window is
  // active, so a turn that ended there is seen rather than left to review.
  const unseenViewedPaneKey = desktopWindowActive
    ? [...subscribedPaneIds, ...statusOnlyPaneIds]
        .filter((paneId) => {
          const settledAt = agentStatuses[paneId]?.settledAt
          return settledAt !== undefined && settledAt > (paneSeen[paneId] ?? -Infinity)
        })
        .join('\u0000')
    : ''

  // Agents read in Commander's reading pane are marked seen when it closes, so
  // their rows stay put (not regrouped as idle) while you step through them.
  const readingPaneId = commanderPeek?.paneId
  const readAgents = useRef(new Set<string>())
  useEffect(() => {
    if (readingPaneId) readAgents.current.add(readingPaneId)
    if (readingPaneId || !connected || !readAgents.current.size) return
    const paneIds = [...readAgents.current].filter((paneId) => {
      const settledAt = agentStatuses[paneId]?.settledAt
      return settledAt !== undefined && settledAt > (paneSeen[paneId] ?? -Infinity)
    })
    // Sent in the protocol's batches of 64; anything the socket refuses waits for a reconnect.
    const unsent = new Set(readAgents.current)
    for (const paneId of readAgents.current) if (!paneIds.includes(paneId)) unsent.delete(paneId)
    for (let start = 0; start < paneIds.length; start += 64) {
      const batch = paneIds.slice(start, start + 64)
      if (!send({ type: 'mark_panes_seen', paneIds: batch })) break
      for (const paneId of batch) unsent.delete(paneId)
    }
    readAgents.current = unsent
    // Runs when the pane opens, moves or closes, and on reconnect; statuses are read at that moment.
  }, [readingPaneId, connected])

  useEffect(() => {
    if (!connected || !unseenViewedPaneKey) return
    send({ type: 'mark_panes_seen', paneIds: unseenViewedPaneKey.split('\u0000').slice(0, 64) })
  }, [connected, unseenViewedPaneKey, send])

  useEffect(() => {
    if (!connected || !selectedSessionId) return
    send({
      type: 'load_workspace',
      sessionId: selectedSessionId,
      requestId: requestId('load'),
    })
  }, [connected, selectedSessionId, send])

  // The HUD answers requests too, so hooks hold them while this window is open.
  useEffect(() => {
    if (!connected) return
    send({ type: 'watch_interactions', enabled: true, requestId: requestId('watch-interactions') })
  }, [connected, send])

  useEffect(() => {
    if (!connected) return
    send({
      type: 'subscribe',
      paneIds: subscriptionKey ? subscriptionKey.split('\u0000') : [],
      statusPaneIds: statusSubscriptionKey ? statusSubscriptionKey.split('\u0000') : [],
    })
  }, [connected, send, subscriptionKey, statusSubscriptionKey])

  useEffect(() => {
    if (connection.phase !== 'live') {
      paneStreamsRef.current?.clear()
    }
  }, [connection.phase])

  useEffect(() => {
    setMaximizedPaneId(null)
    setFocusedPaneId(null)
  }, [selectedSessionId])

  useEffect(() => {
    if (
      maximizedPaneId &&
      !snapshot?.panes.some((pane) => pane.id === maximizedPaneId) &&
      !webPanes.some((webPane) => webPane.id === maximizedPaneId)
    ) {
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
    setPaneRendererControls((current) => {
      if (current.size === 0) return current
      const identities = new Map(
        snapshot?.panes.map((pane) => [pane.id, paneRendererIdentity(pane)]) ?? [],
      )
      const next = new Map(
        [...current].filter(([paneId, control]) => identities.get(paneId) === control.identity),
      )
      return next.size === current.size ? current : next
    })
  }, [focusedPaneId, maximizedPaneId, paneMenu, renamingPaneId, snapshot, webPanes])

  const updatePaneRendererControl = (
    paneId: string,
    identity: string,
    update: (control: PaneRendererControl) => PaneRendererControl,
  ) => {
    setPaneRendererControls((current) => {
      const existing = current.get(paneId)
      const control: PaneRendererControl = existing?.identity === identity
        ? existing
        : { identity, actual: 'xterm', manualXterm: false, retryKey: 0 }
      const nextControl = update(control)
      if (nextControl === control) return current
      const next = new Map(current)
      next.set(paneId, nextControl)
      return next
    })
  }

  const revealedPaneFocus = useRef<typeof pendingPaneFocus>(null)
  useEffect(() => {
    if (!pendingPaneFocus) return
    const pane = paneMap.get(pendingPaneFocus.paneId)
    if (!pane && pendingPaneFocus.waitForCreation) return
    if (!pane || (pendingPaneFocus.expectedTargetId && pane.targetId !== pendingPaneFocus.expectedTargetId)) {
      setPendingPaneFocus(null)
      return
    }
    const group = groups.find((candidate) => candidate.paneIds.includes(pendingPaneFocus.paneId))
    const shown = pane.sessionId === selectedSessionId && (!group || group === activeGroup)
    // Once the pane was shown, a different selection means the user moved on:
    // drop the jump instead of pulling them back on every render.
    if (!shown && revealedPaneFocus.current === pendingPaneFocus) {
      setPendingPaneFocus(null)
      return
    }
    if (pane.sessionId !== selectedSessionId) {
      setArea('workspace')
      setSelectedSessionId(pane.sessionId)
      return
    }
    if (group && group !== activeGroup) {
      setActiveTabs((current) => ({ ...current, [pane.sessionId]: group.windowId }))
      return
    }
    revealedPaneFocus.current = pendingPaneFocus
    const frame = window.requestAnimationFrame(() => {
      const node = paneRefs.current.get(pendingPaneFocus.paneId)
      if (!node?.isConnected) return
      node.scrollIntoView({ behavior: 'smooth', block: 'center' })
      node.focus({ preventScroll: true })
      setFocusedPaneId(pendingPaneFocus.paneId)
      if (pendingPaneFocus.highlight) {
        if (paneJumpHighlightTimer.current !== null) {
          window.clearTimeout(paneJumpHighlightTimer.current)
        }
        setJumpHighlightedPaneId(pendingPaneFocus.paneId)
        paneJumpHighlightTimer.current = window.setTimeout(() => {
          setJumpHighlightedPaneId(null)
          paneJumpHighlightTimer.current = null
        }, PANE_JUMP_HIGHLIGHT_MS)
      }
      setPendingPaneFocus(null)
    })
    return () => window.cancelAnimationFrame(frame)
  })

  useEffect(() => () => {
    if (paneJumpHighlightTimer.current !== null) {
      window.clearTimeout(paneJumpHighlightTimer.current)
    }
  }, [])

  useEffect(() => {
    const handleGlobalKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.metaKey && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setPaletteOpen((current) => !current)
      } else if (event.key === 'Escape' && paletteOpen) {
        setPaletteOpen(false)
      }
    }
    const handleNativeShortcut = (event: Event) => {
      if ((event as CustomEvent<{ key?: string }>).detail?.key === 'k') {
        setPaletteOpen((current) => !current)
      }
    }
    window.addEventListener('keydown', handleGlobalKeyDown)
    window.addEventListener(NATIVE_TERMINAL_SHORTCUT_EVENT, handleNativeShortcut)
    return () => {
      window.removeEventListener('keydown', handleGlobalKeyDown)
      window.removeEventListener(NATIVE_TERMINAL_SHORTCUT_EVENT, handleNativeShortcut)
    }
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

  const openSessionIde = async (sessionId: string) => {
    setSelectedSessionId(sessionId)
    setArea('ide')
    setLeftPanelOpen(false)
    if (ideRequests.current.has(sessionId) || ideRequests.current.has(`detach:${sessionId}`)) return
    ideRequests.current.add(sessionId)
    setIdePendingSessions((current) => new Set([...current, sessionId]))
    setIdeErrors((current) => ({ ...current, [sessionId]: '' }))
    try {
      const focused = snapshot?.panes.find((pane) => pane.id === focusedPaneId && pane.sessionId === sessionId)
      const ide = await createSessionIdesApi(token).open(sessionId, focused?.id)
      // Live broadcasts are authoritative; an older HTTP response must not
      // replace a newer shared-session attachment list.
      setSessionIdes((current) => current.some((item) => item.id === ide.id)
        ? current.map((item) => item.id === ide.id && item.generation === ide.generation ? { ...item, url: ide.url } : item)
        : [...current, ide])
      setOpenedIdeIds((current) => new Set([...current, ide.id]))
    } catch (error) {
      setIdeErrors((current) => ({ ...current, [sessionId]: error instanceof Error ? error.message : 'Unable to open IDE' }))
    } finally {
      ideRequests.current.delete(sessionId)
      setIdePendingSessions((current) => new Set([...current].filter((id) => id !== sessionId)))
    }
  }

  const detachSessionIde = async (sessionId: string) => {
    if (ideRequests.current.has(sessionId) || ideRequests.current.has(`detach:${sessionId}`)) return
    ideRequests.current.add(`detach:${sessionId}`)
    setIdePendingSessions((current) => new Set([...current, sessionId]))
    setIdeErrors((current) => ({ ...current, [sessionId]: '' }))
    try {
      await createSessionIdesApi(token).detach(sessionId)
      setSessionIdes((current) => current.map((item) => ({ ...item, sessionIds: item.sessionIds.filter((id) => id !== sessionId) })).filter((item) => item.sessionIds.length))
      setArea('workspace')
    } catch (error) {
      setIdeErrors((current) => ({ ...current, [sessionId]: error instanceof Error ? error.message : 'Unable to detach IDE' }))
    } finally {
      ideRequests.current.delete(`detach:${sessionId}`)
      setIdePendingSessions((current) => new Set([...current].filter((id) => id !== sessionId)))
    }
  }

  const jumpToPane = (paneId: string, expectedTargetId?: string, highlight = false) => {
    const pane = paneMap.get(paneId)
    if (!pane) return
    setArea('workspace')
    setMaximizedBuiltinTab(null)
    setMaximizedPaneId(null)
    setSelectedSessionId(pane.sessionId)
    setPendingPaneFocus({ paneId, expectedTargetId, highlight })
    setPaletteOpen(false)
    setLeftPanelOpen(false)
    setRightPanelOpen(false)
  }

  const openCommander = async () => {
    setCommanderOpening(true)
    const version = commanderStateVersion.current
    try {
      const state = await createCommanderApi(token).ensure()
      // A live broadcast received during the request is newer than its response.
      if (version === commanderStateVersion.current) dispatchCommander({ type: 'commander_state', state })
    } catch (cause) {
      setCommanderOpening(false)
      throw cause
    }
  }
  /** Closes Commander and starts a fresh one on the profile, then shows it like opening Commander does. */
  const switchCommanderProfile = async (configDir: string | null) => {
    const version = commanderStateVersion.current
    const state = await createCommanderApi(token).setProfile(configDir)
    if (version === commanderStateVersion.current) dispatchCommander({ type: 'commander_state', state })
    // Only now: earlier, the old Commander is still open and would be the one shown.
    setCommanderOpening(true)
  }
  // Creation may report state before its structural snapshot arrives (or vice versa).
  useEffect(() => {
    if (!commanderOpening || !commanderState.paneId) return
    const pane = snapshot?.panes.find((item) => item.id === commanderState.paneId && item.targetId === commanderState.targetId)
    if (!pane) return
    jumpToPane(pane.id, pane.targetId, true)
    setCommanderOpening(false)
  }, [commanderOpening, commanderState, snapshot?.panes])

  const jumpToPaneTarget = (targetId: string) => {
    const matches = snapshot?.panes.filter((pane) => pane.targetId === targetId) ?? []
    if (matches.length !== 1) return
    jumpToPane(matches[0].id, targetId, true)
  }

  const revealBuiltinTab = (paneId: string, key: BuiltinPanelKey, persistSelection = true) => {
    const tab = builtinPanelTab(paneId, key)
    setMaximizedPaneId((current) => webPanes.some((pane) => pane.id === current && pane.dock !== 'split' && pane.anchorPaneId === paneId) ? current : null)
    setMaximizedBuiltinTab((current) => current?.id === tab.id ? current : null)
    setFocusedPaneId(paneId)
    if (persistSelection) void selectPanelTab(tab)
    else selectPanelTabLocally(tab)
    setPanelRevealRequest({ tabId: tab.id, onVisible: () => setPanelRevealRequest(null), onUnavailable: () => setPanelRevealRequest(null) })
  }

  const restorePanePrTab = async (tab: BuiltinPanelTab) => {
    await webPanesApi.restorePrTab(tab.anchorPaneId, tab.key, true)
    setDismissedPrTabs((current) => {
      const entries = { ...current[tab.anchorPaneId] }
      delete entries[tab.key]
      return { ...current, [tab.anchorPaneId]: entries }
    })
  }

  /** Brings a web tile forward beside its pane; false when the tile is gone. */
  const revealWebPaneTab = (webPaneId: string): boolean => {
    const tab = webPanes.find((pane) => pane.id === webPaneId)
    if (!tab) return false
    setFocusedPaneId(tab.anchorPaneId)
    void selectPanelTab(tab)
    setPanelRevealRequest({ tabId: tab.id, onVisible: () => setPanelRevealRequest(null), onUnavailable: () => setPanelRevealRequest(null) })
    return true
  }

  /** Selects a linked PR's side-panel tab on a sub-tab, restoring it first if it was closed. */
  const revealPrTab = (paneId: string, repo: string, number: number, subTab: PrQuickLookTab): boolean | Promise<boolean> => {
    const key = prPanelKey(repo, number)
    const tab = builtinPanelTab(paneId, key)
    const open = (selected = false) => {
      setPrSelections((current) => ({ ...current, [tab.id]: { tab: subTab, revision: (current[tab.id]?.revision ?? 0) + 1 } }))
      revealBuiltinTab(paneId, key, !selected)
      return true
    }
    if (dismissedPrTabs[paneId]?.[key] === undefined) return open()
    return restorePanePrTab(tab).then(() => open(true)).catch((error: unknown) => {
      setPaneActionError(error instanceof Error ? error.message : 'Could not restore PR tab')
      return true
    })
  }

  const openLoadedPanePr = (pr: PrSummary, subTab: PrQuickLookTab, refresh = true): boolean | Promise<boolean> => {
    const targetId = pr.commandoMarker?.targetId
    const matches = targetId ? snapshot?.panes.filter((pane) => pane.targetId === targetId) ?? [] : []
    if (matches.length !== 1) return false
    const pane = matches[0]
    const repo = new URL(pr.url).pathname.split('/').slice(1, 3).join('/').toLowerCase()
    const list = cachedPanePrs(prsApi, pane.id)
    if (list?.targetId !== pane.targetId || !list.pullRequests.some((linked) => linked.repo.toLowerCase() === repo && linked.number === pr.number)) return false
    if (pane.sessionId !== selectedSessionId || pane.windowId !== activeGroup?.windowId) jumpToPane(pane.id, targetId)
    const opened = revealPrTab(pane.id, repo, pr.number, subTab)
    if (refresh) void refreshPanePrs(prsApi, pane.id)
    return opened
  }

  const latestOpenLoadedPanePr = useRef(openLoadedPanePr)
  latestOpenLoadedPanePr.current = openLoadedPanePr
  const openPanePr = (pr: PrSummary, subTab: PrQuickLookTab): boolean | Promise<boolean | undefined> => {
    const version = ++prHudActionVersion.current
    const targetId = pr.commandoMarker?.targetId
    const matches = targetId ? snapshot?.panes.filter((pane) => pane.targetId === targetId) ?? [] : []
    if (matches.length !== 1) return false
    const pane = matches[0]
    if (cachedPanePrs(prsApi, pane.id)?.targetId === pane.targetId) return openLoadedPanePr(pr, subTab)
    return new Promise((resolve) => {
      let settled = false
      const finish = (loaded: boolean) => {
        if (settled) return
        settled = true
        window.clearTimeout(timer)
        resolve(version !== prHudActionVersion.current ? undefined : loaded ? latestOpenLoadedPanePr.current(pr, subTab, false) : false)
      }
      const timer = window.setTimeout(() => finish(false), PR_PANE_LOOKUP_TIMEOUT_MS)
      void refreshPanePrs(prsApi, pane.id).then(() => finish(true), () => finish(false))
    })
  }
  const openPrDiff = (pr: PrSummary) => openPanePr(pr, 'Diff')

  const jumpToGroup = (windowId: string) => {
    const group = groups.find((candidate) => candidate.windowId === windowId)
    if (!group || !selectedSessionId) return
    setActiveTabs((current) => ({ ...current, [selectedSessionId]: group.windowId }))
    setLeftPanelOpen(false)
  }

  const windowLayoutTree = (windowId: string): WindowLayoutNode | null => {
    const window = windowMap.get(windowId)
    return window ? parseWindowLayout(window.layout) : null
  }

  const sendWindowLayout = (windowId: string, spec: LayoutSpec | null) => {
    if (!resizeAuthorityActive || !spec) return
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

  const dropPane = (
    windowId: string,
    groupId: string,
    targetPaneId: string,
    event: DragEvent<HTMLElement>,
  ) => {
    const dragged = draggedPane
    setDraggedPane(null)
    setDropPreview(null)
    if (!dragged || dragged.groupId !== groupId) return
    if (dragged.kind === 'terminal') {
      if (dragged.paneId === targetPaneId) return
      swapWindowPanes(windowId, dragged.paneId, targetPaneId)
      return
    }
    const placement = dropPlacementFor(
      event.currentTarget.getBoundingClientRect(),
      event.clientX,
      event.clientY,
    )
    void moveWebPane(dragged.webPaneId, targetPaneId, placement)
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

  const sendPaneInputBytes = (paneId: string, data: string) => {
    if (!connected) return
    send({
      type: 'input_bytes',
      paneId,
      data,
      encoding: 'base64',
      requestId: requestId('input-bytes'),
    })
  }

  const requestPaneReset = (paneId: string) => {
    if (!connected) return
    send({ type: 'request_pane_reset', paneId, requestId: requestId('pane-reset') })
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

  /**
   * Sends the window layout built from the cached pane measurements, provided
   * every leaf has a measurement recorded under the current measurement key.
   * Called from the measurement debounce and re-invoked verbatim on
   * `resize_window_busy` retries: native panes only emit a resize when their
   * grid actually changes, so a retry cannot count on fresh pane echoes and
   * must replay the cache instead.
   */
  const applyMeasuredWindowLayout = (windowId: string, measurementKey: string) => {
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
  }

  const sendPaneResize = (
    windowId: string,
    paneId: string,
    measurementKey: string,
    cols: number,
    rows: number,
  ) => {
    if (!resizeAuthorityActive) return
    if (webLayoutAuthoritative && !maximizedPaneId) {
      paneLayoutCapacities.current.set(paneId, { paneId, cols, rows, key: measurementKey })
      const existingTimer = layoutTimers.current.get(windowId)
      if (existingTimer !== undefined) window.clearTimeout(existingTimer)
      layoutTimers.current.set(windowId, window.setTimeout(() => {
        layoutTimers.current.delete(windowId)
        applyMeasuredWindowLayout(windowId, measurementKey)
      }, 120))
      return
    }
    if (activeResizePaneId !== paneId) return
    lastFocusedResize.current = { paneId, cols, rows }
    send({ type: 'resize_pane', paneId, cols, rows, requestId: requestId('resize') })
  }

  /**
   * Measurements recorded under one key must never drive a layout produced
   * for another shape, mode, or window-activity state. The key deliberately
   * excludes the busy-retry counter: retries replay the same measurements.
   */
  const measurementKeyFor = (groupId: string, tree: WindowLayoutNode): string => [
    groupId,
    layoutShapeKey(tree),
    maximizedPaneId ?? 'grid',
    webLayoutAuthoritative ? 'authoritative' : 'focused',
    desktopWindowActive ? 'active-window' : 'inactive-window',
  ].join(':')

  /**
   * Writes splitter-drag proportions back to tmux while the web is not
   * authoritative; leaf weights come from the panes' current DOM extents.
   */
  const commitWindowLayout = (windowId: string) => {
    if (!resizeAuthorityActive || webLayoutAuthoritative || maximizedPaneId) return
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

  // On a busy-lease retry, replay what was already measured. Fresh pane
  // resize echoes cannot be relied on here: native surfaces gate emission on
  // an actual grid change, and republishing an unchanged frame emits nothing.
  useEffect(() => {
    if (resizeRetryVersion === 0 || !resizeAuthorityActiveRef.current) return
    if (webLayoutAuthoritative && !maximizedPaneId) {
      for (const group of groups) {
        const groupWindow = windowMap.get(group.windowId)
        const tree = groupWindow ? parseWindowLayout(groupWindow.layout) : null
        if (tree) applyMeasuredWindowLayout(group.windowId, measurementKeyFor(group.id, tree))
      }
      return
    }
    const stored = lastFocusedResize.current
    if (stored && stored.paneId === activeResizePaneId) {
      send({
        type: 'resize_pane',
        paneId: stored.paneId,
        cols: stored.cols,
        rows: stored.rows,
        requestId: requestId('resize-retry'),
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resizeRetryVersion])

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
    lastFocusedResize.current = null
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
  const retryAgentResume = (targetId?: string) => {
    send({ type: 'retry_agent_resume', ...(targetId ? { targetId } : {}), requestId: requestId('retry-resume') })
  }
  const sendChat = (paneId: string, text: string, images?: ChatImageRef[], options: ChatSendOptions = {}): string => {
    const id = requestId('chat-send')
    chatSendPanes.current.set(id, paneId)
    window.setTimeout(() => chatSendPanes.current.delete(id), CHAT_SEND_REFUSAL_MS)
    setChatSendErrors((current) => {
      if (!(paneId in current)) return current
      const next = { ...current }
      delete next[paneId]
      return next
    })
    if (!send({ type: 'chat_send', paneId, text, ...(images?.length ? { images } : {}), ...options, requestId: id })) {
      chatSendPanes.current.delete(id)
      setChatSendErrors((current) => ({ ...current, [paneId]: { message: "Not connected to Commando, so the message wasn't sent", refused: [{ requestId: id }] } }))
    }
    return id
  }
  const restartChat = (paneId: string) => {
    send({ type: 'chat_restart', paneId, requestId: requestId('chat-restart') })
  }
  /** Sends a queue, subagent or interrupt action; a refusal or a dropped connection shows in the pane. */
  const sendChatAction = (paneId: string, message: ClientMessage & { requestId: string }) => {
    chatActionPanes.current.set(message.requestId, paneId)
    window.setTimeout(() => chatActionPanes.current.delete(message.requestId), 30_000)
    if (!latestChatDeps.current.send(message)) {
      chatActionPanes.current.delete(message.requestId)
      setChatActionErrors((current) => ({ ...current, [paneId]: "Not connected to Commando, so that didn't reach the chat" }))
    }
  }
  const interruptChat = (paneId: string, dropQueued?: string[]) => {
    sendChatAction(paneId, { type: 'chat_interrupt', paneId, ...(dropQueued?.length ? { dropQueued } : {}), requestId: requestId('chat-interrupt') })
  }
  const configureChat = (paneId: string, settings: ChatSettingsChange) => {
    send({ type: 'chat_configure', paneId, settings, requestId: requestId('chat-configure') })
  }
  const answerChat = (paneId: string, chatRequestId: string, answer: ChatAnswer) => {
    sendChatAction(paneId, { type: 'chat_answer', paneId, chatRequestId, answer, requestId: requestId('chat-answer') })
  }
  /** Answers from a HUD card the way the island and phone do, so the first answer anywhere wins. */
  const answerFromHud = (paneId: string, request: AgentInteractionRequest, answer: AgentInteractionAnswer) => {
    const id = requestId('hud-answer')
    hudAnswerPanes.current.set(id, paneId)
    window.setTimeout(() => {
      if (!hudAnswerPanes.current.delete(id)) return
      // No reply: let the card try again.
      setHudAnswers((current) => current[paneId]?.requestId === request.id && current[paneId].pending
        ? { ...current, [paneId]: { ...current[paneId], pending: false } }
        : current)
    }, 30_000)
    const sent = send({ type: 'answer_agent_request', paneId, interactionId: request.id, answer, requestId: id })
    if (!sent) hudAnswerPanes.current.delete(id)
    setHudAnswers((current) => ({
      ...current,
      [paneId]: sent ? { requestId: request.id, pending: true } : { requestId: request.id, pending: false, error: 'Not connected to Commando' },
    }))
  }
  /** Each chat composer's unsent draft, which a switch to Claude Code carries across. */
  const chatDraftReaders = useRef(new Map<string, () => ChatDraft>())
  const switchChat = (paneId: string, action: ChatSwitchAction) => {
    const draft = action === 'cancel' ? undefined : chatDraftReaders.current.get(paneId)?.()
    sendChatAction(paneId, { type: 'chat_switch', paneId, action, ...(draft ? { draft } : {}), requestId: requestId('chat-switch') })
  }
  const returnToChat = (paneId: string) => {
    sendChatAction(paneId, { type: 'chat_return', paneId, requestId: requestId('chat-return') })
  }
  /** The pane runs Claude Code on a conversation that started as a chat, so it offers the way back. */
  const runsChatInClaudeCode = (paneId: string): boolean => {
    return !chats[paneId] && Boolean(paneChatHandoff(paneId, agentStatuses[paneId], chatHandoffEntries, chatHandoffs))
  }
  const failedResumeCount = Object.values(agentResumes).filter((resume) => resume.state === 'failed').length
  const tmuxCreateApi = createTmuxHttpApi(token)
  const chatConversationsApi = useMemo(() => createChatConversationsApi(token), [token])
  const loadConversations = useCallback(async () => {
    const conversations = await chatConversationsApi.list()
    const names = [...new Set(conversations.flatMap((conversation) => conversation.session ? [conversation.session.name] : []).filter(isSessionName))].slice(0, 500)
    try {
      const preferences = await createSessionManagementApi(token).ensureIdentities(names)
      setSessionTreePreferences(preferences)
    } catch {
      // History stays usable if preference storage is temporarily unavailable;
      // the picker can derive the same marks until the next successful load.
    }
    return conversations
  }, [chatConversationsApi, token])
  const paneManagementApi = createPaneManagementApi(token)
  const paneScreenshotsApi = createPaneScreenshotsApi(token)
  const sessionManagementApi = createSessionManagementApi(token)
  const gitDiffApi = useMemo(() => createGitDiffApi(token), [token])
  const simsApi = useMemo(() => createSimsApi(token), [token])
  const prsApi = useMemo(() => createPrsApi(token), [token])
  const agentProfilesApi = useMemo(() => createAgentProfilesApi(token), [token])
  /**
   * "Implement in a new chat pane": splits the chat's pane and starts a fresh
   * chat with the same profile and folder, in the mode the chat had before plan
   * mode, whose opening prompt is the plan (or, when too long for a pane's
   * prompt, a pointer to it saved where the new chat can read it).
   */
  const implementPlanInNewPane = async (paneId: string, plan: string, mode: ChatSessionPermissionMode): Promise<void> => {
    const pane = paneMap.get(paneId)
    if (!pane) throw new Error('The chat pane is gone')
    const session = chats[paneId]?.session
    let prompt = planImplementationPrompt(plan)
    // A plan too long for the prompt goes in a folder only this new chat may read.
    let readableDir: string | undefined
    if (new TextEncoder().encode(prompt).length > MAX_PANE_PROMPT_BYTES) {
      const stashed = await stashChatPlan(token, plan)
      prompt = implementPlanFilePrompt(stashed.path)
      readableDir = stashed.dir
    }
    const created = await tmuxCreateApi.createPane({
      targetId: paneId,
      direction: 'horizontal',
      placement: 'after',
      cwd: session?.cwd ?? pane.path,
      agent: { provider: 'claude-chat', permissionMode: launchPermissionMode(mode), prompt, ...(session?.configDir ? { configDir: session.configDir } : {}), ...(readableDir ? { readableDir } : {}) },
    })
    setMaximizedPaneId(null)
    setPendingPaneFocus({ paneId: created.paneId })
  }
  const chatStashApi = useMemo(() => createChatStashApi(token), [token])
  const chatStash = useMemo<ChatStash>(() => ({ entries: chatStashEntries, ...chatStashApi }), [chatStashEntries, chatStashApi])
  // Rebuilt only when a reading changes, not on every streamed chat item.
  const planUsageKey = Object.values(chats).map(({ session }) => `${session.provider}:${session.configDir ?? ''}:${session.planUsage?.updatedAt ?? ''}`).join(',')
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const planUsageByProfile = useMemo(() => newestPlanUsage(Object.values(chats).map((chat) => chat.session)), [planUsageKey])
  // One stable service object per pane, so the composer's effects don't refire each render.
  const chatServiceCache = useRef(new Map<string, ChatInputServices>())
  const latestChatDeps = useRef({ send, token, prsApi, implementPlanInNewPane, sendChatAction, switchChat })
  latestChatDeps.current = { send, token, prsApi, implementPlanInNewPane, sendChatAction, switchChat }
  const chatServicesFor = (paneId: string): ChatInputServices => {
    let services = chatServiceCache.current.get(paneId)
    if (!services) {
      services = {
        searchFiles: (query) => new Promise<ChatFileSearchResult>((resolve) => {
          const id = requestId('chat-files')
          const finish = (result: ChatFileSearchResult) => {
            window.clearTimeout(timer)
            chatFileSearches.current.delete(id)
            resolve(result)
          }
          const timer = window.setTimeout(() => finish({ entries: [], truncated: false, error: 'The file search timed out' }), 15_000)
          chatFileSearches.current.set(id, finish)
          if (!latestChatDeps.current.send({ type: 'chat_file_search', paneId, query, requestId: id })) {
            finish({ entries: [], truncated: false, error: 'Not connected to Commando' })
          }
        }),
        pullRequests: () => openPullRequestsForPane(latestChatDeps.current.prsApi, paneId),
        uploadImage: (image) => uploadChatImage(latestChatDeps.current.token, image),
        uploadVideo: (file) => uploadChatVideo(latestChatDeps.current.token, file),
      }
      chatServiceCache.current.set(paneId, services)
    }
    return services
  }
  const chatMcpFor = (paneId: string) => {
    let load = chatMcpLoaders.current.get(paneId)
    if (!load) {
      load = (request) => new Promise<ChatMcpResult>((resolve) => {
        const id = requestId('chat-mcp')
        const finish = (result: ChatMcpResult) => {
          window.clearTimeout(timer)
          chatMcpReplies.current.delete(id)
          resolve(result)
        }
        // The daemon gives the agent 45s; this only covers a reply that never comes.
        const timer = window.setTimeout(() => finish({ servers: [], error: 'The agent took too long to answer' }), 50_000)
        chatMcpReplies.current.set(id, finish)
        if (!latestChatDeps.current.send({ type: 'chat_mcp', paneId, request, requestId: id })) {
          finish({ servers: [], error: 'Not connected to Commando' })
        }
      })
      chatMcpLoaders.current.set(paneId, load)
    }
    return load
  }
  const chatFlowCache = useRef(new Map<string, ChatFlowServices>())
  const chatFlowFor = (paneId: string): ChatFlowServices => {
    let flow = chatFlowCache.current.get(paneId)
    if (!flow) {
      flow = {
        queue: (change) => latestChatDeps.current.sendChatAction(paneId, { type: 'chat_queue', paneId, ...change, requestId: requestId('chat-queue') }),
        stopExternal: (runId) => latestChatDeps.current.sendChatAction(paneId, { type: 'chat_external_stop', paneId, runId, requestId: requestId('chat-external-stop') }),
        task: (action, agentId, toolUseId) => latestChatDeps.current.sendChatAction(paneId, { type: 'chat_task', paneId, action, agentId, toolUseId, requestId: requestId('chat-task') }),
        subagentTranscript: (agentId) => new Promise<ChatSubagentTranscript>((resolve) => {
          const id = requestId('chat-transcript')
          const finish = (result: ChatSubagentTranscript) => {
            window.clearTimeout(timer)
            chatTranscripts.current.delete(id)
            resolve(result)
          }
          const timer = window.setTimeout(() => finish({ items: [], error: 'Reading the transcript timed out' }), 25_000)
          chatTranscripts.current.set(id, finish)
          if (!latestChatDeps.current.send({ type: 'chat_subagent_transcript', paneId, agentId, requestId: id })) {
            finish({ items: [], error: 'Not connected to Commando' })
          }
        }),
        savePlan: (markdown) => saveChatPlan(latestChatDeps.current.token, markdown),
        implementInNewPane: (plan, mode) => latestChatDeps.current.implementPlanInNewPane(paneId, plan, mode),
        switchToClaudeCode: (action) => latestChatDeps.current.switchChat(paneId, action),
        registerDraft: (read) => {
          if (read) chatDraftReaders.current.set(paneId, read)
          else chatDraftReaders.current.delete(paneId)
        },
        takeCarried: (carryId, images) => { latestChatDeps.current.send({ type: 'chat_carry_taken', paneId, carryId, images, requestId: requestId('chat-carry') }) },
        setUploading: (uploading) => setChatUploads((current) => {
          if (current.has(paneId) === uploading) return current
          const next = new Set(current)
          if (uploading) next.add(paneId)
          else next.delete(paneId)
          return next
        }),
      }
      chatFlowCache.current.set(paneId, flow)
    }
    return flow
  }
  const simulatorTabKey = webPanes.flatMap((pane) => pane.content?.kind === 'simulator' ? [pane.content.udid] : []).join(',')
  useEffect(() => {
    if (!simulatorTabKey || !connected) return
    let cancelled = false
    void simsApi.list().then((listing) => {
      if (!cancelled) setSimulatorNames(Object.fromEntries(listing.map((sim) => [sim.udid, sim.name])))
    }).catch(() => undefined)
    return () => { cancelled = true }
  }, [simulatorTabKey, connected, token])
  const webPanesApi = createWebPanesApi(token)

  const renameSelectedSession = async () => {
    if (!selectedSession) return
    setPaletteOpen(false)
    const name = window.prompt('Rename tmux session', selectedSession.name)?.trim()
    if (!name || name === selectedSession.name) return
    setPaneActionError('')
    try {
      await sessionManagementApi.renameSession(selectedSession.id, name)
    } catch (cause) {
      setPaneActionError(cause instanceof Error ? cause.message : 'Unable to rename session')
    }
  }

  const markPanelTabSeen = useCallback((tab: WebPane) => {
    const revision = tab.openRevision ?? 0
    if (seenPanelTabs.current.get(tab.id) === revision) return
    seenPanelTabs.current.set(tab.id, revision)
    void createWebPanesApi(token).clearUnseen(tab.id).then(() => {
      setWebPanes((current) => current.map((pane) => pane.id === tab.id && (pane.openRevision ?? 0) === revision ? { ...pane, unseen: false } : pane))
    }).catch((cause) => {
      if (seenPanelTabs.current.get(tab.id) === revision) seenPanelTabs.current.delete(tab.id)
      setPaneActionError(cause instanceof Error ? cause.message : 'Unable to mark tab seen')
    })
  }, [token])

  const openWebPane = async (url: string, anchorPaneId: string, engine?: WebPaneEngine) => {
    setPaneActionError('')
    try {
      await webPanesApi.open(url, anchorPaneId, undefined, engine)
    } catch (cause) {
      setPaneActionError(cause instanceof Error ? cause.message : 'Unable to open web pane')
    }
  }

  const commanderGroups = useMemo(() => commanderInbox({
    snapshot, agentStatuses, paneBriefs, paneSeen, turnBriefs, chats, relays,
    commanderPaneId: commanderState.paneId,
  }), [snapshot, agentStatuses, paneBriefs, paneSeen, turnBriefs, chats, relays, commanderState.paneId])
  const commanderRows = useMemo(() => GROUP_ORDER.flatMap((group) => commanderGroups[group].map((row) => ({ row, group }))), [commanderGroups])
  const commanderPeekEntry = commanderPeek ? commanderRows.find((entry) => entry.row.targetId === commanderPeek.targetId) : undefined
  // An agent that closed (or left the inbox) closes its reading pane.
  useEffect(() => {
    if (commanderPeek && snapshot && !commanderPeekEntry) setCommanderPeek(null)
  }, [commanderPeek, commanderPeekEntry, snapshot])
  const resumeSessionChat = (sessionId: string) => {
    const session = sessionMap.get(sessionId)
    const panes = snapshot?.panes.filter((pane) => pane.sessionId === sessionId) ?? []
    const pane = panes.find((pane) => pane.windowId === session?.activeWindowId && pane.active)
      ?? panes.find((pane) => pane.active) ?? panes[0]
    if (!session || !pane) return
    jumpToPane(pane.id)
    setActiveTabs((current) => ({ ...current, [sessionId]: pane.windowId }))
    setPanePalette({ paneId: pane.id, screen: 'conversations', sessionFilter: { id: session.id, name: session.name } })
  }
  /**
   * The session tree's menu for a read agent's session, run through the tree so both share its state.
   * Archiving or deleting warns only when other processes would stop with it; failures show here,
   * since the tree may be hidden.
   */
  const commanderPeekSessionActions = (sessionId: string): CommanderPeek['sessionActions'] => {
    const session = sessionMap.get(sessionId)
    if (!session) return undefined
    const panes = snapshot?.panes ?? []
    const run = (action: (actions: SessionActions) => Promise<void>) => () => {
      setPaneActionError('')
      if (sessionActionsRef.current) void action(sessionActionsRef.current)
    }
    const warning = () => sessionProcessesWarning(session.name, sessionProcesses(panes, sessionId, new Set(Object.keys(chats))))
    const auxiliary = auxiliarySessionIds(snapshot?.sessions ?? [], panes, commanderState.sessionId).has(sessionId)
    return [
      { label: 'Open IDE', icon: Code2, onSelect: () => { void openSessionIde(sessionId) } },
      { label: 'Change glyph…', icon: Pencil, onSelect: run((actions) => actions.changeIdentity(sessionId, false, setPaneActionError)) },
      { label: 'Reset identity', icon: RotateCcw, onSelect: run((actions) => actions.changeIdentity(sessionId, true, setPaneActionError)) },
      { label: 'Rename', icon: Pencil, onSelect: run((actions) => actions.renameSession(sessionId, setPaneActionError)) },
      { label: 'Resume a chat…', icon: RotateCcw, disabled: !connected, onSelect: () => resumeSessionChat(sessionId) },
      ...auxiliary ? [] : [{ label: 'Archive session', icon: Archive, onSelect: run((actions) => {
        const text = warning()
        return actions.archiveSession(sessionId, text ? `Archive session “${session.name}”?\n\n${text}\n\n${ARCHIVE_RESTORE_NOTE}` : null, setPaneActionError)
      }) }],
      { label: 'Delete session', icon: Trash2, danger: true, onSelect: run((actions) => {
        const text = warning()
        return actions.deleteSession(sessionId, false, text ? `Delete session “${session.name}” and all of its windows and panes?\n\n${text}` : null, setPaneActionError)
      }) },
      ...!auxiliary && panes.some((pane) => pane.sessionId === sessionId && pane.repo?.isWorktree)
        ? [{ label: 'Delete session and worktree', icon: FolderX, danger: true, onSelect: run((actions) => actions.deleteSession(sessionId, true, warning(), setPaneActionError)) }] : [],
    ]
  }
  const commanderPeekView = (): CommanderPeek | undefined => {
    if (!commanderPeekEntry) return undefined
    const { row, group } = commanderPeekEntry
    const chat = chats[row.paneId], pane = paneMap.get(row.paneId), status = agentStatuses[row.paneId]
    const view = chat
      // Not given registerFocusable: the agent's own pane keeps that.
      ? <ChatPane key={row.targetId} paneId={row.paneId} {...(pane ? { pane } : {})} snapshot={snapshot ?? undefined} statuses={agentStatuses}
          onSelectPane={jumpToPane} prsApi={prsApi} chat={chat} externalRuns={externalRuns[row.paneId] ?? []} tileEvents={tileEvents[row.paneId] ?? []} onOpenTile={revealWebPaneTab} connected={connected}
          focused={false} onFocus={() => {}}
          onSend={(text, images, options) => sendChat(row.paneId, text, images, options)}
          onInterrupt={(dropQueued) => interruptChat(row.paneId, dropQueued)}
          onAnswer={(chatRequestId, answer) => answerChat(row.paneId, chatRequestId, answer)}
          onConfigure={(settings) => configureChat(row.paneId, settings)}
          onRestart={() => restartChat(row.paneId)}
          onOpenPr={(repo, number, tab) => { void revealPrTab(row.paneId, repo, number, tab) }}
          services={chatServicesFor(row.paneId)} flow={chatFlowFor(row.paneId)}
          {...(chatSendErrors[row.paneId] ? { sendError: chatSendErrors[row.paneId] } : {})}
          onDismissSendError={() => setChatSendErrors((current) => { const next = { ...current }; delete next[row.paneId]; return next })}
          {...(chatActionErrors[row.paneId] ? { actionError: chatActionErrors[row.paneId] } : {})}
          onDismissActionError={() => setChatActionErrors((current) => { const next = { ...current }; delete next[row.paneId]; return next })} />
      : <CommanderTranscriptView key={row.targetId} token={token} row={row} provider={status?.provider === 'codex' ? 'codex' : 'claude'} cwd={pane?.path ?? ''}
          refreshKey={`${status?.status ?? ''}:${status?.settledAt ?? ''}`} disabled={!connected}
          onRelay={(relay) => dispatchCommander({ type: 'commander_relay', relay })} />
    const sessionActions = pane ? commanderPeekSessionActions(pane.sessionId) : undefined
    return {
      row, group,
      // Keyed by agent, so stepping to another agent starts on its chat.
      view: pane ? <CommanderPeekTabs key={row.targetId} pane={pane} chat={view}
        webTabs={webPanes.filter((webPane) => webPane.anchorPaneId === pane.id && webPane.dock !== 'split')}
        gitApi={gitDiffApi} prsApi={prsApi} connected={connected}
        sessionUnseen={sessionAttention[pane.id]} sessionWarning={sessionWarnings[pane.id]} dismissedPrs={dismissedPrTabs[pane.id]}
        titles={webPaneTitles} simulatorNames={simulatorNames} renderBuiltin={renderBuiltinPanelTab} renderTab={renderWebPane} /> : view,
      ...sessionActions ? { sessionActions } : {},
      onClose: () => setCommanderPeek(null),
      onOpen: () => jumpToPane(row.paneId, row.targetId, true),
      onStep: (direction) => {
        const next = commanderRows[(commanderRows.indexOf(commanderPeekEntry) + direction + commanderRows.length) % commanderRows.length]
        if (next) setCommanderPeek({ paneId: next.row.paneId, targetId: next.row.targetId })
      },
    }
  }

  const paneSimulators = useMemo(() => Object.fromEntries((snapshot?.panes ?? []).flatMap((pane) => {
    const brief = paneBriefs[pane.id]
    return brief?.simulator && (!brief.targetId || brief.targetId === pane.targetId) ? [[pane.id, brief.simulator]] : []
  })), [snapshot?.panes, paneBriefs])
  const showSimulator = async (udid: string, anchorPaneId: string) => {
    setPaneActionError('')
    try {
      const existing = webPanes.find((tile) => tile.content?.kind === 'simulator' && tile.content.udid === udid.toUpperCase())
      const id = existing?.id ?? (await simsApi.show(udid, anchorPaneId)).webPaneId
      setArea('workspace')
      setPendingPaneFocus(null)
      setMaximizedPaneId(null)
      setPendingSimulatorTileId(id)
    } catch (cause) {
      setPaneActionError(cause instanceof Error ? cause.message : 'Unable to show simulator')
    }
  }

  useEffect(() => {
    if (!pendingSimulatorTileId) return
    // Creation and its broadcast can arrive in either order; reveal only once the tile is mounted.
    const tab = webPanes.find((tile) => tile.id === pendingSimulatorTileId)
    if (!tab) return
    if (selectedSessionId !== tab.sessionId || activeGroup?.windowId !== tab.windowId) {
      setSelectedSessionId(tab.sessionId)
      setActiveTabs((current) => ({ ...current, [tab.sessionId]: tab.windowId }))
      return
    }
    setFocusedPaneId(tab.anchorPaneId)
    setActiveSimulatorTileId(tab.id)
    if (tab.dock === 'split') {
      setMaximizedBuiltinTab(null)
      setPanelRevealRequest(null)
      const tile = document.querySelector<HTMLElement>(`[data-web-pane-id="${tab.id}"]`)
      tile?.scrollIntoView?.({ block: 'nearest' })
      tile?.querySelector<HTMLCanvasElement>('canvas:not([hidden])')?.focus()
      setPendingSimulatorTileId(null)
      return
    }
    void selectPanelTab(tab)
    setPanelRevealRequest({
      tabId: tab.id,
      onVisible: () => {
        const tile = document.querySelector<HTMLElement>(`[data-web-pane-id="${tab.id}"]`)
        if (tile && !tile.closest('[hidden]')) {
          tile.scrollIntoView?.({ block: 'nearest' })
          tile.querySelector<HTMLCanvasElement>('canvas:not([hidden])')?.focus()
        }
        setPanelRevealRequest(null)
      },
    })
    setPendingSimulatorTileId(null)
  }, [pendingSimulatorTileId, webPanes, selectedSessionId, activeGroup?.windowId])

  const dismissPanePrTab = async (tab: BuiltinPanelTab, signature: string, next?: PanelTab) => {
    const previousActiveKey = panelActiveTabs[tab.anchorPaneId]
    const previousMaximizedBuiltinTab = maximizedBuiltinTab
    const previousMaximizedPaneId = maximizedPaneId
    const previousWebActiveTabs = new Map(webPanes.map((pane) => [pane.id, pane.activeTab]))
    setPaneActionError('')
    if (next) selectPanelTabLocally(next)
    try {
      await webPanesApi.dismissPrTab(tab.anchorPaneId, tab.key, signature, next ? panelTabKey(next) : undefined)
      setDismissedPrTabs((current) => ({ ...current, [tab.anchorPaneId]: { ...current[tab.anchorPaneId], [tab.key]: signature } }))
    } catch (error) {
      setPanelActiveTabs((current) => {
        const restored = { ...current }
        if (previousActiveKey === undefined) delete restored[tab.anchorPaneId]
        else restored[tab.anchorPaneId] = previousActiveKey
        return restored
      })
      setMaximizedBuiltinTab(previousMaximizedBuiltinTab)
      setMaximizedPaneId(previousMaximizedPaneId)
      setWebPanes((current) => current.map((pane) => pane.anchorPaneId === tab.anchorPaneId
        ? { ...pane, activeTab: previousWebActiveTabs.get(pane.id) } : pane))
      setPaneActionError(error instanceof Error ? error.message : 'Could not close PR tab')
    }
  }

  const closeWebPane = async (webPaneId: string) => {
    setPaneActionError('')
    if (activeSimulatorTileId === webPaneId) setActiveSimulatorTileId(null)
    const closing = webPanes.find((pane) => pane.id === webPaneId)
    const combined = closing ? panelTabSets.current.get(closing.anchorPaneId) ?? [] : []
    const selected = closing ? panelActiveTabs[closing.anchorPaneId] ?? activePanelTab(panelTabs(webPanes, closing.anchorPaneId))?.id : undefined
    let selection: Promise<void> | undefined
    if (selected === webPaneId) {
      const next = resolveActivePanelTab(combined.filter((tab) => tab.id !== webPaneId), selected, combined)
      if (next) selection = selectPanelTab(next)
    }
    // Drop the tile locally; the daemon broadcast confirms it.
    setWebPanes((current) => {
      const closing = current.find((pane) => pane.id === webPaneId)
      const tabs = closing && closing.dock !== 'split' ? panelTabs(current, closing.anchorPaneId) : []
      const next = activePanelTab(tabs)?.id === webPaneId ? neighbouringTab(tabs, webPaneId) : undefined
      return current.filter((pane) => pane.id !== webPaneId).map((pane) => next && pane.anchorPaneId === closing?.anchorPaneId && pane.dock !== 'split'
        ? { ...pane, activeTab: pane.id === next }
        : pane)
    })
    try {
      await selection
      await webPanesApi.close(webPaneId)
    } catch (cause) {
      setPaneActionError(cause instanceof Error ? cause.message : 'Unable to close web pane')
    }
  }

  const dockWebPane = async (webPane: WebPane) => {
    setPaneActionError('')
    if (maximizedPaneId === webPane.id) {
      clearLayoutTimers()
      setMaximizedPaneId(null)
    }
    const dock = webPane.dock === 'split' ? 'panel' : 'split'
    const anchor = paneMap.get(webPane.anchorPaneId)
    try {
      await webPanesApi.dock(webPane.id, dock,
        dock === 'split' && anchor ? { cols: anchor.width, rows: anchor.height } : undefined)
    } catch (cause) {
      setPaneActionError(cause instanceof Error ? cause.message : 'Unable to change web pane dock')
    }
  }

  const moveWebPane = async (
    webPaneId: string,
    anchor: string,
    placement: 'right' | 'below',
  ) => {
    setPaneActionError('')
    try {
      await webPanesApi.move(webPaneId, anchor, placement)
    } catch (cause) {
      setPaneActionError(cause instanceof Error ? cause.message : 'Unable to move web pane')
    }
  }

  const navigateWebPane = async (webPaneId: string, url: string) => {
    setPaneActionError('')
    try {
      await webPanesApi.navigate(webPaneId, url)
    } catch (cause) {
      setPaneActionError(cause instanceof Error ? cause.message : 'Unable to change web pane URL')
    }
  }

  const answerWebPaneNavigateRequest = async (webPaneId: string, requestId: string, accept: boolean) => {
    setPaneActionError('')
    try {
      await webPanesApi.answerNavigateRequest(webPaneId, requestId, accept ? 'accept' : 'dismiss')
    } catch (cause) {
      setPaneActionError(cause instanceof Error ? cause.message : 'Unable to answer the navigate request')
    }
  }

  const confirmWebPane = async (webPaneId: string, allowOrigin: boolean) => {
    setPaneActionError('')
    try {
      await webPanesApi.confirm(webPaneId, allowOrigin)
    } catch (cause) {
      setPaneActionError(cause instanceof Error ? cause.message : 'Unable to open web pane')
    }
  }

  /** Opens a chromium tile's DevTools frontend as a sibling tile. */
  const openWebPaneDevtools = async (webPane: WebPane) => {
    setPaneActionError('')
    try {
      const { devtoolsFrontendUrl } = await webPanesApi.cdp(webPane.id)
      await webPanesApi.open(devtoolsFrontendUrl, webPane.anchorPaneId, webPane.placement)
    } catch (cause) {
      setPaneActionError(cause instanceof Error ? cause.message : 'Unable to open DevTools tile')
    }
  }

  const openPaneMenu = (paneId: string, x: number, y: number) => {
    setFocusedPaneId(paneId)
    setPaletteOpen(false)
    setPaneActionError('')
    setPaneMenu({ paneId, x, y })
  }

  const closePaneMenu = () => {
    const paneId = paneMenu?.paneId
    setPaneMenu(null)
    if (!paneId) return
    window.requestAnimationFrame(() => {
      const node = paneRefs.current.get(paneId)
      if (!node?.isConnected) return
      node.focus({ preventScroll: true })
      setFocusedPaneId(paneId)
    })
  }

  const renamePane = async (paneId: string, title: string) => {
    await paneManagementApi.renamePane(paneId, title)
  }

  const setPaneMark = async (paneId: string, label: string, tone: PaneMarkTone) => {
    const targetId = paneMap.get(paneId)?.targetId
    if (!targetId) return
    setPaneActionError('')
    try {
      await paneManagementApi.setPaneMark(paneId, targetId, label, tone)
    } catch (cause) {
      setPaneActionError(cause instanceof Error ? cause.message : 'Unable to mark pane')
    }
  }

  const acknowledgePaneMark = async (paneId: string) => {
    const targetId = paneMap.get(paneId)?.targetId
    if (!targetId) return
    setPaneActionError('')
    try {
      await paneManagementApi.acknowledgePaneMark(paneId, targetId)
    } catch (cause) {
      setPaneActionError(cause instanceof Error ? cause.message : 'Unable to acknowledge pane activity')
    }
  }

  const clearPaneMark = async (paneId: string) => {
    const targetId = paneMap.get(paneId)?.targetId
    if (!targetId) return
    setPaneActionError('')
    try {
      await paneManagementApi.clearPaneMark(paneId, targetId)
    } catch (cause) {
      setPaneActionError(cause instanceof Error ? cause.message : 'Unable to clear pane status')
    }
  }

  /** A Codex, Muse or Cursor chat launch with the permission mode remembered for the path's repository. */
  const rememberedProviderChatLaunch = async (path: string, provider: 'codex-chat' | 'muse-chat' | 'cursor-chat'): Promise<SessionAgentLaunch> => {
    const repoRoot = await gitDiffApi.repo(path).then((info) => info.mainRoot, () => undefined)
    return { provider, ...chatLaunchPermission(provider, loadChatLaunch(repoRoot ?? path, provider).permissionMode) }
  }

  /** A chat launch with the profile and permissions remembered for the path's repository, as in the new-session dialog. */
  const rememberedChatLaunch = async (path: string): Promise<SessionAgentLaunch> => {
    const [repoRoot, profiles] = await Promise.all([
      gitDiffApi.repo(path).then((info) => info.mainRoot, () => undefined),
      tmuxCreateApi.claudeProfiles().catch((error: unknown) => {
        console.warn('[commando] Claude profiles unavailable; using the remembered profile', error)
        return null
      }),
    ])
    const preference = loadChatLaunch(repoRoot ?? path)
    // Check the remembered profile against the current ones, as the dialog does, so a
    // stale or missing preference never falls back to the daemon's own login.
    const configDir = profiles ? chatProfileConfigDir(preference.configDir, profiles) : preference.configDir
    if (!profiles && !configDir) throw new Error("Couldn't load your Claude profiles, so this chat's login is unknown. Try again, or start it from New session.")
    return { provider: 'claude-chat', permissionMode: preference.permissionMode, ...(configDir ? { configDir } : {}) }
  }

  const launchInEmptyPane = async (paneId: string, choice: EmptyPaneChoice) => {
    const pane = paneMap.get(paneId)
    if (!pane || paneActionPending) return
    setPaneActionPending(true)
    setPaneActionError('')
    try {
      const agent = choice === 'shell' ? undefined
        : choice === 'claude-chat' ? await rememberedChatLaunch(pane.path)
          : choice === 'codex-chat' || choice === 'muse-chat' || choice === 'cursor-chat' ? await rememberedProviderChatLaunch(pane.path, choice)
            : { provider: choice }
      await tmuxCreateApi.launchInEmptyPane({ paneId, ...(agent ? { agent } : {}) })
      // Focus lands once the snapshot swaps the launcher for the running pane.
      setPendingPaneFocus({ paneId })
    } catch (cause) {
      setPaneActionError(cause instanceof Error ? cause.message : 'Unable to start in this pane')
    } finally {
      setPaneActionPending(false)
    }
  }

  const splitPane = async (paneId: string, direction: PaneSplitDirection, chat = false) => {
    const pane = paneMap.get(paneId)
    if (!pane || paneActionPending) return
    setPaneActionPending(true)
    setPaneActionError('')
    clearLayoutTimers()
    try {
      const before = direction === 'left' || direction === 'up'
      const agent = chat ? await rememberedChatLaunch(pane.path) : undefined
      const created = await tmuxCreateApi.createPane({
        targetId: paneId,
        direction: direction === 'left' || direction === 'right' ? 'horizontal' : 'vertical',
        placement: before ? 'before' : 'after',
        cwd: pane.path,
        // A plain new pane starts empty, offering the same choices as an empty session.
        ...(agent ? { agent } : { empty: true }),
      })
      setMaximizedPaneId(null)
      setPendingPaneFocus({ paneId: created.paneId })
    } catch (cause) {
      setPaneActionError(cause instanceof Error ? cause.message : 'Unable to split pane')
    } finally {
      setPaneActionPending(false)
    }
  }

  /** Closing a session's only pane leaves it empty, so an empty one has nothing to close. */
  const canClosePane = (pane: TmuxPane) => !pane.empty || Boolean(snapshot?.panes.some((other) => other.sessionId === pane.sessionId && other.id !== pane.id))

  const killPane = async (paneId: string) => {
    const pane = paneMap.get(paneId)
    if (!pane || paneActionPending || !canClosePane(pane)) return
    const label = pane.title || pane.command || `Pane ${pane.index}`
    // An empty pane runs nothing worth confirming.
    if (!pane.empty && !window.confirm(`Kill pane "${label}"? Its running process will be terminated.`)) return
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

  // The workspace picker also resumes beside running terminals and into empty panes.
  useEffect(() => {
    // Only in the workspace: elsewhere the last focused chat is hidden.
    const canToggle = (paneId: string | null | undefined): paneId is string => Boolean(connected && area === 'workspace' && !paletteOpen && paneId && paneMap.has(paneId))
    const toggle = (paneId: string) => {
      // Closes only a palette that is showing; one whose pane went away opens afresh.
      const showing = panePalette && paneMap.has(panePalette.paneId) ? panePalette : null
      // ⌘P ⌘P goes straight on to resuming a conversation.
      if (showing?.screen === 'menu') {
        setPanePalette({ paneId: showing.paneId, screen: 'conversations' })
        return
      }
      setPanePalette(showing ? null : { paneId, screen: 'menu' })
      // The palette shows in its pane, and closes once another pane takes focus.
      if (!showing) setFocusedPaneId(paneId)
    }
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (!event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || event.key.toLowerCase() !== 'p') return
      const target = event.target instanceof Element ? event.target.closest('[data-pane-id]')?.getAttribute('data-pane-id') : undefined
      const paneId = target ?? focusedPaneId
      if (!canToggle(paneId)) return
      event.preventDefault()
      event.stopPropagation()
      if (event.repeat) return
      toggle(paneId)
    }
    // A focused native terminal keeps ⌘P from the page; the desktop app forwards it instead.
    const onNativeShortcut = (event: Event) => {
      if ((event as CustomEvent<{ key?: string }>).detail?.key === 'p' && canToggle(focusedPaneId)) toggle(focusedPaneId)
    }
    window.addEventListener('keydown', onKeyDown, true)
    window.addEventListener(NATIVE_TERMINAL_SHORTCUT_EVENT, onNativeShortcut)
    return () => {
      window.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener(NATIVE_TERMINAL_SHORTCUT_EVENT, onNativeShortcut)
    }
  })

  // Like a menu, the palette closes when another pane is focused (a native terminal
  // click reaches the page only as focus) or its pane leaves the screen.
  const palettePaneShown = area === 'workspace' && Boolean(palettePaneId && allVisiblePaneIds.includes(palettePaneId))
  useEffect(() => {
    if (palettePaneId && (!palettePaneShown || (effectivePaneId && effectivePaneId !== palettePaneId && pendingPaneFocus?.paneId !== palettePaneId))) setPanePalette(null)
  }, [palettePaneId, palettePaneShown, effectivePaneId, pendingPaneFocus])

  const reopenConversation = async () => {
    if (!connected || area !== 'workspace' || paletteOpen || reopeningConversation.current) return
    reopeningConversation.current = true
    try {
      // Most recently closed, not most recently written; skip any that is open somewhere after all.
      const conversation = (await loadConversations()).filter((entry) => entry.session && entry.paneOpen === false && !entry.openPaneId)
        .sort((a, b) => (b.closedAt ?? b.updatedAt) - (a.closedAt ?? a.updatedAt))[0]
      if (!conversation) {
        const message = 'No closed agent conversation to reopen'
        setPaneActionError(message)
        window.setTimeout(() => setPaneActionError((current) => current === message ? '' : current), 3000)
        return
      }
      const paneId = await chatConversationsApi.resume({ provider: conversation.provider, sessionId: conversation.sessionId, placement: 'session' })
      setPanePalette(null)
      setPendingPaneFocus({ paneId, waitForCreation: true })
    } catch (error) {
      setPaneActionError(error instanceof Error ? error.message : 'Could not reopen conversation')
    } finally {
      reopeningConversation.current = false
    }
  }

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (!event.metaKey || !event.shiftKey || event.ctrlKey || event.altKey || event.key.toLowerCase() !== 't') return
      if (!connected || area !== 'workspace' || paletteOpen) return
      event.preventDefault()
      event.stopPropagation()
      if (!event.repeat) void reopenConversation()
    }
    const onNativeShortcut = (event: Event) => {
      if ((event as CustomEvent<{ key?: string }>).detail?.key === 'T') void reopenConversation()
    }
    window.addEventListener('keydown', onKeyDown, true)
    window.addEventListener(NATIVE_TERMINAL_SHORTCUT_EVENT, onNativeShortcut)
    return () => {
      window.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener(NATIVE_TERMINAL_SHORTCUT_EVENT, onNativeShortcut)
    }
  })

  useEffect(() => {
    const runPaneShortcut = (key: string) => {
      if (!connected || area !== 'workspace' || paletteOpen || paneMenu || renamingPaneId || screenshotLightbox) return
      if (!currentPrPane || currentPrPane.sessionId !== selectedSessionId) return
      if (key === 'w') void killPane(currentPrPane.id)
      if (key === 't') void splitPane(currentPrPane.id, 'right')
    }
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (!event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return
      const key = event.key.toLowerCase()
      if (key !== 'w' && key !== 't') return
      event.preventDefault()
      event.stopPropagation()
      if (!event.repeat) runPaneShortcut(key)
    }
    const onNativeShortcut = (event: Event) => {
      const key = (event as CustomEvent<{ key?: string }>).detail?.key
      if (key === 'w' || key === 't') runPaneShortcut(key)
    }
    // Capture before the terminal or an embedded tile can forward these keys.
    window.addEventListener('keydown', onKeyDown, true)
    window.addEventListener(NATIVE_TERMINAL_SHORTCUT_EVENT, onNativeShortcut)
    return () => {
      window.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener(NATIVE_TERMINAL_SHORTCUT_EVENT, onNativeShortcut)
    }
  })

  const conversationPane = palettePaneId ? paneMap.get(palettePaneId) : undefined
  const conversationChat = palettePaneId ? chats[palettePaneId] : undefined
  const conversationSessionFilter = panePalette?.sessionFilter
  const backToPaneMenu = () => setPanePalette((current) => current && { paneId: current.paneId, screen: 'menu' })
  const conversationPicker = conversationPane ? (
    <ConversationPicker
      key={`${conversationPane.id}:${conversationSessionFilter?.id ?? ''}`}
      pane={conversationPane}
      sessionIdentities={sessionTreePreferences.sessionIdentities}
      {...(conversationSessionFilter ? { initialSessionFilter: conversationSessionFilter } : {})}
      defaultPlacement={conversationSessionFilter ? 'session' : conversationChat || conversationPane.empty ? 'replace' : 'split'}
      sessionName={sessionMap.get(conversationPane.sessionId)?.name ?? conversationPane.sessionId}
      {...(conversationChat?.session.sessionId ? { current: chatConversationKey(conversationChat.session.provider, conversationChat.session.sessionId) } : {})}
      chats={chats}
      paneLabel={(paneId) => {
        const pane = paneMap.get(paneId)
        return (pane && sessionMap.get(pane.sessionId)?.name) ?? paneId
      }}
      busy={conversationChat?.session.status === 'running' || conversationChat?.session.status === 'waiting'}
      load={loadConversations}
      onPick={async (conversation, placement) => {
        const paneId = await chatConversationsApi.resume({ paneId: conversationPane.id, provider: conversation.provider, sessionId: conversation.sessionId, placement })
        setPanePalette(null)
        setPendingPaneFocus({ paneId, waitForCreation: true })
      }}
      onJump={(paneId) => {
        setPanePalette(null)
        jumpToPane(paneId, undefined, true)
      }}
      onClose={() => setPanePalette(null)}
      onBack={backToPaneMenu}
    />
  ) : null
  const panePaletteNode = !conversationPane || !panePalette ? null
    : panePalette.screen === 'conversations' ? conversationPicker
      : panePalette.screen === 'mcp' && conversationChat ? (
        <McpSettings
          key={`${conversationPane.id}:mcp`}
          agentLabel={providerLabel(conversationChat.session)}
          load={chatMcpFor(conversationPane.id)}
          onBack={backToPaneMenu}
          onClose={() => setPanePalette(null)}
        />
      ) : (
        <PanePaletteMenu
          key={`${conversationPane.id}:menu`}
          entries={panePaletteEntries(conversationChat && {
            provider: conversationChat.session.provider,
            providerLabel: providerLabel(conversationChat.session),
            hostConnected: conversationChat.hostConnected,
            takesMcp: hostTakesMcp(conversationChat.session),
          })}
          onOpen={(screen) => setPanePalette((current) => current && { paneId: current.paneId, screen })}
          onClose={() => setPanePalette(null)}
        />
      )
  const paletteWebPaneUrl = webPaneUrlFromQuery(paletteQuery)
  const paletteRunCommand = runCommandFromQuery(paletteQuery)
  const paletteRunPane = currentPrPane && !currentPrPane.dead ? currentPrPane : undefined
  const webPaneAnchorId = activeGroup && focusedPaneId && activeGroup.paneIds.includes(focusedPaneId)
    ? focusedPaneId
    : activeGroup?.paneIds[0]
  const paletteMarkPane = focusedPaneId ? paneMap.get(focusedPaneId) : currentPrPane
  const palettePaneMark = paletteMarkPane ? paneMarks[paletteMarkPane.targetId] : undefined
  const commands: PaletteCommand[] = [
    ...(paletteRunCommand ? [{
      id: 'command:run',
      label: `Run ${paletteRunCommand}`,
      detail: paletteRunPane
        ? `Run from ${paletteRunPane.path}`
        : 'No active pane available',
      kind: 'action' as const,
      run: () => {
        setPaletteOpen(false)
        if (!paletteRunPane) return
        setPaneActionError('')
        void paneManagementApi.runInPanePath(paletteRunPane.id, paletteRunCommand).catch((cause) => {
          setPaneActionError(cause instanceof Error ? cause.message : 'Unable to run command')
        })
      },
    }] : []),
    ...(paletteWebPaneUrl ? [{
      id: 'web-pane:open',
      label: `Open ${paletteWebPaneUrl} as a web tile`,
      detail: webPaneAnchorId
        ? 'Embed the page beside the focused pane'
        : 'No pane available to anchor the tile',
      kind: 'action' as const,
      run: () => {
        if (webPaneAnchorId) void openWebPane(paletteWebPaneUrl, webPaneAnchorId)
        setPaletteOpen(false)
      },
    }, {
      id: 'web-pane:open-chromium',
      label: `Open ${paletteWebPaneUrl} as a Chromium (CDP) tile`,
      detail: webPaneAnchorId
        ? 'Debuggable stream — agents can attach DevTools to this page'
        : 'No pane available to anchor the tile',
      kind: 'action' as const,
      run: () => {
        if (webPaneAnchorId) void openWebPane(paletteWebPaneUrl, webPaneAnchorId, 'chromium')
        setPaletteOpen(false)
      },
    }] : []),
    ...(paletteMarkPane ? PANE_MARK_PRESETS.map((preset) => ({
      id: `pane-mark:${preset.id}`,
      label: `Mark pane: ${preset.label}`,
      detail: palettePaneMark?.label === preset.label
        ? `Current status for ${paletteMarkPane.title || paletteMarkPane.command || `pane ${paletteMarkPane.index}`}`
        : `Apply to ${paletteMarkPane.title || paletteMarkPane.command || `pane ${paletteMarkPane.index}`}`,
      kind: 'action' as const,
      run: () => {
        setPaletteOpen(false)
        void setPaneMark(paletteMarkPane.id, preset.label, preset.tone)
      },
    })) : []),
    ...(paletteMarkPane ? [{
      id: 'pane-mark:custom',
      label: 'Mark pane: Custom status',
      detail: `Apply a custom label to ${paletteMarkPane.title || paletteMarkPane.command || `pane ${paletteMarkPane.index}`}`,
      kind: 'action' as const,
      run: () => {
        setPaletteOpen(false)
        const label = window.prompt('Custom pane status', palettePaneMark?.label ?? '')?.trim()
        if (label) void setPaneMark(paletteMarkPane.id, label, 'purple')
      },
    }] : []),
    ...(paletteMarkPane && palettePaneMark?.activityCount ? [{
      id: 'pane-mark:acknowledge',
      label: `Acknowledge pane activity (${palettePaneMark.activityCount})`,
      detail: `Keep “${palettePaneMark.label}” and clear its activity alarm`,
      kind: 'action' as const,
      run: () => {
        setPaletteOpen(false)
        void acknowledgePaneMark(paletteMarkPane.id)
      },
    }] : []),
    ...(paletteMarkPane && palettePaneMark ? [{
      id: 'pane-mark:clear',
      label: 'Clear pane status',
      detail: `Remove “${palettePaneMark.label}” from this pane`,
      kind: 'action' as const,
      run: () => {
        setPaletteOpen(false)
        void clearPaneMark(paletteMarkPane.id)
      },
    }] : []),
    {
      id: 'refresh',
      label: 'Refresh daemon snapshot',
      detail: connected ? 'Request current tmux state' : 'Unavailable while disconnected',
      kind: 'action',
      run: refresh,
    },
    ...(selectedSession ? [{
      id: `session:rename:${selectedSession.id}`,
      label: `Rename session: ${selectedSession.name}`,
      detail: 'Change the name of the selected tmux session',
      kind: 'session' as const,
      run: () => { void renameSelectedSession() },
    }] : []),
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
      label: `Apply ${preset.label.toLowerCase()} to the visible window`,
      detail: 'Restructure the tmux panes of the visible window now',
      kind: 'layout' as const,
      run: () => {
        if (activeGroup) restructureWindow(activeGroup.windowId, preset.id)
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
      tokenBrokerRef.current?.clear()
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

  const hudGroups = agentHudGroups(
    agentStatuses,
    paneMap,
    snapshot?.sessions ?? [],
    sessionTreePreferences,
    agentHudDismissals,
  )
  const hudStatuses = hudGroups.flatMap((group) => group.statuses)
  const visibleHudGroups = filterAgentHudGroups(hudGroups, agentHudFilter)
  const visibleHudStatuses = visibleHudGroups.flatMap((group) => group.statuses)
  const attentionCount = hudStatuses.filter(
    agentNeedsAttention,
  ).length
  const workingCount = hudStatuses.filter((status) => status.status === 'working').length
  const doneCount = hudStatuses.filter((status) => status.status === 'done').length
  const hasKnownHudStatuses = Object.values(agentStatuses).some((status) => paneMap.has(status.paneId))
  const activeHudFilterLabel = agentHudFilter === 'attention'
    ? 'Need you'
    : agentHudFilter === 'working'
      ? 'Working'
      : agentHudFilter === 'done'
        ? 'Done'
        : ''
  const activeHudFilterEmptyTitle = agentHudFilter === 'attention'
    ? 'No agents need you'
    : agentHudFilter === 'working'
      ? 'No agents are working'
      : agentHudFilter === 'done'
        ? 'No done agents'
        : ''
  const contextPane = paneMenu ? paneMap.get(paneMenu.paneId) : undefined
  const contextPaneIdentity = contextPane ? paneRendererIdentity(contextPane) : null
  const storedContextRendererControl = paneMenu ? paneRendererControls.get(paneMenu.paneId) : undefined
  const contextRendererControl = storedContextRendererControl?.identity === contextPaneIdentity
    ? storedContextRendererControl
    : undefined
  const contextUsesXterm = Boolean(
    contextRendererControl?.manualXterm || contextRendererControl?.actual === 'xterm',
  )

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
          tokenBrokerRef.current?.clear()
          setToken('')
          setSnapshot(null)
          setAuthUser(user)
          setAuthBootstrap((current) => current ? { ...current, needsOwner: false } : current)
        }}
        onToken={(nextToken) => {
          setSnapshot(null)
          tokenBrokerRef.current?.setToken(nextToken)
          setToken(nextToken)
        }}
      />
    )
  }

  /**
   * A web tab (browser, canvas, guide, simulator), in a window group or Commander's reading pane.
   * Docking, maximizing and dragging rearrange the tile's own window, so only a group offers them.
   */
  const renderWebPane = (webPane: WebPane, visible: boolean, groupId?: string) => (
    <WebPaneCard
      key={webPane.id}
      webPane={webPane}
      visible={visible}
      onTitle={(title) => setWebPaneTitles((current) => current[webPane.id] === title ? current : { ...current, [webPane.id]: title })}
      simulatorActive={activeSimulatorTileId === webPane.id}
      onActivateSimulator={() => setActiveSimulatorTileId(webPane.id)}
      onClose={() => void closeWebPane(webPane.id)}
      onConfirm={(allowOrigin) => void confirmWebPane(webPane.id, allowOrigin)}
      wsToken={token}
      connected={connected}
      onOpenDevtools={
        webPane.engine === 'chromium'
          ? () => void openWebPaneDevtools(webPane)
          : undefined
      }
      detached={detachedWebPaneIds.has(webPane.id)}
      onPopOut={
        nativeWindowBridge && webPane.engine === 'chromium' && webPane.status === 'open'
          ? () => nativeWindowBridge.open(webPane.id)
          : undefined
      }
      onFocusDetached={
        nativeWindowBridge ? () => nativeWindowBridge.focus(webPane.id) : undefined
      }
      onReattach={
        nativeWindowBridge ? () => nativeWindowBridge.reattach(webPane.id) : undefined
      }
      feedback={webPaneFeedback[webPane.id]}
      pendingQueue={{
        list: () => webPanesApi.pendingNotes(webPane.id),
        add: (note) => webPanesApi.addPendingNote(webPane.id, note),
        addResponse: (pageUrl, response) => webPanesApi.addPendingResponse(
          webPane.id,
          pageUrl,
          response,
        ),
        update: (noteId, revision, change) => webPanesApi.updatePendingNote(
          webPane.id,
          noteId,
          revision,
          change,
        ),
        upload: (noteId, revision, file) => webPanesApi.uploadPendingAttachment(
          webPane.id,
          noteId,
          revision,
          file,
        ),
        removeAttachment: (noteId, revision, attachmentId) => (
          webPanesApi.removePendingAttachment(
            webPane.id,
            noteId,
            revision,
            attachmentId,
          )
        ),
        attachmentUrl: (attachmentId) => webPanesApi.pendingAttachmentUrl(
          webPane.id,
          attachmentId,
        ),
        remove: (noteId) => webPanesApi.removePendingNote(webPane.id, noteId),
        send: (ids, options) => webPanesApi.sendPendingNotes(
          webPane.id,
          ids,
          options,
        ),
        dismissDropped: () => webPanesApi.dismissPendingDropped(webPane.id),
        setPage: (url) => webPanesApi.setPendingPage(webPane.id, url),
      }}
      {...groupId ? {
        onDock: () => void dockWebPane(webPane),
        maximized: maximizedPaneId === webPane.id,
        onMaximize: () => {
          clearLayoutTimers()
          setMaximizedPaneId((current) => (current === webPane.id ? null : webPane.id))
        },
        onDragStart: (event: DragEvent<HTMLElement>) => {
          setDraggedPane({ kind: 'web', groupId, webPaneId: webPane.id })
          event.dataTransfer.effectAllowed = 'move'
          event.dataTransfer.setData('text/plain', webPane.id)
        },
        onDragEnd: () => {
          setDraggedPane(null)
          setDropPreview(null)
        },
      } : {}}
      onNavigate={(url) => void navigateWebPane(webPane.id, url)}
      navigateRequest={webPaneNavigateRequests[webPane.id]}
      onAnswerNavigateRequest={(requestId, accept) => (
        void answerWebPaneNavigateRequest(webPane.id, requestId, accept)
      )}
      reloadRevision={webPaneReloads[webPane.id]}
    />
  )
  /** A built-in panel tab (session log, changes, PR), in the side panel or Commander's reading pane. */
  const renderBuiltinPanelTab = (tab: BuiltinPanelTab, visible: boolean, data: PanePanelData) => {
    const pane = paneMap.get(tab.anchorPaneId)
    if (!pane) return null
    if (tab.key === 'changes') return <GitDiffView paneId={pane.id} panePath={pane.path} api={gitDiffApi} initialSummary={data.summary} visible={visible} />
    const identity = parsePrPanelKey(tab.key)
    if (identity) {
      const source = data.prs?.pullRequests.find((pr) => pr.repo.toLowerCase() === identity.repo && pr.number === identity.number)
      return source ? <Suspense fallback={<p role="status">Loading quick look…</p>}>
        <PrPanel key={`${pane.targetId}:${source.repo}:${source.number}`} paneId={pane.id} panePath={pane.path} source={source} api={prsApi} gitApi={gitDiffApi} visible={visible} selection={prSelections[tab.id]}
          onSelectionApplied={() => setPrSelections((current) => {
            if (current[tab.id] !== prSelections[tab.id]) return current
            const next = { ...current }; delete next[tab.id]; return next
          })} />
      </Suspense> : null
    }
    const supplied = paneBriefs[pane.id]
    const brief = supplied && (!supplied.targetId || supplied.targetId === pane.targetId) ? supplied : undefined
    const worklogBrief: SessionBrief = brief ? { ...brief, targetId: pane.targetId } : {
      paneId: pane.id, targetId: pane.targetId, sessionId: pane.sessionId, sessionName: pane.sessionId,
      state: agentStatuses[pane.id]?.status ?? 'unknown', headline: 'Session', headlineSource: 'hook', updates: [], updatedAt: 0,
    }
    return <PaneWorklog key={pane.targetId} brief={worklogBrief} paneLabel={pane.title || pane.command || `Pane ${pane.index}`}
      fullWidth visible={visible} onAttentionChange={reportSessionAttention}
      empty={!brief || brief.updatedAt === 0} hookConnected={agentStatuses[pane.id]?.source === 'hook'}
      simsApi={simsApi} onShowSimulator={(udid) => { void showSimulator(udid, pane.id) }} prsApi={prsApi} connected={connected}
      screenshotsApi={paneScreenshotsApi} paneManagementApi={paneManagementApi} revealInFinder={revealInFinder}
      onOpenScreenshot={(folder, file, restoreFocus) => setScreenshotLightbox({ paneId: pane.id, folder, file, restoreFocus })}
      onTypeCommand={(data) => sendPaneInput(pane.id, data)} resume={agentResumes[pane.targetId]} onRetryResume={() => retryAgentResume(pane.targetId)} />
  }

  return (
    <ChatStashContext.Provider value={chatStash}>
    <PlanUsageContext.Provider value={planUsageByProfile}>
    <div
      className={`cockpit${maximizedPaneId ? ' has-maximized-pane' : ''}`}
      style={{ '--left-panel-width': `${leftPanelWidth}px` } as CSSProperties}
    >
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
            aria-label="Open HUD"
          >
            <PanelRightOpen aria-hidden="true" />
            {attentionCount ? <span className="attention-badge">{attentionCount}</span> : null}
          </button> : null}
          {area === 'workspace' ? <button
            type="button"
            className={`icon-button desktop-panel-toggle right-panel-visibility${rightPanelHidden ? ' is-collapsed' : ''}`}
            onClick={() => setRightPanelHidden((current) => !current)}
            aria-label={rightPanelHidden ? 'Show HUD' : 'Hide HUD'}
            aria-pressed={!rightPanelHidden}
            title={rightPanelHidden ? 'Show HUD' : 'Hide HUD'}
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

      <div
        ref={cockpitBodyRef}
        className={`cockpit-body area-${area}${leftPanelHidden ? ' left-panel-hidden' : ''}${rightPanelHidden ? ' right-panel-hidden' : ''}${resizingLeftPanel ? ' resizing-left-panel' : ''}`}
      >
        <button
          type="button"
          className={`drawer-scrim${leftPanelOpen || rightPanelOpen ? ' visible' : ''}`}
          data-native-terminal-occluder={drawerOcclusionActive ? '' : undefined}
          onClick={() => {
            setLeftPanelOpen(false)
            setRightPanelOpen(false)
          }}
          aria-label="Close open panel"
        />

        <aside
          className={`session-sidebar${leftPanelOpen ? ' panel-open' : ''}`}
          onTransitionEnd={finishResponsiveDrawerTransition}
        >
          <div
            className="session-sidebar-resizer"
            role="separator"
            aria-label="Resize session sidebar"
            aria-orientation="vertical"
            aria-valuemin={LEFT_PANEL_MIN_WIDTH}
            aria-valuemax={LEFT_PANEL_MAX_WIDTH}
            aria-valuenow={leftPanelWidth}
            tabIndex={0}
            title="Drag to resize; use Left and Right arrows from the keyboard. Double-click to reset."
            onPointerDown={(event) => {
              if (event.button !== 0) return
              leftPanelResizePointer.current = event.pointerId
              leftPanelResizeWidth.current = leftPanelWidth
              event.currentTarget.setPointerCapture(event.pointerId)
              setResizingLeftPanel(true)
            }}
            onPointerMove={moveLeftPanelResize}
            onPointerUp={finishLeftPanelResize}
            onPointerCancel={finishLeftPanelResize}
            onLostPointerCapture={finishLeftPanelResize}
            onKeyDown={resizeLeftPanelWithKeyboard}
            onDoubleClick={() => {
              setLeftPanelWidth(LEFT_PANEL_DEFAULT_WIDTH)
              storeLeftPanelWidth(LEFT_PANEL_DEFAULT_WIDTH)
            }}
          />
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
            <button type="button" className={area === 'sims' ? 'active' : ''} aria-current={area === 'sims' ? 'page' : undefined} onClick={() => { setArea('sims'); setLeftPanelOpen(false) }}>
              <Smartphone aria-hidden="true" />
              <span>Simulators</span>
            </button>
            <button type="button" className={area === 'settings' ? 'active' : ''} aria-current={area === 'settings' ? 'page' : undefined} onClick={() => { setArea('settings'); setLeftPanelOpen(false) }}>
              <Settings aria-hidden="true" />
              <span>Settings</span>
            </button>
          </nav>

          <div className="tree-heading">
            <span>Session tree</span>
            {failedResumeCount > 0 ? (
              <button
                type="button"
                className="tree-heading-action"
                onClick={() => retryAgentResume()}
                disabled={!connected}
                title="Retry every agent conversation Commando could not resume after tmux restarted"
              >
                Resume all ({failedResumeCount})
              </button>
            ) : null}
            <span>{snapshot?.panes.length ?? 0} panes</span>
          </div>
          <div className="session-tree">
            <SessionTree
              token={token}
              commanderState={commanderState}
              commanderNeedsYou={commanderGroups.needs_you.length}
              commanderUnreadFinished={commanderGroups.finished.some((row) => row.unread)}
              commanderOpening={commanderOpening}
              onCreateCommander={openCommander}
              prsApi={prsApi}
              connected={connected}
              sessions={snapshot?.sessions ?? []}
              panes={snapshot?.panes ?? []}
              displayedPaneIds={allVisiblePaneIds}
              statuses={agentStatuses}
              agentChatRequests={agentChatRequests}
              marks={paneMarks}
              seen={paneSeen}
              simulators={paneSimulators}
              selectedSessionId={selectedSessionId}
              onSelectSession={selectSession}
              onSelectPane={jumpToPane}
              onShowSimulator={(udid, paneId) => { void showSimulator(udid, paneId) }}
              onSessionsChanged={refresh}
              onPreferencesChanged={setSessionTreePreferences}
              ides={sessionIdes}
              ideSessionId={area === 'ide' ? selectedSessionId : null}
              onOpenIde={(sessionId) => { void openSessionIde(sessionId) }}
              onResumeChat={resumeSessionChat}
              actionsRef={sessionActionsRef}
              creation={{
                disabled: !connected,
                onCreateSession: tmuxCreateApi.createSession,
                probeRepo: (directory) => gitDiffApi.repo(directory),
                loadClaudeProfiles: tmuxCreateApi.claudeProfiles,
                onCreated: (created) => { setArea('workspace'); setSelectedSessionId(created.sessionId); refresh() },
              }}
            />
          </div>
          <PortsSection
            token={token}
            sessions={snapshot?.sessions ?? []}
            ports={snapshot?.ports ?? []}
            selectedSessionId={selectedSessionId}
            onSelectSession={selectSession}
            onSelectPane={jumpToPane}
            onOpenAsTile={(port) => {
              jumpToPane(port.paneId)
              void openWebPane(openPortUrl(port.port), port.paneId)
            }}
          />
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
                title={activeGroup
                  ? `Window ${windowMap.get(activeGroup.windowId)?.index ?? '?'}: ${activeGroup.name} / ${groups.length} windows / ${allVisiblePaneIds.length} visible panes`
                  : undefined}
              >
                {selectedSession?.name ?? 'Waiting for tmux'}
              </h1>
              {groups.length > 1 ? (
                <nav className="window-strip" role="tablist" aria-label="Windows">
                  {groups.map((group) => {
                    const window = windowMap.get(group.windowId)
                    const active = group === activeGroup
                    const attention = group.paneIds.some((paneId) => {
                      const status = agentStatuses[paneId]?.status
                      return status === 'needs_input' || status === 'failed'
                    })
                    return (
                      <button
                        type="button"
                        role="tab"
                        aria-selected={active}
                        className={active ? 'active' : ''}
                        onClick={() => jumpToGroup(group.windowId)}
                        title={`Show ${group.name}`}
                        key={group.id}
                      >
                        {window ? `${window.index} ${group.name}` : group.name}
                        {attention ? <span className="tab-attention" aria-label="Needs attention" /> : null}
                      </button>
                    )
                  })}
                </nav>
              ) : null}
            </div>
            <div className="workspace-actions">
              <button type="button" className="open-session-ide" disabled={!connected || !selectedSessionId} onClick={() => { if (selectedSessionId) void openSessionIde(selectedSessionId) }}><Code2 />{sessionIdes.some((ide) => ide.sessionIds.includes(selectedSessionId ?? '')) ? 'IDE' : 'Open IDE'}</button>
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
            {(activeGroup ? [activeGroup] : []).map((group) => {
              const groupPanes = group.paneIds.flatMap((paneId) => {
                const pane = paneMap.get(paneId)
                return pane ? [pane] : []
              })
              const maximizedPanelTab = webPanes.find((webPane) =>
                webPane.id === maximizedPaneId && webPane.windowId === group.windowId && webPane.dock !== 'split')
              const builtinMaximized = maximizedBuiltinTab && groupPanes.some((pane) => pane.id === maximizedBuiltinTab.anchorPaneId) && panelTabSets.current.get(maximizedBuiltinTab.anchorPaneId)?.some((tab) => tab.id === maximizedBuiltinTab.id) ? maximizedBuiltinTab : null
              const maximizedGridPaneId = maximizedPanelTab || builtinMaximized ? null : maximizedPaneId
              const visibleGroupPanes = maximizedGridPaneId
                ? groupPanes.filter((pane) => pane.id === maximizedGridPaneId)
                : groupPanes
              const maximizedWebPaneId =
                maximizedGridPaneId && isWebPaneLeafId(maximizedGridPaneId) ? maximizedGridPaneId : null
              if (maximizedGridPaneId && !maximizedWebPaneId && visibleGroupPanes.length === 0) return null

              const window = windowMap.get(group.windowId)
              const windowTree = window ? parseWindowLayout(window.layout) : null
              const visibleTree = windowTree
                ? filterLayoutTree(windowTree, new Set(visibleGroupPanes.map((pane) => pane.id)))
                : null
              // Web pane tiles join the rendered tree only: every tmux write
              // path re-derives its tree from tmux's layout string, so these
              // synthetic leaves can never reach a LayoutSpec.
              const groupWebPanes = maximizedGridPaneId
                ? webPanes.filter((webPane) =>
                    webPane.id === maximizedWebPaneId && webPane.windowId === group.windowId)
                : webPanes.filter((webPane) => webPane.windowId === group.windowId)
              const maximizedWebPane = groupWebPanes.find((webPane) => webPane.dock === 'split' && webPane.id === maximizedWebPaneId) ?? null
              if (maximizedWebPaneId && !maximizedWebPane) return null
              const displayTree: WindowLayoutNode | null = maximizedWebPane
                ? { kind: 'pane', paneId: maximizedWebPane.id, cols: 80, rows: 24, left: 0, top: 0 }
                : visibleTree && groupWebPanes.length > 0
                  ? insertWebPaneLeaves(visibleTree, groupWebPanes)
                  : visibleTree
              const panelWebPanes = webPanes.filter((webPane) => webPane.windowId === group.windowId && webPane.dock !== 'split')
              const splitWebPanes = groupWebPanes.filter((webPane) => webPane.dock === 'split')
              const panelPaneId = builtinMaximized?.anchorPaneId ?? maximizedPanelTab?.anchorPaneId ?? effectivePaneId
              const focusedPane = panelPaneId ? paneMap.get(panelPaneId) : undefined
              const leafPaneIds = windowTree
                ? layoutTreePanes(windowTree).map((leaf) => leaf.paneId)
                : []
              const displayLeafCount = displayTree ? layoutTreePanes(displayTree).length : 0
              const measurementKey = windowTree
                ? measurementKeyFor(group.id, windowTree)
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
                  <SidePanel key={group.windowId} windowId={group.windowId} tabs={panelWebPanes}
                    focusedPaneId={panelPaneId}
                    narrowMode={narrowPanel} drawerOpen={Boolean(openDrawers[group.windowId])}
                    onDrawerOpen={() => setOpenDrawers((current) => current[group.windowId] ? current : { ...current, [group.windowId]: true })}
                    onDrawerClose={() => setOpenDrawers((current) => ({ ...current, [group.windowId]: false }))}
                    maximizedTabId={builtinMaximized?.id ?? maximizedPanelTab?.id}
                    revealRequest={panelRevealRequest && (panelWebPanes.some((tab) => tab.id === panelRevealRequest.tabId) || groupPanes.some((pane) => panelRevealRequest.tabId.startsWith(`panel:${pane.id}:`))) ? panelRevealRequest : undefined}
                    gridMaximized={Boolean(maximizedGridPaneId)}
                    paneLabel={focusedPane ? `${focusedPane.id} · ${focusedPane.title || focusedPane.command || `Pane ${focusedPane.index}`}` : 'pane'}
                    simulatorNames={simulatorNames}
                    titles={webPaneTitles}
                    onTabSets={rememberPanelTabs}
                    panes={groupPanes} gitApi={gitDiffApi} prsApi={prsApi} connected={connected}
                    activeTabs={panelActiveTabs} dismissedPrTabs={dismissedPrTabs}
                    onDismissPr={(tab, signature, next) => { void dismissPanePrTab(tab, signature, next) }}
                    onRestorePr={(tab) => { void restorePanePrTab(tab).then(() => revealBuiltinTab(tab.anchorPaneId, tab.key, false)).catch((error: unknown) => setPaneActionError(error instanceof Error ? error.message : 'Could not restore PR tab')) }}
                    sessionAttention={sessionAttention} sessionWarnings={sessionWarnings}
                    onMaximize={(tab) => {
                      clearLayoutTimers()
                      if (isBuiltinTab(tab)) {
                        setMaximizedPaneId(null)
                        setMaximizedBuiltinTab((current) => current?.id === tab.id ? null : tab)
                      } else {
                        setMaximizedBuiltinTab(null)
                        setMaximizedPaneId((current) => current === tab.id ? null : tab.id)
                      }
                    }}
                    renderBuiltin={renderBuiltinPanelTab}
                    onSelect={(tab) => { void selectPanelTab(tab) }}
                    onSeen={connected ? markPanelTabSeen : undefined}
                    onClose={(id) => { void closeWebPane(id) }}
                    onOpen={(url, anchor, engine) => { void openWebPane(url, anchor, engine) }}
                    renderTab={(tab, visible) => renderWebPane(tab, visible, group.id)}>
                  {displayTree && (visibleGroupPanes.length || maximizedWebPane) ? (
                    <ResizablePaneLayout
                      key={`${group.id}:${maximizedGridPaneId ?? 'grid'}`}
                      layoutKey={webLayoutAuthoritative || activeResizePaneId !== null
                        // While the browser owns geometry, only a shape change may
                        // discard local weights; tmux cell rounding must not feed back.
                        ? `shape:${layoutShapeKey(displayTree)}`
                        : `${window?.layout ?? ''}|web:${splitWebPanes.map((webPane) => webPane.id).join(',')}`}
                      tree={displayTree}
                      onCommit={() => commitWindowLayout(group.windowId)}
                      panes={new Map<string, ReactNode>(visibleGroupPanes.map((pane) => {
                        const rendererIdentity = paneRendererIdentity(pane)
                        const storedRendererControl = paneRendererControls.get(pane.id)
                        const rendererControl = storedRendererControl?.identity === rendererIdentity
                          ? storedRendererControl
                          : undefined
                        const paneTabs = panelTabs(panelWebPanes, pane.id)
                        const hasNew = paneTabs.some((tab) => tab.unseen) || sessionAttention[pane.id] || sessionWarnings[pane.id]
                        const panelTrigger = narrowPanel ? <button type="button" className={`pane-tab-count pane-tab-button${hasNew ? ' has-new' : ''}`}
                          data-panel-chip={pane.id} aria-label={`Open tabs for ${pane.title || pane.command || `Pane ${pane.index}`}`}
                          aria-expanded={Boolean(openDrawers[group.windowId]) && panelPaneId === pane.id}
                          onClick={(event) => {
                            event.stopPropagation()
                            event.currentTarget.focus()
                            setFocusedPaneId(pane.id)
                            if (maximizedGridPaneId) {
                              clearLayoutTimers()
                              setMaximizedPaneId(null)
                              setOpenDrawers((current) => ({ ...current, [group.windowId]: true }))
                            } else setOpenDrawers((current) => ({ ...current, [group.windowId]: !(current[group.windowId] && panelPaneId === pane.id) }))
                          }}>
                          <PanelTop aria-hidden="true" />{paneTabs.length > 0 && <span>{paneTabs.length}</span>}
                          {hasNew && <i className={`side-panel-new${sessionWarnings[pane.id] ? ' is-warning' : ''}`} aria-label={sessionWarnings[pane.id] ? 'Session resume failed' : 'New updates'} />}
                        </button> : undefined
                        if (pane.empty) {
                          return [
                            pane.id,
                            <div key={rendererIdentity} className="conversation-picker-anchor empty-pane-anchor" data-pane-id={pane.id}
                              onPointerDown={() => setFocusedPaneId(pane.id)} onFocusCapture={() => setFocusedPaneId(pane.id)}>
                              <EmptyPane pane={pane} pending={paneActionPending} panelTrigger={panelTrigger} focusRef={(node) => registerFocusable(pane.id, node)}
                                onClose={connected && canClosePane(pane) ? () => { void killPane(pane.id) } : undefined}
                                onLaunch={(choice) => { void launchInEmptyPane(pane.id, choice) }} />
                              {palettePaneId === pane.id ? panePaletteNode : null}
                            </div>,
                          ] as const
                        }
                        return [
                          pane.id,
                          <TerminalPaneCard
                            key={rendererIdentity}
                            pane={pane}
                            lineageSnapshot={snapshot ?? undefined}
                            lineageStatuses={agentStatuses}
                            commander={{ state: commanderState, groups: commanderGroups, token,
                              onOpenPane: (paneId, targetId) => jumpToPane(paneId, targetId, true),
                              onRelay: (relay) => dispatchCommander({ type: 'commander_relay', relay }),
                              disabled: !connected,
                              ...(pane.id === commanderState.paneId ? {
                                ...(commanderPeek ? { peekTargetId: commanderPeek.targetId } : {}),
                                onPeek: (paneId: string, targetId: string) => setCommanderPeek({ paneId, targetId }),
                                peek: commanderPeekView(),
                              } : {}),
                            }}
                            onSelectPane={jumpToPane}
                            attributionVisible={attributionTargets.has(pane.targetId)}
                            agentChatRequests={Object.values(agentChatRequests).filter((request) => request.callerPaneId === pane.id && request.callerTargetId === pane.targetId)}
                            {...(palettePaneId === pane.id && panePaletteNode ? { overlay: panePaletteNode } : {})}
                            onAnswerAgentChatRequest={async (id, decision) => {
                              setPaneActionError('')
                              try {
                                await agentChatsApi.answerRequest(id, decision)
                                setAgentChatRequests((current) => { const next = { ...current }; delete next[id]; return next })
                              } catch (cause) {
                                setPaneActionError(cause instanceof Error ? cause.message : 'Unable to answer chat request')
                                throw cause
                              }
                            }}
                            status={agentStatuses[pane.id]}
                            brief={paneBriefs[pane.id]}
                            panelTabs={paneTabs}
                            panelTrigger={panelTrigger}
                            mark={paneMarks[pane.targetId]}
                            resume={agentResumes[pane.targetId]}
                            onRetryResume={() => retryAgentResume(pane.targetId)}
                            chat={chats[pane.id]}
                            externalRuns={externalRuns[pane.id]}
                            {...(tileEvents[pane.id] ? { tileEvents: tileEvents[pane.id] } : {})}
                            onOpenTile={revealWebPaneTab}
                            chatView={chatViews[pane.id] ?? 'chat'}
                            onChatView={(view) => setChatViews((current) => ({ ...current, [pane.id]: view }))}
                            onChatSend={(text, images, options) => sendChat(pane.id, text, images, options)}
                            chatServices={chatServicesFor(pane.id)}
                            chatFlow={chatFlowFor(pane.id)}
                            {...(chatSendErrors[pane.id] ? { chatSendError: chatSendErrors[pane.id] } : {})}
                            onDismissChatSendError={() => setChatSendErrors((current) => {
                              const next = { ...current }
                              delete next[pane.id]
                              return next
                            })}
                            {...(chatActionErrors[pane.id] ? { chatActionError: chatActionErrors[pane.id] } : {})}
                            onDismissChatActionError={() => setChatActionErrors((current) => {
                              const next = { ...current }
                              delete next[pane.id]
                              return next
                            })}
                            onChatInterrupt={(dropQueued) => interruptChat(pane.id, dropQueued)}
                            onChatAnswer={(chatRequestId, answer) => answerChat(pane.id, chatRequestId, answer)}
                            onChatConfigure={(settings) => configureChat(pane.id, settings)}
                            onChatRestart={() => restartChat(pane.id)}
                            onChatOpenPr={(repo, number, tab) => { void revealPrTab(pane.id, repo, number, tab) }}
                            claudeCodeFromChat={runsChatInClaudeCode(pane.id)}
                            handoffProvider={paneChatHandoff(pane.id, agentStatuses[pane.id], chatHandoffEntries, chatHandoffs)?.provider}
                            chatUploading={chatUploads.has(pane.id)}
                            onSwitchToClaudeCode={() => switchChat(pane.id, 'after_turn')}
                            onReturnToChat={() => returnToChat(pane.id)}
                            index={leafPaneIds.indexOf(pane.id)}
                            count={leafPaneIds.length}
                            solo={displayLeafCount === 1}
                            maximized={maximizedPaneId === pane.id}
                            focused={effectivePaneId === pane.id}
                            jumpHighlighted={jumpHighlightedPaneId === pane.id}
                            resizeOwner={
                              resizeAuthorityActive && (
                                activeResizePaneId === pane.id ||
                                (webLayoutAuthoritative && !maximizedPaneId)
                              )
                            }
                            measurementKey={measurementKey}
                            connected={connected}
                            renaming={renamingPaneId === pane.id}
                            nativeRetryKey={rendererControl?.retryKey ?? 0}
                            useXtermFallback={rendererControl?.manualXterm ?? false}
                            gitApi={gitDiffApi}
                            prsApi={prsApi}
                            screenshotsApi={paneScreenshotsApi}
                            simsApi={simsApi}
                            onShowSimulator={(udid) => { void showSimulator(udid, pane.id) }}
                            paneManagementApi={paneManagementApi}
                            revealInFinder={revealInFinder}
                            onOpenPath={() => paneManagementApi.openPanePath(pane.id)}
                            onOpenScreenshot={(request) => setScreenshotLightbox({ paneId: pane.id, ...request })}
                            onOpenChanges={() => revealBuiltinTab(pane.id, 'changes')}
                            onFocus={() => setFocusedPaneId(pane.id)}
                            onOpenMenu={(x, y) => openPaneMenu(pane.id, x, y)}
                            onAcknowledgeMark={() => { void acknowledgePaneMark(pane.id) }}
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
                            onClose={() => { void killPane(pane.id) }}
                            closeDisabled={paneActionPending}
                            onDragStart={(event) => {
                              setDraggedPane({ kind: 'terminal', groupId: group.id, paneId: pane.id })
                              event.dataTransfer.effectAllowed = 'move'
                              event.dataTransfer.setData('text/plain', pane.id)
                            }}
                            onDragEnd={() => {
                              setDraggedPane(null)
                              setDropPreview(null)
                            }}
                            onDragOver={(event) => {
                              if (draggedPane?.groupId !== group.id) return
                              event.preventDefault()
                              event.dataTransfer.dropEffect = 'move'
                              if (draggedPane.kind !== 'web') return
                              const placement = dropPlacementFor(
                                event.currentTarget.getBoundingClientRect(),
                                event.clientX,
                                event.clientY,
                              )
                              setDropPreview((current) =>
                                current?.paneId === pane.id && current.placement === placement
                                  ? current
                                  : { paneId: pane.id, placement })
                            }}
                            onDragLeave={() => {
                              setDropPreview((current) => (current?.paneId === pane.id ? null : current))
                            }}
                            onDrop={(event) => {
                              event.preventDefault()
                              clearLayoutTimers()
                              dropPane(group.windowId, group.id, pane.id, event)
                            }}
                            dropPreview={dropPreview?.paneId === pane.id ? dropPreview.placement : null}
                            onInput={(data) => sendPaneInput(pane.id, data)}
                            onInputBytes={(data) => sendPaneInputBytes(pane.id, data)}
                            onKey={(key) => sendPaneKey(pane.id, key)}
                            onPaste={(data) => sendPanePaste(pane.id, data)}
                            onResize={(cols, rows) => sendPaneResize(
                              group.windowId,
                              pane.id,
                              measurementKey,
                              cols,
                              rows,
                            )}
                            onRequestReset={() => requestPaneReset(pane.id)}
                            onRendererChange={(actual) => {
                              updatePaneRendererControl(pane.id, rendererIdentity, (current) => (
                                current.actual === actual ? current : { ...current, actual }
                              ))
                            }}
                            registerSink={registerTerminalSink}
                            registerFocusable={registerFocusable}
                          />,
                          ] as const
                      }).concat(splitWebPanes.map((webPane) => [webPane.id, renderWebPane(webPane, true, group.id)] as const)))}
                    />
                  ) : (
                    <div className="group-empty">This saved group has no panes in the current tmux snapshot.</div>
                  )}
                  </SidePanel>
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
          <SessionIdeView
            active={area === 'ide'}
            sessionId={selectedSessionId}
            sessionName={selectedSession?.name ?? 'Session'}
            ide={sessionIdes.find((ide) => ide.sessionIds.includes(selectedSessionId ?? ''))}
            ides={sessionIdes}
            openedIdeIds={openedIdeIds}
            pending={idePendingSessions.has(selectedSessionId ?? '')}
            detaching={ideRequests.current.has(`detach:${selectedSessionId}`)}
            error={ideErrors[selectedSessionId ?? ''] ?? ''}
            connected={connected}
            onOpen={() => { if (selectedSessionId) void openSessionIde(selectedSessionId) }}
            onDetach={() => { if (selectedSessionId) void detachSessionIde(selectedSessionId) }}
            onTerminal={() => setArea('workspace')}
          />
          {area === 'sims' ? (
            <Suspense fallback={<section className="workspace-empty"><LoaderCircle className="spin" /><p>Opening simulators...</p></section>}>
              <SimsView token={token} />
            </Suspense>
          ) : null}
          {area === 'settings' ? (
            <Suspense fallback={<section className="workspace-empty"><LoaderCircle className="spin" /><p>Opening settings...</p></section>}>
              <SettingsView api={agentProfilesApi} onOpenPane={(paneId) => { setArea('workspace'); setPendingPaneFocus({ paneId, waitForCreation: true }) }}
                commander={{ ...(commanderState.configDir ? { configDir: commanderState.configDir } : {}), open: Boolean(commanderState.sessionId), onSwitch: switchCommanderProfile }} />
            </Suspense>
          ) : null}
          {notesMounted ? (
            <Suspense fallback={<section className="workspace-empty"><LoaderCircle className="spin" /><p>Opening Markdown vault...</p></section>}>
              <NotesSection
                token={token}
                isActive={area === 'notes'}
                pinnedNote={pinnedNote}
                requestedNote={requestedNote}
                onPinnedNoteChange={changePinnedNote}
              />
            </Suspense>
          ) : null}
        </main>

        {area === 'workspace' ? <aside
          className={`agent-hud${rightPanelOpen ? ' panel-open' : ''}`}
          onTransitionEnd={finishResponsiveDrawerTransition}
        >
          <div className="hud-header">
            <div className="hud-heading">
              <span className={`hud-pulse${attentionCount ? ' attention' : ''}`} />
              <div><strong>HUD</strong><small>{hudTab === 'prs' ? 'Pull requests' : 'Notes and agents'}</small></div>
            </div>
            <button
              type="button"
              className="icon-button panel-close"
              onClick={() => { setRightPanelOpen(false); setRightPanelHidden(true) }}
              aria-label="Hide HUD"
            >
              <X aria-hidden="true" />
            </button>
          </div>
          {pinnedNote ? (
            <HudPinnedNote
              note={pinnedNote}
              onOpen={() => {
                setNotesMounted(true)
                setArea('notes')
                setRightPanelOpen(false)
                setRequestedNote((current) => ({
                  vaultId: pinnedNote.vaultId,
                  noteId: pinnedNote.id,
                  requestId: (current?.requestId ?? 0) + 1,
                }))
              }}
              onSave={savePinnedNote}
              onUnpin={() => changePinnedNote(null)}
              uploadImage={uploadPinnedNoteImage}
              resolveImageUrl={resolvePinnedNoteImageUrl}
            />
          ) : null}
          <nav className="hud-tabs" role="tablist" aria-label="HUD sections">
            <button
              type="button"
              role="tab"
              aria-selected={hudTab === 'agents'}
              onClick={() => switchHudTab('agents')}
            >
              Notes &amp; Agents
              {attentionCount && hudTab !== 'agents' ? <span className="hud-tab-dot" aria-label="Agents need you" /> : null}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={hudTab === 'prs'}
              onClick={() => switchHudTab('prs')}
            >
              PRs
              {prsAttention && hudTab !== 'prs' ? <span className="hud-tab-dot" aria-label="Pull requests need you" /> : null}
            </button>
          </nav>
          <div className="hud-tab-content" hidden={hudTab !== 'agents'}>
          <div className="hud-stats" aria-label="Agent status filters">
            <button
              type="button"
              aria-pressed={agentHudFilter === 'working'}
              aria-label={`${agentHudFilter === 'working' ? 'Clear' : 'Filter to'} working agents (${workingCount})`}
              title={agentHudFilter === 'working' ? 'Show all agents' : 'Show working agents'}
              onClick={() => setAgentHudFilter((current) => current === 'working' ? null : 'working')}
            >
              <strong>{workingCount}</strong><span>Working</span>
            </button>
            <button
              type="button"
              className="attention"
              aria-pressed={agentHudFilter === 'attention'}
              aria-label={`${agentHudFilter === 'attention' ? 'Clear' : 'Filter to'} agents needing you (${attentionCount})`}
              title={agentHudFilter === 'attention' ? 'Show all agents' : 'Show agents needing you'}
              onClick={() => setAgentHudFilter((current) => current === 'attention' ? null : 'attention')}
            >
              <strong>{attentionCount}</strong><span>Need you</span>
            </button>
            <button
              type="button"
              aria-pressed={agentHudFilter === 'done'}
              aria-label={`${agentHudFilter === 'done' ? 'Clear' : 'Filter to'} done agents (${doneCount})`}
              title={agentHudFilter === 'done' ? 'Show all agents' : 'Show done agents'}
              onClick={() => setAgentHudFilter((current) => current === 'done' ? null : 'done')}
            >
              <strong>{doneCount}</strong><span>Done</span>
            </button>
          </div>
          <div className="agent-stream">
            {visibleHudGroups.map((group) => (
              <section className="agent-group" key={group.id} aria-labelledby={`agent-group-${group.id}`}>
                <header>
                  <strong id={`agent-group-${group.id}`}>{group.name}</strong>
                  <small aria-label={`${group.statuses.length} ${group.statuses.length === 1 ? 'agent' : 'agents'}`}>{group.statuses.length}</small>
                </header>
                {group.statuses.map((status) => {
                  const pane = paneMap.get(status.paneId)
                  const window = pane ? windowMap.get(pane.windowId) : undefined
                  const session = pane ? sessionMap.get(pane.sessionId) : undefined
                  return (
                    <AgentHudCard
                      status={status}
                      sessionName={session?.name ?? pane?.sessionId}
                      windowName={window?.name ?? pane?.windowId}
                      paneIndex={pane?.index}
                      onSelect={() => jumpToPane(status.paneId)}
                      onAnswer={(request, answer) => answerFromHud(status.paneId, request, answer)}
                      {...(hudAnswers[status.paneId] ? { answerState: hudAnswers[status.paneId] } : {})}
                      onDismiss={() => setAgentHudDismissals((current) => {
                        const next = { ...current, [status.paneId]: status.updatedAt }
                        storeAgentHudDismissals(next)
                        return next
                      })}
                      key={status.paneId}
                    />
                  )
                })}
              </section>
            ))}
            {visibleHudStatuses.length === 0 ? (
              <div className="hud-empty">
                <Bot aria-hidden="true" />
                <strong>{agentHudFilter ? activeHudFilterEmptyTitle : hasKnownHudStatuses ? 'All current updates dismissed' : 'No agent signals yet'}</strong>
                <p>{agentHudFilter ? `Select ${activeHudFilterLabel} again to show all current updates.` : hasKnownHudStatuses ? 'Cards return when their agent reports a new update.' : 'Provider hooks, process inspection, and heuristics will appear here with their source.'}</p>
              </div>
            ) : null}
          </div>
          </div>
          <div className="hud-tab-content" hidden={hudTab !== 'prs'}>
            <PrsSection
              token={token}
              api={prsApi}
              active={hudTab === 'prs'}
              currentPaneId={currentPrPane?.id}
              currentPanePath={currentPrPane?.path}
              onAttentionChange={setPrsAttention}
              liveTargetIds={livePaneTargetIds}
              targetSessionNames={paneSessionNames}
              onJumpToTarget={jumpToPaneTarget}
              onOpenQuickLook={(pr) => openPanePr(pr, 'Description')}
              onOpenDiff={openPrDiff}
            />
          </div>
          <button type="button" className="quick-jump" onClick={() => setPaletteOpen(true)}>
            <Search aria-hidden="true" />
            <span><strong>Quick-jump to pane</strong><small>Search every session and window</small></span>
            <kbd>Cmd K</kbd>
          </button>
          <footer className="hud-footer">
            <LockKeyhole aria-hidden="true" />
            <span>Agent signals include bounded task and activity metadata, change totals, checks, and provenance.</span>
          </footer>
        </aside> : null}
      </div>

      {paneActionError ? (
        <PaneActionErrorFeedback message={paneActionError} onDismiss={() => setPaneActionError('')} />
      ) : null}

      {screenshotLightbox ? (
        <PaneScreenshotLightbox
          request={screenshotLightbox}
          screenshotsApi={paneScreenshotsApi}
          paneManagementApi={paneManagementApi}
          revealInFinder={revealInFinder}
          onClose={() => setScreenshotLightbox(null)}
        />
      ) : null}

      {paneMenu && contextPane ? (
        <PaneContextMenu
          paneLabel={contextPane.title || contextPane.command || `Pane ${contextPane.index}`}
          x={paneMenu.x}
          y={paneMenu.y}
          busy={paneActionPending || !connected}
          nativeTerminalAvailable={nativeTerminalAvailable || Boolean(contextRendererControl?.manualXterm)}
          useXtermFallback={contextUsesXterm}
          mark={paneMarks[contextPane.targetId]}
          onClose={closePaneMenu}
          onRename={() => setRenamingPaneId(paneMenu.paneId)}
          onSplit={(direction) => { void splitPane(paneMenu.paneId, direction) }}
          onSplitChat={(direction) => { void splitPane(paneMenu.paneId, direction, true) }}
          {...(chats[paneMenu.paneId] ? {
            chatView: chatViews[paneMenu.paneId] ?? 'chat',
            onChatView: (view: 'chat' | 'terminal') => setChatViews((current) => ({ ...current, [paneMenu.paneId]: view })),
          } : {})}
          {...(runsChatInClaudeCode(paneMenu.paneId) ? { onReturnToChat: () => returnToChat(paneMenu.paneId) } : {})}
          onUseXtermFallbackChange={(useXtermFallback) => {
            if (!contextPaneIdentity) return
            updatePaneRendererControl(paneMenu.paneId, contextPaneIdentity, (current) => ({
              ...current,
              manualXterm: useXtermFallback,
              retryKey: useXtermFallback ? current.retryKey : current.retryKey + 1,
            }))
          }}
          onSetMark={(label, tone) => { void setPaneMark(paneMenu.paneId, label, tone) }}
          onAcknowledgeMark={() => { void acknowledgePaneMark(paneMenu.paneId) }}
          onClearMark={() => { void clearPaneMark(paneMenu.paneId) }}
          onKill={() => { void killPane(paneMenu.paneId) }}
        />
      ) : null}

      {paletteOpen ? (
        <div
          className="palette-backdrop"
          data-native-terminal-occluder=""
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
    </PlanUsageContext.Provider>
    </ChatStashContext.Provider>
  )
}
