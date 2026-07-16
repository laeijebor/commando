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

export type AgentDetails = {
  intent?: string
  currentActivity?: AgentActivity
  recentActivities: AgentActivity[]
  progress?: AgentProgress
  changes?: AgentChanges
  checks: AgentCheck[]
  attention?: string
  recap?: AgentRecap
}

export type AgentStatus = {
  paneId: string
  provider: AgentProvider
  status: AgentStatusKind
  summary: string
  source: 'hook' | 'heuristic' | 'process'
  confidence: 'high' | 'medium' | 'low'
  reason: string
  updatedAt: number
  details?: AgentDetails
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

export type TmuxPane = PaneTerminalState & {
  id: string
  index: number
  windowId: string
  sessionId: string
  title: string
  command: string
  path: string
  active: boolean
  dead: boolean
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
  | {
      type: 'workspace'
      sessionId: string
      workspace: SavedWorkspace | null
      requestId: string
      reason: 'load' | 'save'
    }
  | { type: 'error'; code: string; message: string; requestId?: string }

export const MAX_PASTE_BYTES = 256 * 1024
export const TERMINAL_SCROLLBACK_LINES = 5_000
export const MIN_TERMINAL_COLS = 2
export const MAX_TERMINAL_COLS = 500
export const MIN_TERMINAL_ROWS = 1
export const MAX_TERMINAL_ROWS = 200

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
  | { type: 'subscribe'; paneIds: string[] }
  | { type: 'input'; paneId: string; data: string; requestId: string }
  | { type: 'paste'; paneId: string; data: string; requestId: string }
  | { type: 'key'; paneId: string; key: SpecialKey; requestId: string }
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
