import type { ChatItem, ChatSessionInfo, ChatSessionPermissionMode } from '../../shared/agent-chat'
import type { ChatPermissionMode } from '../../shared/tmux-create'
import type { PlanItem } from '../../shared/chat-timeline'

// ---- plans (after t3code's proposedPlan.ts) ----

/**
 * The plan the composer offers to implement or refine: Claude's latest plan,
 * while nothing has been sent since and Claude isn't working.
 */
export function planAwaitingFollowUp(items: readonly ChatItem[], session: ChatSessionInfo): PlanItem | null {
  if (session.status === 'running' || session.status === 'waiting' || session.status === 'starting') return null
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]!
    if (item.parentToolUseId) continue
    if (item.kind === 'user_message') return null
    if (item.kind === 'plan') return item
  }
  return null
}

/** Implement returns to the mode the chat had before plan mode (the user's choice), else asks before edits. */
export function implementPermissionMode(session: ChatSessionInfo): ChatSessionPermissionMode {
  const mode = session.prePlanPermissionMode
  return mode && mode !== 'plan' ? mode : 'default'
}

/** A new chat pane starts in one of the launch modes; others start by asking before edits. */
export function launchPermissionMode(mode: ChatSessionPermissionMode): ChatPermissionMode {
  return mode === 'acceptEdits' || mode === 'bypassPermissions' ? mode : 'default'
}

/** The longest opening prompt a new pane takes (the daemon's limit, with room to spare). */
export const MAX_PANE_PROMPT_BYTES = 7_800

/** The opening prompt of a pane that implements a plan saved to a file. */
export function implementPlanFilePrompt(path: string): string {
  return `PLEASE IMPLEMENT THE PLAN saved at ${path}. Read the whole file first; it is the plan the user approved.`
}

// ---- subagents ----

// Shared with the companion app; re-exported so the web's imports stay put.
export {
  elapsedLabel,
  findSubagent,
  relayAvailability,
  subagentActivity,
  subagentLabel,
  subagentTypeLabel,
  switcherSubagents,
} from '../../shared/chat-subagents'
