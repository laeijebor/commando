import type { ChatItem } from '../../shared/agent-chat'

export type WorkItem = Extract<ChatItem, { kind: 'command' | 'file_change' | 'tool' | 'reasoning' | 'request' }>

export type TimelineRow =
  | { kind: 'user'; id: string; item: Extract<ChatItem, { kind: 'user_message' }> }
  | { kind: 'assistant'; id: string; item: Extract<ChatItem, { kind: 'assistant_message' }> }
  | { kind: 'work'; id: string; items: WorkItem[]; live: boolean; summary: string }
  | { kind: 'notice'; id: string; item: Extract<ChatItem, { kind: 'notice' }> }

function isWork(item: ChatItem): item is WorkItem {
  return item.kind === 'command' || item.kind === 'file_change' || item.kind === 'tool' || item.kind === 'reasoning' || item.kind === 'request'
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`
}

/** "Ran 2 commands, edited 3 files, read 2 files" — the collapsed work-group label. */
export function workSummary(items: readonly WorkItem[]): string {
  let commands = 0
  let edits = 0
  let reads = 0
  let searches = 0
  let tools = 0
  let thoughts = 0
  let requests = 0
  const editedPaths = new Set<string>()
  for (const item of items) {
    if (item.kind === 'command') commands += 1
    else if (item.kind === 'file_change') { edits += 1; editedPaths.add(item.path) }
    else if (item.kind === 'reasoning') thoughts += 1
    else if (item.kind === 'request') requests += 1
    else if (item.toolName === 'Read') reads += 1
    else if (item.toolName === 'Grep' || item.toolName === 'Glob' || item.toolName === 'WebSearch') searches += 1
    else tools += 1
  }
  const parts: string[] = []
  if (commands) parts.push(`ran ${plural(commands, 'command', 'commands')}`)
  if (edits) parts.push(`edited ${plural(editedPaths.size, 'file', 'files')}`)
  if (reads) parts.push(`read ${plural(reads, 'file', 'files')}`)
  if (searches) parts.push(`searched ${plural(searches, 'time', 'times')}`)
  if (tools) parts.push(`used ${plural(tools, 'tool', 'tools')}`)
  if (requests) parts.push(plural(requests, 'approval', 'approvals'))
  if (!parts.length && thoughts) parts.push('thought')
  const text = parts.join(', ')
  return text.charAt(0).toUpperCase() + text.slice(1)
}

/**
 * Groups consecutive tool activity into collapsible work rows between the
 * user's messages and Claude's replies, as t3code's timeline does. Pending
 * requests and todo lists are shown in the composer, not the timeline.
 */
export function deriveTimelineRows(items: readonly ChatItem[]): TimelineRow[] {
  const rows: TimelineRow[] = []
  let group: WorkItem[] = []
  const flush = () => {
    if (!group.length) return
    // An empty, finished thought on its own adds nothing worth a row.
    const meaningful = group.filter((item) => item.kind !== 'reasoning' || item.text || item.status === 'running')
    if (meaningful.length) {
      rows.push({
        kind: 'work',
        id: `work-${meaningful[0]!.id}`,
        items: meaningful,
        live: meaningful.some((item) => item.status === 'running'),
        summary: workSummary(meaningful),
      })
    }
    group = []
  }
  for (const item of items) {
    // Open requests live in the composer; answered ones join the work group.
    if (item.kind === 'request' && !item.answer) continue
    if (isWork(item)) {
      group.push(item)
      continue
    }
    if (item.kind === 'todo_list') continue
    flush()
    if (item.kind === 'user_message') rows.push({ kind: 'user', id: item.id, item })
    else if (item.kind === 'assistant_message') {
      if (item.text || item.status === 'running') rows.push({ kind: 'assistant', id: item.id, item })
    } else if (item.kind === 'notice') rows.push({ kind: 'notice', id: item.id, item })
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
    if (item.kind === 'todo_list') return item
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
