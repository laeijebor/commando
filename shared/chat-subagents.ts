import type { ChatItem } from './agent-chat.js'
import type { SubagentItem } from './chat-timeline.js'

// Subagent presentation shared by the web chat and the companion app: labels,
// the metrics line, the agent switcher's list and whether a relay can reach one.

/** "12s", "3m 05s", "1h 02m". */
export function elapsedLabel(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`
}

/** Whether a subagent is still working (quiet means alive but silent for a while). */
export function subagentLive(agent: SubagentItem): boolean {
  return agent.state === 'running' || agent.state === 'quiet'
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
  const running = subagentLive(agent)
  const spanMs = agent.updatedAt - agent.createdAt
  return {
    toolUses: agent.toolUses !== undefined || work.length ? Math.max(agent.toolUses ?? 0, work.length) : null,
    // Live elapsed time ticks from when Claude started it. Afterwards, Claude's own
    // total; a stopped subagent's last progress report undercounts, so never less than it ran.
    elapsedMs: running ? now - agent.createdAt : agent.durationMs !== undefined || spanMs >= 1000 ? Math.max(agent.durationMs ?? 0, spanMs) : null,
    lastAction: agent.runtime ? (running ? agent.lastAction ?? agent.summary : agent.summary ?? agent.lastAction) ?? null : running ? agent.summary ?? lastWork ?? (agent.lastToolName ? `Using ${agent.lastToolName}` : null) : agent.summary ?? lastWork,
  }
}

/** The words the metrics line uses for each state. */
export const SUBAGENT_STATE_LABELS: Record<SubagentItem['state'], string> = { quiet: 'quiet', running: 'running', completed: 'done', failed: 'failed', stopped: 'stopped' }

/** A subagent's metrics line: "background · 4 tools · 1m 05s", plus "quiet for 4m" and the last action. */
export interface SubagentMetrics {
  line: string
  lastAction: string | null
  /** An external run that has been silent past the daemon's threshold. */
  quiet?: string
}

export function subagentMetrics(agent: SubagentItem, items: readonly ChatItem[], now: number): SubagentMetrics {
  const activity = subagentActivity(agent, items, now)
  const parts = [
    ...(!agent.runtime ? [agent.background && subagentLive(agent) ? 'background' : SUBAGENT_STATE_LABELS[agent.state]] : []),
    ...(activity.toolUses !== null ? [`${activity.toolUses} ${activity.toolUses === 1 ? 'tool' : 'tools'}`] : []),
    ...(activity.elapsedMs !== null ? [elapsedLabel(activity.elapsedMs)] : []),
  ]
  if (agent.runtime && agent.state === 'quiet') return {
    line: parts.join(' · '),
    quiet: `quiet for ${Math.floor(Math.max(0, now - (agent.lastEventAt ?? agent.createdAt)) / 60_000)}m`,
    lastAction: activity.lastAction ? `last: ${activity.lastAction}` : null,
  }
  if (agent.runtime && agent.runningCommand) {
    parts.push(`running ${agent.runningCommand.command} (${elapsedLabel(now - agent.runningCommand.startedAt)})`)
    return { line: parts.join(' · '), lastAction: null }
  }
  return { line: parts.join(' · '), lastAction: activity.lastAction }
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
  return subagents.filter((item) => subagentLive(item) || item.turnId === latestTurn || item.id === viewing)
}

/** Runtime, model and effort occupy the SDK subagent type slot. */
export function subagentTypeLabel(agent: SubagentItem): string {
  if (!agent.runtime) return agent.subagentType ?? ''
  const names = { codex: 'Codex', claude: 'Claude', opencode: 'OpenCode', cursor: 'Cursor' }
  const model = [agent.model, agent.effort].filter(Boolean).join(' ')
  return `${names[agent.runtime]}${model ? ` · ${model}` : ''}`
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
  if (agent.runtime) return { ok: false, reason: 'External runs have no message relay or transcript' }
  if (!agent.agentId) return { ok: false, reason: "Claude hasn't reported this subagent's id yet" }
  if (agent.state === 'running' && !agent.background) return { ok: false, reason: 'Background this subagent to message it while it runs' }
  return { ok: true }
}

/** Which controls a subagent offers: Stop for any live one we can address, Background for a foreground SDK one. */
export function subagentControls(agent: SubagentItem): { stop: boolean; background: boolean } {
  if (!subagentLive(agent) || (!agent.runtime && !agent.agentId)) return { stop: false, background: false }
  return { stop: true, background: !agent.runtime && !agent.background }
}
