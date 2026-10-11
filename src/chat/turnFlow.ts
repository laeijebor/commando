import type { ChatItem, ChatSessionInfo, ChatSessionPermissionMode } from '../../shared/agent-chat'
import type { ChatPermissionMode } from '../../shared/tmux-create'
import type { PlanItem, SubagentItem } from './timelineRows'

// ---- plans (after t3code's proposedPlan.ts) ----

/** Long plans fold to a preview, as t3code's ProposedPlanCard does. */
export function canCollapsePlan(markdown: string): boolean {
  return markdown.length > 900 || markdown.split('\n').length > 20
}

/** The plan without its title heading (the card shows it) or a "Summary" heading. */
export function planBody(markdown: string): string {
  const lines = markdown.trimEnd().split(/\r?\n/)
  const body = lines[0] && /^\s{0,3}#{1,6}\s+/.test(lines[0]) ? lines.slice(1) : [...lines]
  while (body[0]?.trim().length === 0) body.shift()
  if (body[0]?.match(/^\s{0,3}#{1,6}\s+(.+)$/)?.[1]?.trim().toLowerCase() === 'summary') {
    body.shift()
    while (body[0]?.trim().length === 0) body.shift()
  }
  return body.join('\n')
}

/** The first `maxLines` lines that have text, then an ellipsis (t3code's collapsed preview). */
export function collapsedPlanPreview(markdown: string, maxLines = 10): string {
  const preview: string[] = []
  let visible = 0
  let more = false
  for (const line of planBody(markdown).split('\n').map((value) => value.trimEnd())) {
    if (line.trim() && visible >= maxLines) {
      more = true
      break
    }
    preview.push(line)
    if (line.trim()) visible += 1
  }
  while (preview.length && !preview.at(-1)?.trim()) preview.pop()
  if (more) preview.push('', '…')
  return preview.join('\n')
}

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

/** "12s", "3m 05s", "1h 02m". */
export function elapsedLabel(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`
}

/**
 * Tool count, elapsed time and the latest thing a subagent did, from its task
 * events or its own items. Counts are null when nothing reported them (a
 * resumed background subagent), rather than a misleading zero.
 */
export function subagentActivity(agent: SubagentItem, items: readonly ChatItem[], now: number): { toolUses: number | null; elapsedMs: number | null; lastAction: string | null } {
  const own = items.filter((item) => item.parentToolUseId === agent.id)
  const work = own.filter((item) => item.kind === 'command' || item.kind === 'file_change' || item.kind === 'tool' || item.kind === 'subagent')
  const last = work.at(-1)
  const lastWork = last
    ? last.kind === 'command' ? `$ ${last.command}` : last.kind === 'file_change' ? `Edited ${last.path}` : last.kind === 'subagent' ? `Subagent: ${last.description}` : last.title
    : null
  const running = agent.state === 'running'
  const spanMs = agent.updatedAt - agent.createdAt
  return {
    toolUses: agent.toolUses !== undefined || work.length ? Math.max(agent.toolUses ?? 0, work.length) : null,
    // Live elapsed time ticks from when Claude started it. Afterwards, Claude's own
    // total; a stopped subagent's last progress report undercounts, so never less than it ran.
    elapsedMs: running ? now - agent.createdAt : agent.durationMs !== undefined || spanMs > 0 ? Math.max(agent.durationMs ?? 0, spanMs) : null,
    lastAction: running ? agent.summary ?? lastWork ?? (agent.lastToolName ? `Using ${agent.lastToolName}` : null) : agent.summary ?? lastWork,
  }
}

/** The subagent a view is open on, by its Agent call's id. */
export function findSubagent(items: readonly ChatItem[], toolUseId: string): SubagentItem | undefined {
  const item = items.find((candidate) => candidate.id === toolUseId)
  return item?.kind === 'subagent' ? item : undefined
}

/**
 * The agents the switcher lists (after the Claude Code TUI's agent list):
 * every running subagent, the subagents of the latest turn that started any,
 * and the one being viewed, oldest first.
 */
export function switcherSubagents(items: readonly ChatItem[], viewing?: string): SubagentItem[] {
  const subagents = items.filter((item): item is SubagentItem => item.kind === 'subagent' && !item.parentToolUseId)
  const latestTurn = subagents.at(-1)?.turnId
  return subagents.filter((item) => item.state === 'running' || item.turnId === latestTurn || item.id === viewing)
}

/** A short name for a subagent in labels: its description, else its type. */
export function subagentLabel(agent: SubagentItem): string {
  return agent.description || agent.subagentType || 'Subagent'
}

/**
 * Whether "Message @agent" can reach it now. Main Claude relays with
 * SendMessage, which a background subagent reads at its next tool round and
 * which resumes a finished one. A foreground subagent holds main Claude in
 * its Agent call, so the relay would only arrive after it ends.
 */
export function relayAvailability(agent: SubagentItem): { ok: true } | { ok: false; reason: string } {
  if (!agent.agentId) return { ok: false, reason: "Claude hasn't reported this subagent's id yet" }
  if (agent.state === 'running' && !agent.background) return { ok: false, reason: 'Background this subagent to message it while it runs' }
  return { ok: true }
}
