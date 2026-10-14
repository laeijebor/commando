import type { ChatItem, ExternalAgentRun } from './agent-chat.js'

export type WorkItem = Extract<ChatItem, { kind: 'command' | 'file_change' | 'tool' | 'request' }>
export type ReasoningItem = Extract<ChatItem, { kind: 'reasoning' }>
export type SubagentItem = Extract<ChatItem, { kind: 'subagent' }>
export type PlanItem = Extract<ChatItem, { kind: 'plan' }>

export type TimelineRow =
  | { kind: 'user'; id: string; item: Extract<ChatItem, { kind: 'user_message' }> }
  | { kind: 'assistant'; id: string; item: Extract<ChatItem, { kind: 'assistant_message' }> }
  | { kind: 'work'; id: string; items: WorkItem[]; live: boolean; summary: string }
  | { kind: 'thought'; id: string; item: ReasoningItem }
  | { kind: 'notice'; id: string; item: Extract<ChatItem, { kind: 'notice' }> }
  | { kind: 'plan'; id: string; item: PlanItem }
  /** Subagents started next to each other in a turn, as t3code groups them. */
  | { kind: 'subagents'; id: string; items: SubagentItem[]; live: boolean }

/** External runs join the command that launched them, even when snapshots arrive later. */
export function withExternalAgentRuns(items: readonly ChatItem[], runs: readonly ExternalAgentRun[]): ChatItem[] {
  const after = new Map<number, SubagentItem[]>()
  const invocation = {
    codex: /(?:^|[\s/"'])codex(?:\.js)?["']?\s+exec\b/,
    claude: /(?:^|[\s/"'])claude["']?\s+[^\n]*(?:--print\b|-p\b)/,
    opencode: /(?:^|[\s/"'])opencode["']?\s+run\b/,
    cursor: /(?:^|[\s/"'])(?:cursor-agent|agent)["']?\s+[^\n]*(?:--print\b|-p\b)/,
  }
  for (const run of [...runs].sort((a, b) => a.startedAt - b.startedAt)) {
    let anchor = -1
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index]!
      if (!item.parentToolUseId && item.kind === 'command' && item.createdAt <= run.startedAt + 10_000 && invocation[run.runtime].test(item.command)
        && (anchor < 0 || item.createdAt >= items[anchor]!.createdAt)) anchor = index
    }
    if (anchor < 0) {
      for (let index = 0; index < items.length; index += 1) {
        if (!items[index]!.parentToolUseId && items[index]!.createdAt <= run.startedAt) anchor = index
      }
    }
    const live = run.state === 'running' || run.state === 'quiet'
    const item: SubagentItem = {
      id: run.id, kind: 'subagent', toolUseId: run.id,
      turnId: items[anchor]?.turnId ?? `external-turn-${run.id}`,
      status: live ? 'running' : run.state === 'failed' ? 'failed' : run.state === 'stopped' ? 'interrupted' : 'completed',
      createdAt: run.startedAt, updatedAt: run.finishedAt ?? run.updatedAt,
      description: run.label, runtime: run.runtime, state: run.state,
      model: run.model, effort: run.effort, toolUses: run.toolUses,
      lastEventAt: run.lastEventAt, lastAction: run.lastAction,
      runningCommand: run.runningCommand, durationMs: run.durationMs, summary: run.summary,
    }
    const group = after.get(anchor) ?? []
    group.push(item)
    after.set(anchor, group)
  }
  return [...(after.get(-1) ?? []), ...items.flatMap((item, index) => [item, ...(after.get(index) ?? [])])]
}

export function isWork(item: ChatItem): item is WorkItem {
  return item.kind === 'command' || item.kind === 'file_change' || item.kind === 'tool' || item.kind === 'request'
}

/** "Thought for 14s"; a replayed thought has no timing, so just "Thought". */
export function thoughtLabel(item: ReasoningItem): string {
  if (item.status === 'running') return 'Thinking…'
  const seconds = Math.round((item.updatedAt - item.createdAt) / 1000)
  return item.updatedAt > item.createdAt ? `Thought for ${Math.max(1, seconds)}s` : 'Thought'
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}

/** Work parts in label order: "ran 2 commands", "edited 3 files", …, keyed so callers can single one out. */
function workParts(items: readonly WorkItem[]): { kind: 'commands' | 'edits' | 'other'; text: string }[] {
  let commands = 0
  let reads = 0
  let searches = 0
  let tools = 0
  let requests = 0
  const editedPaths = new Set<string>()
  for (const item of items) {
    if (item.kind === 'command') commands += 1
    else if (item.kind === 'file_change') editedPaths.add(item.path)
    else if (item.kind === 'request') requests += 1
    else if (item.toolName === 'Read') reads += 1
    else if (item.toolName === 'Grep' || item.toolName === 'Glob' || item.toolName === 'WebSearch') searches += 1
    else tools += 1
  }
  const parts: { kind: 'commands' | 'edits' | 'other'; text: string }[] = []
  if (commands) parts.push({ kind: 'commands', text: `ran ${plural(commands, 'command', 'commands')}` })
  if (editedPaths.size) parts.push({ kind: 'edits', text: `edited ${plural(editedPaths.size, 'file', 'files')}` })
  if (reads) parts.push({ kind: 'other', text: `read ${plural(reads, 'file', 'files')}` })
  if (searches) parts.push({ kind: 'other', text: `searched ${plural(searches, 'time', 'times')}` })
  if (tools) parts.push({ kind: 'other', text: `used ${plural(tools, 'tool', 'tools')}` })
  if (requests) parts.push({ kind: 'other', text: plural(requests, 'approval', 'approvals') })
  return parts
}

/** "Ran 2 commands, edited 3 files, read 2 files" — the collapsed work-group label. */
export function workSummary(items: readonly WorkItem[]): string {
  return capitalize(workParts(items).map((part) => part.text).join(', '))
}

/**
 * Groups consecutive tool activity into collapsible work rows between the
 * user's messages and Claude's replies, as t3code's timeline does. Thinking
 * gets its own collapsed row. Pending requests and todo lists are shown in
 * the composer, not the timeline.
 *
 * `scope` picks one conversation: the main one (undefined), or a subagent's
 * (its Agent call's tool_use id). A subagent's own items stay out of the
 * main timeline; its row opens them.
 */
export function deriveTimelineRows(items: readonly ChatItem[], scope?: string): TimelineRow[] {
  const rows: TimelineRow[] = []
  let group: WorkItem[] = []
  let agents: SubagentItem[] = []
  const externalGroups = new Map<string, Extract<TimelineRow, { kind: 'subagents' }>>()
  const flush = () => {
    if (group.length) {
      rows.push({
        kind: 'work',
        id: `work-${group[0]!.id}`,
        items: group,
        live: group.some((item) => item.status === 'running'),
        summary: workSummary(group),
      })
      group = []
    }
    if (agents.length) {
      // Separate Bash calls in the same turn still form one external-run card.
      const remaining = agents.filter((agent) => {
        const existing = agent.runtime ? externalGroups.get(agent.turnId) : undefined
        if (!existing) return true
        existing.items.push(agent)
        existing.live ||= agent.state === 'running' || agent.state === 'quiet'
        return false
      })
      if (remaining.length) {
        const row: Extract<TimelineRow, { kind: 'subagents' }> = { kind: 'subagents', id: `subagents-${remaining[0]!.id}`, items: remaining, live: remaining.some((item) => item.state === 'running' || item.state === 'quiet') }
        rows.push(row)
        for (const agent of remaining) { if (agent.runtime) externalGroups.set(agent.turnId, row) }
      }
      agents = []
    }
  }
  for (const item of items) {
    if (item.parentToolUseId !== scope) continue
    if (item.kind === 'subagent') {
      // Work and subagents rarely interleave; each run gets its own row.
      if (group.length) flush()
      agents.push(item)
      continue
    }
    if (agents.length && isWork(item) && !(item.kind === 'request' && !item.answer)) flush()
    // Open requests live in the composer; answered ones join the work group.
    if (item.kind === 'request' && !item.answer) continue
    if (isWork(item)) {
      group.push(item)
      continue
    }
    if (item.kind === 'todo_list') continue
    // An empty, finished thought adds nothing worth a row (and keeps a work group whole).
    if (item.kind === 'reasoning' && !item.text && item.status !== 'running') continue
    flush()
    if (item.kind === 'user_message') rows.push({ kind: 'user', id: item.id, item })
    else if (item.kind === 'assistant_message') {
      if (item.text || item.status === 'running') rows.push({ kind: 'assistant', id: item.id, item })
    } else if (item.kind === 'reasoning') rows.push({ kind: 'thought', id: item.id, item })
    else if (item.kind === 'notice') rows.push({ kind: 'notice', id: item.id, item })
    else if (item.kind === 'plan') rows.push({ kind: 'plan', id: item.id, item })
  }
  flush()
  return rows
}

export function pendingRequests(items: readonly ChatItem[]): Extract<ChatItem, { kind: 'request' }>[] {
  return items.filter((item): item is Extract<ChatItem, { kind: 'request' }> => item.kind === 'request' && !item.answer && item.status === 'running')
}

export function latestTodos(items: readonly ChatItem[]): Extract<ChatItem, { kind: 'todo_list' }> | undefined {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]!
    // A subagent's own todo list belongs to its transcript.
    if (item.kind === 'todo_list' && !item.parentToolUseId) return item
  }
  return undefined
}

/** Shell-style lines of a hunk built from tool input (see agent-host/claude-items). */
export function patchLines(patch: string): { kind: 'add' | 'del' | 'context' | 'gap'; text: string }[] {
  return patch.split('\n').map((line) => {
    if (line === '@@' || line.startsWith('… ')) return { kind: 'gap', text: line === '@@' ? '⋯' : line }
    if (line.startsWith('+')) return { kind: 'add', text: line.slice(1) }
    if (line.startsWith('-')) return { kind: 'del', text: line.slice(1) }
    return { kind: 'context', text: line }
  })
}

/** Paths inside the session folder read better relative to it. */
export function shortPath(text: string, cwd: string): string {
  return cwd ? text.split(`${cwd}/`).join('') : text
}

// Plans, after t3code's proposedPlan.ts.

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

// The web chat's quieter timeline: one faint line per stretch of activity.

/** A step in a stretch of activity between two messages: tool work or the thinking around it. */
export type ActivityItem = WorkItem | ReasoningItem
export type ActivityRow = { kind: 'activity'; id: string; items: ActivityItem[]; live: boolean }
export type QuietTimelineRow = Exclude<TimelineRow, { kind: 'work' | 'thought' }> | ActivityRow

/**
 * Merges adjacent work and thought rows, so each stretch between two
 * messages (or plans, subagents and notices) becomes one activity row.
 * Thinking interleaved with tools otherwise splits a stretch into many rows.
 */
export function mergeActivityRows(rows: readonly TimelineRow[]): QuietTimelineRow[] {
  const merged: QuietTimelineRow[] = []
  for (const row of rows) {
    if (row.kind !== 'work' && row.kind !== 'thought') {
      merged.push(row)
      continue
    }
    const items = row.kind === 'work' ? row.items : [row.item]
    const live = row.kind === 'work' ? row.live : row.item.status === 'running'
    const last = merged.at(-1)
    if (last?.kind === 'activity') {
      last.items.push(...items)
      last.live ||= live
    } else {
      merged.push({ kind: 'activity', id: `activity-${items[0]!.id}`, items: [...items], live })
    }
  }
  return merged
}

export type ActivitySummary = {
  /** "Edited 2 files" and the stretch's line counts; null when nothing was edited. */
  edits: { label: string; additions: number; deletions: number } | null
  /** The other steps, capitalised when they lead: "ran 2 commands, read 1 file". "Thought" for thinking alone. */
  rest: string
  /** Commands, edits and tools that reported an error. */
  failed: number
  /** From the first step's start to the last one's end (or `now` while live); null for untimed history. */
  elapsedMs: number | null
}

/**
 * The faint line's summary. Edits lead (they are what changed), failures are
 * counted so quieting never hides them, and thinking isn't named unless it
 * is all the stretch did.
 */
export function activitySummary(items: readonly ActivityItem[], now?: number): ActivitySummary {
  const work = items.filter(isWork)
  const parts = workParts(work)
  const edited = parts.find((part) => part.kind === 'edits')
  let additions = 0
  let deletions = 0
  let failed = 0
  for (const item of work) {
    if (item.kind === 'file_change') {
      additions += item.additions
      deletions += item.deletions
    }
    if (item.kind !== 'request' && (item.isError || item.status === 'failed')) failed += 1
  }
  const others = parts.filter((part) => part !== edited).map((part) => part.text).join(', ')
  const rest = work.length ? (edited ? others : capitalize(others)) : 'Thought'
  const start = Math.min(...items.map((item) => item.createdAt))
  const end = now ?? Math.max(...items.map((item) => item.updatedAt))
  return {
    edits: edited ? { label: capitalize(edited.text), additions, deletions } : null,
    rest,
    failed,
    elapsedMs: items.length && end - start >= 1000 ? end - start : null,
  }
}
