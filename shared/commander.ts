/**
 * Commander: one chat that briefs the user on every agent pane and relays
 * their messages. Shared contract between the daemon and the web UI.
 */

/** How a finished turn left the agent, as judged when the turn is summarised. */
export type TurnBriefKind =
  /** The agent finished what it was doing. */
  | 'done'
  /** The agent asked the user something or is waiting on a decision. */
  | 'needs_you'
  /** The agent stopped before finishing without needing the user (error, gave up, "I'll continue"). */
  | 'stalled'

/** A one-line summary of an agent pane's latest finished turn. */
export type TurnBrief = {
  paneId: string
  /** Stable pane identity across tmux restarts; briefs are keyed by it. */
  targetId: string
  /** Identifies the turn: terminal recap.completedAt, or a chat done run's settledAt. */
  turnKey: string
  /** ≤ 160 chars, single line. */
  text: string
  kind: TurnBriefKind
  /** `fallback` is the agent's own recap line, shown until (or instead of) the model summary. */
  source: 'model' | 'fallback'
  /** When the turn ended (daemon clock, ms). */
  endedAt: number
  createdAt: number
}

export const TURN_BRIEF_MAX_CHARS = 160

/** A message Commander (or the user from the inbox) asked the daemon to deliver to an agent pane. */
export type CommanderRelay = {
  id: string
  /** Who asked: the Commander agent, the daemon's stall watcher, or the user from the inbox. */
  origin: 'commander' | 'inbox'
  /** `nudge` = Commander poking a stalled agent on its own; `relay` = the user's words. */
  kind: 'relay' | 'nudge'
  toPaneId: string
  toTargetId: string
  /** Retain chat routing while its host reconnects after a daemon restart. */
  toChat?: boolean
  /** The exact text delivered (already tagged, e.g. "[relayed by Commander] …"). */
  text: string
  /** `queue` waits for the target's turn to end; `steer` interrupts (only on the user's explicit request). */
  delivery: 'queue' | 'steer'
  /** `delivered` means handed to the agent input (host or terminal), not acknowledged by the model. */
  status: 'queued' | 'delivered' | 'failed' | 'cancelled'
  error?: string
  createdAt: number
  deliveredAt?: number
  /** When the relay left the queue (delivered, failed or cancelled). */
  settledAt?: number
}

export const RELAY_TAG = '[relayed by Commander]'
export const NUDGE_TAG = '[nudge from Commander]'
export const RELAY_MAX_CHARS = 4000

/** Which pane is the Commander, if one exists. Persisted by the daemon. */
export type CommanderState = {
  /** The Commander chat pane's stable target id. */
  targetId: string | null
  /** Its current tmux pane and session, when the target is live. */
  paneId?: string
  sessionId?: string
}

/** One agent as Commander's `list` reports it (also the inbox row model on the daemon side). */
export type CommanderAgent = {
  paneId: string
  targetId: string
  sessionId: string
  sessionName: string
  title: string
  provider: string
  /** Mirrors AgentStatusKind. */
  status: string
  /** Agent needs the user (permission prompt, question, blocked recap). */
  needsYou: boolean
  /** Daemon thinks the agent stalled: failed turn, `stalled` brief, or working with no activity for a long time. */
  stalled: boolean
  headline: string
  brief?: TurnBrief
  /** True when the turn ended after the user last viewed the pane. */
  unread: boolean
  cwd: string
  updatedAt: number
}
