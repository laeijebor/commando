import type { AgentStatus, TmuxPane, TmuxSession, TmuxWindow } from '../shared/protocol'

/**
 * How a pane leaves the list. tmux ends a session with its last pane, so Commando empties that
 * pane instead of killing it, which would not lower the count: the whole session goes instead.
 * It is paused (resumable, worktree kept), or deleted when it is a background session, which
 * cannot be paused. The Commander's own session is closed from the session tree.
 */
export type PaneCloseAction = 'pane' | 'pause' | 'delete' | null

export type PaneSort = 'viewed' | 'activity' | 'session'

export type PaneRow = {
  pane: TmuxPane
  sessionName: string
  windowIndex?: number
  label: string
  status: string
  /** Last time the pane was on a screen; undefined if never recorded. */
  viewedAt?: number
  /** On a screen now. */
  viewing: boolean
  /** Last time its agent did work. */
  activityAt?: number
  /** How closing this pane alone works. */
  closeAction: PaneCloseAction
  /** How its whole session closes: 'pause', 'delete' or null. */
  sessionClose: PaneCloseAction
}

/** `kept` lists selected panes left open: the whole Commander session was selected. */
export type PaneClosePlan = { panes: string[]; pauseSessions: string[]; deleteSessions: string[]; kept: string[] }

export type PaneListContext = {
  sessions: readonly TmuxSession[]
  windows: readonly TmuxWindow[]
  panes: readonly TmuxPane[]
  agentStatuses: Readonly<Record<string, AgentStatus>>
  activity: Readonly<Record<string, number>>
  viewedAt: Readonly<Record<string, number>>
  viewing: ReadonlySet<string>
  auxiliarySessionIds: ReadonlySet<string>
  commanderSessionId?: string
}

const STATUS_LABELS: Partial<Record<AgentStatus['status'], string>> = {
  working: 'Working',
  needs_input: 'Needs you',
  done: 'Done',
  failed: 'Failed',
  stale: 'Stale',
}

export function paneLabel(pane: TmuxPane): string {
  return pane.chatTitle || pane.title || pane.command || `Pane ${pane.index}`
}

function sessionCloseAction(sessionId: string, context: PaneListContext): PaneCloseAction {
  if (sessionId === context.commanderSessionId) return null
  return context.auxiliarySessionIds.has(sessionId) ? 'delete' : 'pause'
}

export function paneRows(context: PaneListContext): PaneRow[] {
  const sessions = new Map(context.sessions.map((session) => [session.id, session]))
  const windows = new Map(context.windows.map((window) => [window.id, window]))
  const paneCounts = new Map<string, number>()
  for (const pane of context.panes) paneCounts.set(pane.sessionId, (paneCounts.get(pane.sessionId) ?? 0) + 1)
  return context.panes.map((pane) => {
    const status = context.agentStatuses[pane.id]
    const sessionClose = sessionCloseAction(pane.sessionId, context)
    return {
      pane,
      sessionName: sessions.get(pane.sessionId)?.name ?? pane.sessionId,
      windowIndex: windows.get(pane.windowId)?.index,
      label: paneLabel(pane),
      status: (status && STATUS_LABELS[status.status]) ?? (pane.empty ? 'Empty' : pane.dead ? 'Exited' : pane.command),
      viewedAt: context.viewedAt[pane.id],
      viewing: context.viewing.has(pane.id),
      activityAt: context.activity[pane.id],
      closeAction: (paneCounts.get(pane.sessionId) ?? 0) > 1 ? 'pane' : sessionClose,
      sessionClose,
    }
  })
}

/** Stalest first for the times, so the panes most likely to close sit at the top. */
export function sortPaneRows(rows: readonly PaneRow[], sort: PaneSort): PaneRow[] {
  const viewed = (row: PaneRow) => row.viewing ? Infinity : row.viewedAt ?? -Infinity
  const active = (row: PaneRow) => row.activityAt ?? -Infinity
  const bySession = (a: PaneRow, b: PaneRow) => a.sessionName.localeCompare(b.sessionName) || (a.windowIndex ?? 0) - (b.windowIndex ?? 0) || a.pane.index - b.pane.index
  return [...rows].sort((a, b) => {
    if (sort === 'session') return bySession(a, b)
    const key = sort === 'viewed' ? viewed : active
    return key(a) - key(b) || bySession(a, b)
  })
}

export function matchesPaneQuery(row: PaneRow, query: string): boolean {
  const needle = query.trim().toLowerCase()
  if (!needle) return true
  return [row.label, row.sessionName, row.status, row.pane.command, row.pane.path, row.pane.repo?.branch, row.pane.repo?.name]
    .some((value) => value?.toLowerCase().includes(needle))
}

/**
 * Splits a selection into panes to kill and sessions to close. A session whose every pane is
 * selected closes as a whole; otherwise its selected panes are killed and the rest stay.
 */
export function planPaneClose(paneIds: Iterable<string>, rows: readonly PaneRow[]): PaneClosePlan {
  const selected = new Set(paneIds)
  const bySession = new Map<string, PaneRow[]>()
  for (const row of rows) bySession.set(row.pane.sessionId, [...bySession.get(row.pane.sessionId) ?? [], row])
  const plan: PaneClosePlan = { panes: [], pauseSessions: [], deleteSessions: [], kept: [] }
  for (const [sessionId, sessionRows] of bySession) {
    const chosen = sessionRows.filter((row) => selected.has(row.pane.id))
    if (!chosen.length) continue
    if (chosen.length < sessionRows.length) {
      plan.panes.push(...chosen.map((row) => row.pane.id))
      continue
    }
    const action = sessionRows[0].sessionClose
    if (action === 'pause') plan.pauseSessions.push(sessionId)
    else if (action === 'delete') plan.deleteSessions.push(sessionId)
    else plan.kept.push(...chosen.map((row) => row.pane.id))
  }
  return plan
}

