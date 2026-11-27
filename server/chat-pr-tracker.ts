import { isAbsolute, resolve } from 'node:path'
import type { ChatItem } from '../shared/agent-chat.js'
import type { PanePrRef } from './pane-pr-records.js'
import { parsePrImpactReports, type PrImpactReport } from './pane-pr-impacts.js'
import { createdPullRequestsFor, pullRequestImpactsFor } from './pr-impact-hook.js'

const MAX_SEEN_IDS = 2_000

export type ChatPullRequestEvents = {
  created: PanePrRef[]
  impacted: PrImpactReport[]
}

/** Seeds a seen-item set from a snapshot or replaced timeline so history replays never re-fire. */
export function seedSeenPullRequestItems(items: readonly ChatItem[], seen: Set<string>): void {
  for (const item of items) {
    if (item.status === 'completed' && (item.kind === 'command' || item.kind === 'tool')) {
      rememberSeenId(seen, item.id)
    }
  }
}

/**
 * Extracts newly created or impacted PRs from completed chat command/MCP items.
 * Skips running, failed, interrupted, and already-processed items.
 */
export function extractChatItemPullRequests(
  items: readonly ChatItem[],
  cwd: string | undefined,
  seen: Set<string>,
): ChatPullRequestEvents {
  const created: PanePrRef[] = []
  const impacted: PrImpactReport[] = []

  for (const item of items) {
    if (item.kind !== 'command' && item.kind !== 'tool') continue
    if (item.status !== 'completed' || item.isError) continue
    if (seen.has(item.id)) continue
    rememberSeenId(seen, item.id)

    const effectiveCwd = item.kind === 'command' ? resolveCommandCwd(item.cwd, cwd) : cwd
    const payload = itemToHookPayload(item, effectiveCwd)
    if (!payload) continue

    const createdRefs = createdPullRequestsFor(payload)
    if (createdRefs) {
      for (const ref of createdRefs) {
        if (!created.some((existing) => existing.repo === ref.repo && existing.number === ref.number)) {
          created.push(ref)
        }
      }
    }

    const rawImpacts = pullRequestImpactsFor(payload)
    if (rawImpacts) {
      for (const report of parsePrImpactReports(rawImpacts, effectiveCwd)) {
        const key = JSON.stringify(report)
        if (!impacted.some((existing) => JSON.stringify(existing) === key)) {
          impacted.push(report)
        }
      }
    }
  }

  return { created, impacted }
}

function rememberSeenId(seen: Set<string>, id: string): void {
  seen.add(id)
  if (seen.size > MAX_SEEN_IDS) {
    const oldest = seen.values().next().value
    if (oldest !== undefined) seen.delete(oldest)
  }
}

function resolveCommandCwd(itemCwd: string | undefined, sessionCwd: string | undefined): string | undefined {
  const trimmed = itemCwd?.trim()
  if (!trimmed) return sessionCwd
  if (isAbsolute(trimmed)) return trimmed
  return sessionCwd ? resolve(sessionCwd, trimmed) : trimmed
}

function itemToHookPayload(
  item: Extract<ChatItem, { kind: 'command' | 'tool' }>,
  cwd: string | undefined,
): Record<string, unknown> | null {
  if (item.kind === 'command') {
    return {
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { command: item.command },
      tool_response: item.output,
      ...(cwd ? { cwd } : {}),
    }
  }

  const toolName = resolveMcpToolName(item.toolName, item.title)
  if (!toolName) return null
  return {
    hook_event_name: 'PostToolUse',
    tool_name: toolName,
    tool_input: parseToolDetail(item.detail),
    tool_response: item.output,
    ...(cwd ? { cwd } : {}),
  }
}

function resolveMcpToolName(toolName: string, title: string): string | null {
  if (/^mcp__.+__[a-z_]+$/i.test(toolName) || /^MCP:(?:[^:]+:)?[a-z_]+$/i.test(toolName)) {
    return toolName
  }
  if (toolName !== 'mcp') return null
  // CursorItemMapper formats MCP titles as `<provider> · <tool>` or `MCP · <tool>`.
  const parts = title.split('·').map((part) => part.trim()).filter(Boolean)
  if (parts.length < 2) return null
  const provider = parts[0]
  const tool = parts[parts.length - 1]
  if (!/^[a-z_][a-z0-9_]*$/i.test(tool)) return null
  return `MCP:${provider}:${tool}`
}

function parseToolDetail(detail: string | undefined): Record<string, unknown> {
  if (!detail) return {}
  try {
    const parsed = JSON.parse(detail) as unknown
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    const record = parsed as Record<string, unknown>
    if (typeof record.args === 'object' && record.args !== null && !Array.isArray(record.args)) {
      return record.args as Record<string, unknown>
    }
    return record
  } catch {
    return {}
  }
}
