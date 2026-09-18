import type {
  AgentProvider,
  AgentStatus,
  AgentStatusKind,
  CommandoSnapshot,
  SessionBrief,
  TmuxPane,
  TmuxSession,
  TmuxWindow,
  WebPane,
} from '@commando/protocol'

/**
 * Ordering inside a group, ported verbatim from `server/companion.ts` so the
 * phone lists agents in the same order the loopback companion does.
 */
export const STATUS_PRIORITY: Record<AgentStatusKind, number> = {
  needs_input: 0,
  failed: 1,
  working: 2,
  done: 3,
  stale: 4,
  unknown: 5,
}

/**
 * Ordering used by the desktop HUD (`src/agentHud.ts`), which sorts stale
 * ahead of done. Kept separate so neither list drifts from its source.
 */
export const HUD_STATUS_PRIORITY: Record<AgentStatusKind, number> = {
  needs_input: 0,
  failed: 1,
  working: 2,
  stale: 3,
  done: 4,
  unknown: 5,
}

/** Verbatim port of `agentNeedsAttention` from `src/agentHud.ts`. */
export function agentNeedsAttention(status: AgentStatus): boolean {
  return status.status === 'needs_input' ||
    status.status === 'failed' ||
    status.details?.recap?.outcome === 'follow_up' ||
    status.details?.recap?.outcome === 'blocked' ||
    status.details?.recap?.outcome === 'failed'
}

export type AgentHudFilter = 'working' | 'attention' | 'done'

/** Verbatim port of `agentMatchesHudFilter` from `src/agentHud.ts`. */
export function agentMatchesHudFilter(status: AgentStatus, filter: AgentHudFilter): boolean {
  if (filter === 'attention') return agentNeedsAttention(status)
  return status.status === filter
}

export type AgentGroupId = 'needs_you' | 'working' | 'done' | 'idle'

export const AGENT_GROUP_LABELS: Record<AgentGroupId, string> = {
  needs_you: 'Needs you',
  working: 'Working',
  done: 'Done',
  idle: 'Idle',
}

export const AGENT_GROUP_ORDER: readonly AgentGroupId[] = ['needs_you', 'working', 'done', 'idle']

/**
 * A single row of the attention inbox: one agent pane, joined with the tmux
 * session it lives in and the worklog headline the daemon last published.
 */
export type AgentRow = {
  paneId: string
  status: AgentStatus
  provider: AgentProvider
  pane?: TmuxPane
  sessionId?: string
  sessionName: string
  windowName?: string
  headline: string
  activity?: string
  progress?: { completed: number; total: number }
  pendingQuestionCount: number
  updatedAt: number
  group: AgentGroupId
}

export type AgentGroup = {
  id: AgentGroupId
  label: string
  rows: AgentRow[]
}

export function agentGroupFor(status: AgentStatus): AgentGroupId {
  if (agentNeedsAttention(status)) return 'needs_you'
  if (status.status === 'working') return 'working'
  if (status.status === 'done') return 'done'
  return 'idle'
}

function briefHeadline(status: AgentStatus, brief: SessionBrief | undefined): string {
  const request = status.details?.requests?.[0]
  if (request) {
    const question = request.questions?.[0]
    if (question?.question) return question.question
    if (request.kind === 'permission') {
      return request.toolName ? `Permission for ${request.toolName}` : request.prompt
    }
    return request.prompt
  }
  if (brief?.headline) return brief.headline
  if (status.details?.recap?.summary) return status.details.recap.summary
  if (status.details?.intent) return status.details.intent
  return status.summary
}

function activityLine(status: AgentStatus): string | undefined {
  const request = status.details?.requests?.[0]
  if (request) {
    const options = request.questions?.[0]?.options.length ?? 0
    if (request.kind === 'question') {
      return options ? `Question · ${options} options` : 'Question'
    }
    return 'Permission request'
  }
  const activity = status.details?.currentActivity
  if (activity) return activity.label
  const check = status.details?.checks.find((candidate) => candidate.status === 'running')
  if (check) return `${check.label} · running`
  const changes = status.details?.changes
  if (changes?.fileCount) {
    return `${changes.fileCount} ${changes.fileCount === 1 ? 'file' : 'files'} changed`
  }
  return undefined
}

export type AgentRowInputs = {
  statuses: Readonly<Record<string, AgentStatus>>
  snapshot: CommandoSnapshot | null
  briefs?: Readonly<Record<string, SessionBrief>>
}

export function buildAgentRows({ statuses, snapshot, briefs = {} }: AgentRowInputs): AgentRow[] {
  const panes = new Map((snapshot?.panes ?? []).map((pane) => [pane.id, pane]))
  const sessions = new Map((snapshot?.sessions ?? []).map((session) => [session.id, session]))
  const windows = new Map((snapshot?.windows ?? []).map((window) => [window.id, window]))

  return Object.values(statuses).map((status) => {
    const pane = panes.get(status.paneId)
    const session = pane ? sessions.get(pane.sessionId) : undefined
    const window = pane ? windows.get(pane.windowId) : undefined
    const brief = briefs[status.paneId]
    const progress = status.details?.progress
    return {
      paneId: status.paneId,
      status,
      provider: status.provider,
      pane,
      sessionId: pane?.sessionId,
      sessionName: session?.name ?? brief?.sessionName ?? status.agentSessionName ?? status.paneId,
      windowName: window?.name,
      headline: briefHeadline(status, brief),
      activity: activityLine(status),
      progress: progress ? { completed: progress.completed, total: progress.total } : undefined,
      pendingQuestionCount: status.details?.requests?.length ?? 0,
      updatedAt: status.updatedAt,
      group: agentGroupFor(status),
    }
  })
}

export function compareAgentRows(left: AgentRow, right: AgentRow): number {
  return (
    STATUS_PRIORITY[left.status.status] - STATUS_PRIORITY[right.status.status] ||
    right.updatedAt - left.updatedAt ||
    left.sessionName.localeCompare(right.sessionName)
  )
}

/**
 * Attention-first grouping for the Sessions screen: the same partitioning the
 * desktop HUD filters by (attention / working / done), plus the idle bucket the
 * mockup shows at the bottom.
 */
export function groupAgentRows(rows: readonly AgentRow[]): AgentGroup[] {
  const buckets = new Map<AgentGroupId, AgentRow[]>(
    AGENT_GROUP_ORDER.map((id) => [id, [] as AgentRow[]]),
  )
  for (const row of rows) buckets.get(row.group)?.push(row)
  return AGENT_GROUP_ORDER.flatMap((id) => {
    const bucket = (buckets.get(id) ?? []).slice().sort(compareAgentRows)
    return bucket.length ? [{ id, label: AGENT_GROUP_LABELS[id], rows: bucket }] : []
  })
}

export type AgentCounts = {
  needsYou: number
  working: number
  done: number
  idle: number
  sessions: number
}

export function agentCounts(rows: readonly AgentRow[], snapshot: CommandoSnapshot | null): AgentCounts {
  return {
    needsYou: rows.filter((row) => row.group === 'needs_you').length,
    working: rows.filter((row) => row.group === 'working').length,
    done: rows.filter((row) => row.group === 'done').length,
    idle: rows.filter((row) => row.group === 'idle').length,
    sessions: snapshot?.sessions.length ?? 0,
  }
}

/* ------------------------------------------------------------------ tree -- */

export type TreePaneNode = {
  kind: 'pane'
  pane: TmuxPane
  status?: AgentStatus
}

export type TreeTileNode = {
  kind: 'tile'
  webPane: WebPane
}

export type TreeWindowNode = {
  id: string
  name: string
  index: number
  children: (TreePaneNode | TreeTileNode)[]
}

export type TreeSessionNode = {
  session: TmuxSession
  branch?: string
  windows: TreeWindowNode[]
  windowCount: number
  paneCount: number
  statuses: AgentStatusKind[]
}

export type TreeRepoGroup = {
  /** Repo root, or `ungrouped` for sessions whose panes resolve no repo. */
  id: string
  name: string
  path?: string
  sessions: TreeSessionNode[]
}

const UNGROUPED_ID = 'ungrouped'

/**
 * Repo → session → window → pane/tile, mirroring the desktop session tree. A
 * session belongs to the repo most of its panes sit in, so a stray shell in
 * `~` does not split a project in two.
 */
export function buildSessionTree(
  snapshot: CommandoSnapshot | null,
  statuses: Readonly<Record<string, AgentStatus>> = {},
  webPanes: readonly WebPane[] = [],
): TreeRepoGroup[] {
  if (!snapshot) return []
  const panesByWindow = new Map<string, TmuxPane[]>()
  for (const pane of snapshot.panes) {
    const list = panesByWindow.get(pane.windowId)
    if (list) list.push(pane)
    else panesByWindow.set(pane.windowId, [pane])
  }
  const windowsById = new Map(snapshot.windows.map((window) => [window.id, window]))
  const tilesByWindow = new Map<string, WebPane[]>()
  for (const tile of webPanes) {
    const list = tilesByWindow.get(tile.windowId)
    if (list) list.push(tile)
    else tilesByWindow.set(tile.windowId, [tile])
  }

  const groups = new Map<string, TreeRepoGroup>()

  for (const session of snapshot.sessions) {
    const sessionWindows = session.windowIds
      .map((id) => windowsById.get(id))
      .filter((window): window is TmuxWindow => Boolean(window))
      .sort((left, right) => left.index - right.index)

    const sessionPanes = sessionWindows.flatMap((window) => panesByWindow.get(window.id) ?? [])
    const repoCounts = new Map<string, { count: number; name: string; branch: string }>()
    for (const pane of sessionPanes) {
      if (!pane.repo) continue
      const existing = repoCounts.get(pane.repo.root)
      if (existing) existing.count += 1
      else repoCounts.set(pane.repo.root, { count: 1, name: pane.repo.name, branch: pane.repo.branch })
    }
    const dominant = [...repoCounts.entries()].sort((left, right) => right[1].count - left[1].count)[0]
    const groupId = dominant?.[0] ?? UNGROUPED_ID
    const groupName = dominant?.[1].name ?? 'Ungrouped'

    const node: TreeSessionNode = {
      session,
      branch: dominant?.[1].branch,
      windowCount: sessionWindows.length,
      paneCount: sessionPanes.length,
      statuses: sessionPanes
        .map((pane) => statuses[pane.id]?.status)
        .filter((status): status is AgentStatusKind => Boolean(status)),
      windows: sessionWindows.map((window) => ({
        id: window.id,
        name: window.name,
        index: window.index,
        children: [
          ...(panesByWindow.get(window.id) ?? [])
            .slice()
            .sort((left, right) => left.index - right.index)
            .map((pane): TreePaneNode => ({ kind: 'pane', pane, status: statuses[pane.id] })),
          ...(tilesByWindow.get(window.id) ?? []).map((webPane): TreeTileNode => ({
            kind: 'tile',
            webPane,
          })),
        ],
      })),
    }

    const group = groups.get(groupId)
    if (group) group.sessions.push(node)
    else {
      groups.set(groupId, {
        id: groupId,
        name: groupName,
        path: dominant?.[0],
        sessions: [node],
      })
    }
  }

  return [...groups.values()]
    .sort((left, right) => {
      if (left.id === UNGROUPED_ID) return 1
      if (right.id === UNGROUPED_ID) return -1
      return left.name.localeCompare(right.name)
    })
    .map((group) => ({
      ...group,
      sessions: group.sessions.slice().sort((left, right) => (
        left.session.name.localeCompare(right.session.name)
      )),
    }))
}

/** Dot cluster order for a session row: worst status first. */
export function sortStatusKinds(statuses: readonly AgentStatusKind[]): AgentStatusKind[] {
  return statuses.slice().sort((left, right) => STATUS_PRIORITY[left] - STATUS_PRIORITY[right])
}

export function providerLabel(provider: AgentProvider): string {
  if (provider === 'claude') return 'Claude'
  if (provider === 'codex') return 'Codex'
  if (provider === 'opencode') return 'OpenCode'
  return 'Agent'
}
