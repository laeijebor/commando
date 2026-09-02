export type AgentProvider = 'claude' | 'codex' | 'opencode' | 'unknown'

export type AgentStatusKind =
  | 'working'
  | 'needs_input'
  | 'done'
  | 'failed'
  | 'stale'
  | 'unknown'

export type AgentActivityKind =
  | 'inspect'
  | 'edit'
  | 'command'
  | 'check'
  | 'delegate'
  | 'task'
  | 'other'

export type AgentActivity = {
  label: string
  kind: AgentActivityKind
  state: 'running' | 'completed' | 'failed'
  updatedAt: number
}

export type AgentProgress = {
  completed: number
  total: number
  active?: string
}

export type AgentTaskStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled'

export type AgentTaskPriority = 'high' | 'medium' | 'low'

export type AgentTask = {
  id: string
  content: string
  status: AgentTaskStatus
  priority: AgentTaskPriority
  createdAt?: number
  updatedAt?: number
}

export type AgentChanges = {
  fileCount: number
  additions: number
  deletions: number
}

export type AgentCheck = {
  label: string
  status: 'running' | 'passed' | 'failed'
  updatedAt: number
}

export type AgentRecap = {
  outcome: 'done' | 'follow_up' | 'blocked' | 'failed'
  summary: string
  completedAt: number
}

export type AgentQuestionOption = {
  label: string
  description?: string
}

export type AgentQuestion = {
  header: string
  question: string
  options: AgentQuestionOption[]
  multiple: boolean
  custom: boolean
}

export type AgentInteractionRequest = {
  id: string
  kind: 'permission' | 'question'
  prompt: string
  toolName?: string
  questions?: AgentQuestion[]
  createdAt: number
}

export type AgentInteractionAnswer = {
  action: 'allow_once' | 'allow_always' | 'deny' | 'answer' | 'reject'
  answers?: string[][]
}

export type AgentDetails = {
  intent?: string
  currentActivity?: AgentActivity
  recentActivities: AgentActivity[]
  progress?: AgentProgress
  tasks?: AgentTask[]
  changes?: AgentChanges
  checks: AgentCheck[]
  attention?: string
  recap?: AgentRecap
  requests?: AgentInteractionRequest[]
}

export type AgentStatus = {
  paneId: string
  provider: AgentProvider
  agentSessionId?: string
  agentSessionName?: string
  status: AgentStatusKind
  summary: string
  source: 'hook' | 'heuristic' | 'process'
  confidence: 'high' | 'medium' | 'low'
  reason: string
  updatedAt: number
  details?: AgentDetails
}

export type SessionBriefUpdateKind = 'changed' | 'decision' | 'check' | 'blocker' | 'note'

export type SessionBriefUpdate = {
  id: string
  paneId: string
  kind: SessionBriefUpdateKind
  text: string
  detail?: string
  author?: 'user'
  source: 'hook' | 'agent'
  createdAt: number
}

export type SessionBrief = {
  paneId: string
  sessionId: string
  sessionName: string
  state: AgentStatusKind
  headline: string
  headlineSource: 'hook' | 'agent'
  recapMarkdown?: string
  tasks?: AgentTask[]
  updates: SessionBriefUpdate[]
  next?: string
  updatedAt: number
}

export type PaneMarkTone = 'amber' | 'green' | 'red' | 'purple' | 'muted'

export type PaneMark = {
  targetId: string
  label: string
  tone: PaneMarkTone
  markedAt: number
  activityCount: number
  lastActivityAt?: number
}

export type PaneTerminalState = {
  width: number
  height: number
  cursorX: number
  cursorY: number
  alternateSavedX: number
  alternateSavedY: number
  alternateOn: boolean
  cursorVisible: boolean
  cursorShape: 'default' | 'block' | 'underline' | 'bar'
  cursorBlinking: boolean
  scrollRegionUpper: number
  scrollRegionLower: number
  wrapFlag: boolean
  originFlag: boolean
  insertFlag: boolean
  keypadFlag: boolean
  keypadCursorFlag: boolean
  mouseAnyFlag: boolean
  mouseSgrFlag: boolean
  paneTabs: number[]
}

/** Repository that contains a pane's current directory, resolved by the daemon. */
export type PaneRepo = {
  /** Root of the main checkout; every worktree of a repo shares this root. */
  root: string
  /** Folder name of the main checkout. */
  name: string
  branch: string
  isWorktree: boolean
  defaultBranch?: string
}

export type TmuxPane = PaneTerminalState & {
  id: string
  targetId: string
  processId?: number
  index: number
  windowId: string
  sessionId: string
  title: string
  command: string
  path: string
  active: boolean
  dead: boolean
  /** Repository behind `path`, when the daemon could resolve one. */
  repo?: PaneRepo
}

export type TmuxWindow = {
  id: string
  index: number
  sessionId: string
  name: string
  active: boolean
  layout: string
  paneIds: string[]
}

export type TmuxSession = {
  id: string
  name: string
  attached: boolean
  activeWindowId: string | null
  windowIds: string[]
}

export type OpenPort = {
  port: number
  processName: string
  sessionId: string
  paneId: string
}

export type CommandoSnapshot = {
  revision: number
  capturedAt: number
  sessions: TmuxSession[]
  windows: TmuxWindow[]
  panes: TmuxPane[]
  ports: OpenPort[]
}

export type UsageProvider = 'claude' | 'codex'

export type UsageWindow = {
  label: string
  usedPercent: number
  remainingPercent: number
  resetsAt?: number
}

export type ProviderUsage = {
  provider: UsageProvider
  state: 'available' | 'unavailable' | 'error'
  plan?: string
  windows: UsageWindow[]
  updatedAt: number
  message?: string
}

export type CompanionSession = {
  id: string
  tmuxSessionId: string
  tmuxSessionName: string
  agentSessionId?: string
  agentSessionName: string
  provider: AgentProvider
  status: AgentStatusKind
  summary: string
  lastOutput?: string
  intent?: string
  activity?: AgentActivity
  requests: AgentInteractionRequest[]
  windowName?: string
  paneId?: string
  paneIndex?: number
  updatedAt: number
}

export type CompanionSnapshot = {
  revision: number
  capturedAt: number
  sessions: CompanionSession[]
  usage: ProviderUsage[]
}

export type CompanionServerMessage =
  | { type: 'companion_snapshot'; snapshot: CompanionSnapshot }
  | { type: 'companion_error'; code: string; message: string; requestId?: string }

export type CompanionClientMessage =
  | {
      type: 'answer_agent_request'
      paneId: string
      requestId: string
      answer: AgentInteractionAnswer
      requestIdempotencyKey: string
    }
  | { type: 'focus_output'; paneId?: string }
  | { type: 'refresh_usage'; requestId: string }

export type SavedGroup = {
  id: string
  name: string
  sessionId: string
  windowId: string
  paneIds: string[]
}

export type SavedWorkspace = {
  sessionId: string
  groups: SavedGroup[]
  updatedAt: number
}

export type WebPanePlacement = 'right' | 'below' | 'auto'

/**
 * Rendering engine for a web pane. 'webkit' is the shipped pair (sandboxed
 * iframe everywhere, native WKWebView for external origins in the desktop
 * app). 'chromium' renders through the daemon-managed headless Chromium via
 * CDP screencast, giving agents (and the DevTools tile) full CDP on the page.
 */
export type WebPaneEngine = 'webkit' | 'chromium'

/**
 * A browser tile rendered among the tmux panes of a window. Web panes exist
 * only in the app-side layout tree — tmux never sees them, and they must be
 * stripped from any LayoutSpec before it is sent to the daemon.
 */
export type WebPane = {
  id: string
  url: string
  sessionId: string
  windowId: string
  anchorPaneId: string
  placement: WebPanePlacement
  /**
   * A newly inserted tile first shares the anchor's current branch footprint.
   * Once tmux has applied the anchor's measured half-size grid, the settled
   * client reconstructs that footprint from the live anchor size.
   */
  layoutState?: 'pending' | 'settled'
  /** Pre-split anchor size retained only while layoutState is pending. */
  anchorSize?: { cols: number; rows: number }
  engine: WebPaneEngine
  openedBy: 'agent' | 'user'
  openerLabel?: string
  /** 'pending' = external origin awaiting the owner's confirmation. */
  status: 'open' | 'pending'
  createdAt: number
}

export const MAX_WEB_PANES = 16
export const MAX_WEB_PANE_URL_LENGTH = 2_048
/** Cap on notes per POST /feedback body — client and server must agree on this. */
export const MAX_FEEDBACK_NOTES_PER_POST = 20

/** Structured answer a redline component queued from inside the page. */
export type WebPaneFeedbackResponse = {
  question: string
  answer: string
  note?: string
  data?: unknown
}

/** Durable image metadata shared by pending notes and delivered feedback. */
export type WebPaneImageAttachment = {
  id: string
  name: string
  contentType: string
  size: number
}

/** An image attachment after the daemon has made it available to feedback. */
export type WebPaneFeedbackAttachment = WebPaneImageAttachment & {
  /** Daemon-relative URL used to fetch the attachment bytes. */
  path: string
}

export type WebPaneFeedbackNote = {
  /** Server-assigned delivery id; present on drained notes, used for dedupe. */
  id?: number
  /** Internal stable key for retrying a pending-to-feedback transfer. */
  deliveryKey?: string
  selector: string
  tag: string
  text?: string
  rect: { x: number; y: number; width: number; height: number }
  comment: string
  pageUrl: string
  capturedAt: number
  /** Present when the note came from an in-page component, not an annotation. */
  response?: WebPaneFeedbackResponse
  attachments?: WebPaneFeedbackAttachment[]
}

/** Cap on queued-but-unsent pending notes per tile. */
export const MAX_PENDING_NOTES = 50
export const MAX_PENDING_NOTE_ATTACHMENTS = 4

/**
 * A queued-but-unsent review note, held by the daemon until the owner sends
 * it into the feedback queue (or removes it). Persisted so pills survive
 * session switches, page reloads, and daemon restarts.
 */
export type WebPanePendingNote = {
  /** Server-assigned id, unique per pane. */
  id: number
  /** Internal stable key retained when this item moves into feedback. */
  deliveryKey?: string
  /** Item revision used for optimistic pending-note mutations. */
  revision?: number
  /** Page that produced this note. Missing only on historical journal entries. */
  pageUrl?: string
  selector: string
  tag: string
  text?: string
  rect: { x: number; y: number; width: number; height: number }
  comment: string
  /** Replace-key for unsent re-answers from the same in-page question. */
  queueKey?: string
  /** Present when the note came from an in-page component, not an annotation. */
  response?: WebPaneFeedbackResponse
  /** Daemon-owned attachments. Daemon-produced notes always include this. */
  attachments?: WebPaneImageAttachment[]
}

/** A tile's pending queue plus the metadata a viewer needs to reason about it. */
export type WebPanePendingSnapshot = {
  /** Monotonic daemon revision. Daemon-produced snapshots always include this. */
  revision?: number
  notes: WebPanePendingNote[]
  /**
   * Highest note id this pane has ever issued, live or since removed. A
   * client's mirrored note at or below this watermark is one the daemon has
   * already accounted for (sent, removed, or capped) — only ids above it are
   * genuinely unknown and safe to restore.
   */
  knownUpTo: number
  /** Page answers the cap discarded since the last send, surfaced in the tile. */
  dropped: number
}

/** Ephemeral review-feedback state for a tile — broadcast, never persisted. */
export type WebPaneFeedbackInfo = {
  queued: number
  lastDrainCount?: number
  lastDrainAt?: number
}

export type PaneLayoutCapacity = {
  paneId: string
  cols: number
  rows: number
}

/**
 * A window layout as a tmux-compatible split tree. Leaf cols/rows are exact
 * cell capacities for apply_window_layout, and relative weights for
 * set_window_layout (the daemon rescales them to the current window size).
 */
export type LayoutSpec =
  | { kind: 'pane'; paneId: string; cols: number; rows: number }
  | { kind: 'split'; direction: 'row' | 'column'; children: LayoutSpec[] }

export type ServerMessage =
  | { type: 'snapshot'; snapshot: CommandoSnapshot }
  | {
      type: 'pane_reset'
      paneId: string
      data: string
      encoding: 'base64'
      cols: number
      rows: number
      terminalState: PaneTerminalState
      revision: number
    }
  | {
      type: 'pane_data'
      paneId: string
      data: string
      encoding: 'base64'
      revision: number
    }
  | { type: 'agent_status'; status: AgentStatus }
  | { type: 'agent_status_snapshot'; statuses: AgentStatus[] }
  | { type: 'agent_status_removed'; paneId: string }
  | { type: 'session_brief'; brief: SessionBrief }
  | { type: 'session_brief_snapshot'; briefs: SessionBrief[] }
  | { type: 'pane_mark'; mark: PaneMark }
  | { type: 'pane_mark_snapshot'; marks: PaneMark[] }
  | { type: 'pane_mark_removed'; targetId: string }
  | {
      type: 'workspace'
      sessionId: string
      workspace: SavedWorkspace | null
      requestId: string
      reason: 'load' | 'save'
    }
  | { type: 'web_panes'; webPanes: WebPane[]; feedback?: Record<string, WebPaneFeedbackInfo> }
  | { type: 'error'; code: string; message: string; requestId?: string }

export const MAX_PASTE_BYTES = 256 * 1024
export const MAX_INPUT_BYTES = 8 * 1024
export const TERMINAL_SCROLLBACK_LINES = 5_000
export const MIN_TERMINAL_COLS = 2
export const MAX_TERMINAL_COLS = 2_048
export const MIN_TERMINAL_ROWS = 1
export const MAX_TERMINAL_ROWS = 512

export type SpecialKey =
  | 'Enter'
  | 'Backspace'
  | 'Tab'
  | 'Escape'
  | 'Up'
  | 'Down'
  | 'Left'
  | 'Right'
  | 'Home'
  | 'End'
  | 'Insert'
  | 'Delete'
  | 'PageUp'
  | 'PageDown'
  | 'F1'
  | 'F2'
  | 'F3'
  | 'F4'
  | 'F5'
  | 'F6'
  | 'F7'
  | 'F8'
  | 'F9'
  | 'F10'
  | 'F11'
  | 'F12'
  | 'C-c'
  | 'C-d'
  | 'C-z'
  | 'C-l'

export type ClientMessage =
  | { type: 'subscribe'; paneIds: string[]; statusPaneIds?: string[] }
  | { type: 'input'; paneId: string; data: string; requestId: string }
  | {
      type: 'input_bytes'
      paneId: string
      data: string
      encoding: 'base64'
      requestId: string
    }
  | { type: 'paste'; paneId: string; data: string; requestId: string }
  | { type: 'key'; paneId: string; key: SpecialKey; requestId: string }
  | { type: 'request_pane_reset'; paneId: string; requestId: string }
  | { type: 'resize_pane'; paneId: string; cols: number; rows: number; requestId: string }
  | { type: 'release_resize'; paneId: string; requestId: string }
  | {
      type: 'apply_window_layout'
      windowId: string
      spec: LayoutSpec
      requestId: string
    }
  | {
      type: 'set_window_layout'
      windowId: string
      spec: LayoutSpec
      requestId: string
    }
  | { type: 'release_all_resizes'; requestId: string }
  | { type: 'refresh'; requestId: string }
  | { type: 'load_workspace'; sessionId: string; requestId: string }
  | { type: 'save_workspace'; workspace: SavedWorkspace; requestId: string }
