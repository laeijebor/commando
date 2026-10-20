import type { ChatState } from '../shared/agent-chat'
import type { CommanderRelay, TurnBrief } from '../shared/commander'
import type { AgentStatus, SessionBrief, TmuxPane, TmuxSession } from '../shared/protocol'
import { agentNeedsAttention } from './agentHud'
import { paneAttention, type PaneAttention } from './sessionIndicator'

export type InboxGroup = 'needs_you' | 'finished' | 'working' | 'idle'
export type CommanderInboxRow = {
  paneId: string
  targetId: string
  title: string
  sessionName: string
  status: AgentStatus['status']
  attention: PaneAttention
  brief?: string
  briefTone: 'normal' | 'warn'
  unread: boolean
  /** Turn end, or the start of the current working turn, in daemon milliseconds. */
  time: number
  toolCount?: number
  latestRelay?: CommanderRelay
}
export type CommanderInbox = Record<InboxGroup, CommanderInboxRow[]>

export type CommanderInboxInput = {
  snapshot: { panes: readonly TmuxPane[]; sessions: readonly TmuxSession[] } | null
  agentStatuses: Readonly<Record<string, AgentStatus>>
  paneBriefs: Readonly<Record<string, SessionBrief>>
  paneSeen: Readonly<Record<string, number>>
  turnBriefs: Readonly<Record<string, TurnBrief>>
  chats: Readonly<Record<string, ChatState>>
  relays: Readonly<Record<string, CommanderRelay>>
  commanderPaneId?: string
  now?: number
}

/** Keep the directory derived from live panes, never from stale status/brief keys. */
export function commanderInbox(input: CommanderInboxInput): CommanderInbox {
  const groups: CommanderInbox = { needs_you: [], finished: [], working: [], idle: [] }
  const now = input.now ?? Date.now()
  const sessionNames = new Map(input.snapshot?.sessions.map((session) => [session.id, session.name]))
  const relays = new Map<string, CommanderRelay>()
  for (const relay of Object.values(input.relays)) {
    if (!relayReceiptVisible(relay, now)) continue
    if (!relays.has(relay.toTargetId) || relays.get(relay.toTargetId)!.createdAt < relay.createdAt) relays.set(relay.toTargetId, relay)
  }
  for (const pane of input.snapshot?.panes ?? []) {
    if (pane.id === input.commanderPaneId) continue
    const suppliedChat = input.chats[pane.id]
    const chat = suppliedChat && (!suppliedChat.targetId || suppliedChat.targetId === pane.targetId) ? suppliedChat : undefined
    const suppliedStatus = input.agentStatuses[pane.id]
    if ((!suppliedStatus || suppliedStatus.provider === 'unknown') && !chat) continue
    const items = chat?.items.filter((item) => !item.parentToolUseId) ?? []
    const turnId = items.at(-1)?.turnId
    const turn = items.filter((item) => item.turnId === turnId)
    const endedAt = turn.length ? Math.max(...turn.map((item) => item.updatedAt)) : undefined
    const status: AgentStatus = suppliedStatus ?? {
      paneId: pane.id, provider: 'unknown',
      status: chat?.session.status === 'running' || chat?.session.status === 'starting' ? 'working'
        : chat?.session.status === 'waiting' ? 'needs_input'
        : chat?.session.status === 'error' ? 'failed' : 'done',
      summary: '', source: 'process', confidence: 'high', reason: '', updatedAt: endedAt ?? 0,
    }
    const suppliedBrief = input.paneBriefs[pane.id]
    const brief = suppliedBrief && (!suppliedBrief.targetId || suppliedBrief.targetId === pane.targetId) ? suppliedBrief : undefined
    const candidate = input.turnBriefs[pane.targetId]
    const latestEnd = chat ? status.settledAt : status.details?.recap?.completedAt ?? status.settledAt ?? endedAt
    // A summary of an earlier turn must never ask for attention on a later one.
    const currentBrief = candidate && status.status !== 'working' && latestEnd !== undefined &&
      candidate.targetId === pane.targetId && candidate.endedAt === latestEnd &&
      (chat ? (turn[0]?.createdAt ?? 0) <= candidate.endedAt : !endedAt || endedAt <= candidate.endedAt) ? candidate : undefined
    const attention = paneAttention(status, input.paneSeen[pane.id])
    const needsYou = agentNeedsAttention(status) || currentBrief?.kind === 'needs_you'
    const stalled = currentBrief?.kind === 'stalled'
    const group: InboxGroup = needsYou ? 'needs_you'
      : stalled || attention === 'review' || attention === 'finished' ? 'finished'
      : status.status === 'working' ? 'working' : 'idle'
    const row: CommanderInboxRow = {
      paneId: pane.id, targetId: pane.targetId,
      title: brief?.title || chat?.session.title || pane.chatTitle || pane.title || status.agentSessionName || `Pane ${pane.index}`,
      sessionName: sessionNames.get(pane.sessionId) ?? '',
      status: status.status, attention,
      brief: currentBrief?.text || status.details?.recap?.summary || brief?.headline || status.summary || undefined,
      briefTone: needsYou || stalled ? 'warn' : 'normal',
      unread: status.settledAt !== undefined && status.settledAt > (input.paneSeen[pane.id] ?? -Infinity),
      time: group === 'working' ? turn[0]?.createdAt ?? status.updatedAt
        : currentBrief?.endedAt ?? (group === 'needs_you' ? status.updatedAt : status.settledAt ?? status.updatedAt),
      ...(chat && turn.length ? { toolCount: new Set(turn.flatMap((item) => 'toolUseId' in item ? [item.toolUseId] : [])).size } : {}),
      latestRelay: relays.get(pane.targetId),
    }
    groups[group].push(row)
  }
  for (const rows of Object.values(groups)) rows.sort((a, b) => b.time - a.time || a.paneId.localeCompare(b.paneId))
  return groups
}

/** A queued relay always shows; a finished one shows for 15 minutes after it left the queue. */
export function relayReceiptVisible(relay: CommanderRelay, now: number): boolean {
  return relay.status === 'queued' || (relay.settledAt ?? relay.deliveredAt ?? relay.createdAt) >= now - 15 * 60_000
}
