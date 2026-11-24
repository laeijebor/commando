/**
 * Cross-provider chat handoff: distills a conversation into a bounded Markdown
 * brief, maps permission modes safely without privilege escalation, and formats
 * or detects handoff divider notices in the timeline.
 */

import {
  providerName,
  stripAttachmentNotes,
  type ChatItem,
  type ChatModelOption,
  type ChatProvider,
  type ChatSessionInfo,
} from './agent-chat.js'
import { latestTodos, shortPath } from './chat-timeline.js'
import {
  chatLaunchProvider,
  chatPermissionModes,
  modelCatalogFor,
  type ChatLaunchProvider,
  type ChatPermissionMode,
  type ModelCatalogs,
} from './tmux-create.js'

/** Hard upper bound on a generated handoff brief's character length. */
export const MAX_HANDOFF_BRIEF_CHARS = 6_000

/** Opening phrase of every generated handoff brief; used to avoid nesting briefs on multi-hop handoffs. */
export const HANDOFF_BRIEF_PREFIX = 'You are taking over this conversation from '
const STASHED_HANDOFF_PREFIX = 'Read the full handoff brief at '

/** Prefix of handoff divider notices rendered in the timeline. */
export const HANDOFF_MARKER_PREFIX = 'Handed off from '

/** Display order for providers in the handoff menu. */
export const HANDOFF_PROVIDERS: readonly ChatProvider[] = ['claude', 'cursor', 'codex', 'muse', 'deepseek']

const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu
const MAX_RECENT_USER_REQUESTS = 6
const MAX_REQUEST_CHARS = 280
const MAX_PLAN_CHARS = 1_400
const MAX_ASSISTANT_CHARS = 1_500
const MAX_NOTE_CHARS = 1_000
const MAX_MODIFIED_FILES = 35
const MAX_OPEN_TODOS = 20

const HANDOFF_CLOSING = 'Inspect the current worktree (git status, recent diffs, and relevant files) before making assumptions, then continue seamlessly.'

export interface HandoffBriefInput {
  fromProvider: ChatProvider
  toProvider: ChatProvider
  cwd: string
  title?: string
  items: readonly ChatItem[]
  note?: string
}

// ---- timeline divider helpers ----

export function handoffDividerText(fromProvider: ChatProvider, toProvider: ChatProvider): string {
  return `${HANDOFF_MARKER_PREFIX}${providerName(fromProvider)} to ${providerName(toProvider)}`
}

export function isHandoffNotice(text: string): boolean {
  return text.startsWith(HANDOFF_MARKER_PREFIX)
}

export function parseHandoffNotice(text: string): { fromLabel: string; toLabel: string } | null {
  if (!isHandoffNotice(text)) return null
  const body = text.slice(HANDOFF_MARKER_PREFIX.length)
  const match = /^(.+?)\s+(?:to|→)\s+(.+)$/u.exec(body)
  if (!match) return null
  const fromLabel = match[1]!.trim()
  const toLabel = match[2]!.trim()
  return fromLabel && toLabel ? { fromLabel, toLabel } : null
}

export function handoffDividerLabel(text: string): string {
  const parsed = parseHandoffNotice(text)
  return parsed ? `${HANDOFF_MARKER_PREFIX}${parsed.fromLabel} → ${parsed.toLabel}` : text
}

// ---- permission mapping (never escalates privilege) ----

export const PERMISSION_RANK: Record<ChatPermissionMode, number> = {
  plan: 0,
  default: 1,
  auto: 1,
  acceptEdits: 2,
  bypassPermissions: 3,
}

/**
 * What a chat in `mode` needs its caller to allow. Compare each provider's modes by their access,
 * rather than their shared mode names. Codex's default (workspace access) edits and runs commands
 * without asking, like Claude's acceptEdits; so does Muse's, inside its sandbox. Muse's
 * approve-everything skips every prompt, so only a bypass caller may open one.
 */
export function effectivePermissionRank(provider: string, mode: ChatPermissionMode): number {
  if (provider === 'cursor-chat') {
    const ranks: Partial<Record<ChatPermissionMode, number>> = {
      bypassPermissions: PERMISSION_RANK.bypassPermissions,
      auto: PERMISSION_RANK.bypassPermissions,
      default: PERMISSION_RANK.acceptEdits,
      plan: PERMISSION_RANK.plan,
    }
    return ranks[mode] ?? PERMISSION_RANK[mode]
  }
  if (provider === 'muse-chat' && mode === 'acceptEdits') return PERMISSION_RANK.bypassPermissions
  return (provider === 'codex-chat' || provider === 'muse-chat') && mode === 'default'
    ? PERMISSION_RANK.acceptEdits
    : PERMISSION_RANK[mode]
}

/** Claude auto and unrecognized modes retain their existing asking-first fallback. */
export function launchPermissionModeFor(chat: Pick<ChatSessionInfo, 'provider' | 'permissionMode'> | undefined): ChatPermissionMode {
  if (chat?.permissionMode === 'auto' && chat.provider !== 'cursor') return 'default'
  return chat?.permissionMode && Object.hasOwn(PERMISSION_RANK, chat.permissionMode)
    ? chat.permissionMode as ChatPermissionMode
    : 'default'
}

/**
 * What a caller in `mode` may hand on. Muse's approve-everything keeps its sandbox, so it
 * grants no more than acceptEdits; Muse's full access (--yolo) is a real bypass.
 */
export function grantPermissionRank(provider: string, mode: ChatPermissionMode): number {
  return provider === 'muse-chat' && mode === 'acceptEdits'
    ? PERMISSION_RANK.acceptEdits
    : effectivePermissionRank(provider, mode)
}

export function chatPermissionRank(chat: Pick<ChatSessionInfo, 'provider' | 'permissionMode' | 'sandboxed'>): number {
  const mode = launchPermissionModeFor(chat)
  // Earlier Muse hosts ran bypassPermissions inside the sandbox. Only a host that says its
  // sandbox is off grants full access; any other Muse bypass grants what its sandbox allows.
  if (chat.provider === 'muse' && mode === 'bypassPermissions' && chat.sandboxed !== false) {
    return grantPermissionRank('muse-chat', 'acceptEdits')
  }
  return grantPermissionRank(chatLaunchProvider(chat.provider), mode)
}

/** The most permissive mode `provider` supports that does not exceed what `rank` allows, if any does. */
export function inheritedPermissionMode(provider: ChatLaunchProvider, rank: number): ChatPermissionMode | undefined {
  return [...chatPermissionModes(provider)].map((mode) => mode.value)
    .filter((mode) => effectivePermissionRank(provider, mode) <= rank)
    // On a tie, the more permissive mode: a bypass caller gets Muse's full access, not its sandboxed one.
    .sort((left, right) => effectivePermissionRank(provider, right) - effectivePermissionRank(provider, left) || PERMISSION_RANK[right] - PERMISSION_RANK[left])[0]
}

/**
 * Maps the current session's permission mode to the safest equivalent on `target`
 * without escalating privilege. Falls back to `'plan'` when `target` has no mode
 * as restricted as `current` (callers should check `supportsHandoffPermissionMode`).
 */
export function handoffPermissionMode(
  current: Pick<ChatSessionInfo, 'provider' | 'permissionMode' | 'sandboxed'>,
  target: ChatLaunchProvider,
): ChatPermissionMode {
  return inheritedPermissionMode(target, chatPermissionRank(current)) ?? 'plan'
}

export function supportsHandoffPermissionMode(target: ChatLaunchProvider, mode: ChatPermissionMode): boolean {
  return chatPermissionModes(target).some((entry) => entry.value === mode)
}

// ---- brief builder ----

function sanitize(text: string): string {
  return text.replace(/\r\n?/gu, '\n').replace(CONTROL_CHARS, ' ').trim()
}

function collapseLine(text: string): string {
  return sanitize(text).replace(/\s+/gu, ' ')
}

function truncate(text: string, maxChars: number): string {
  if (maxChars <= 0) return ''
  if (text.length <= maxChars) return text
  if (maxChars === 1) return '…'
  return `${text.slice(0, maxChars - 1).trimEnd()}…`
}

function isSyntheticHandoffPrompt(text: string): boolean {
  return text.startsWith(HANDOFF_BRIEF_PREFIX) || text.startsWith(STASHED_HANDOFF_PREFIX)
}

function extractRecentUserRequests(items: readonly ChatItem[]): string[] {
  const requests: string[] = []
  for (const item of items) {
    if (item.parentToolUseId || item.kind !== 'user_message') continue
    const cleaned = collapseLine(stripAttachmentNotes(item.text))
    if (!cleaned || isSyntheticHandoffPrompt(cleaned)) continue
    requests.push(truncate(cleaned, MAX_REQUEST_CHARS))
  }
  return requests.slice(-MAX_RECENT_USER_REQUESTS)
}

function extractLatestPlan(items: readonly ChatItem[]): string | null {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]!
    if (item.parentToolUseId || item.kind !== 'plan') continue
    const text = sanitize(item.text)
    if (text) return truncate(text, MAX_PLAN_CHARS)
  }
  return null
}

function extractLatestAssistantSummary(items: readonly ChatItem[]): string | null {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]!
    if (item.parentToolUseId || item.kind !== 'assistant_message') continue
    const text = sanitize(item.text)
    if (text) return truncate(text, MAX_ASSISTANT_CHARS)
  }
  return null
}

function extractModifiedFiles(items: readonly ChatItem[], cwd: string): string[] {
  const seen = new Set<string>()
  const files: string[] = []
  for (const item of items) {
    if (item.kind !== 'file_change' || item.isError) continue
    const normalized = collapseLine(shortPath(item.path, cwd))
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    files.push(normalized)
  }
  return files
}

function extractOpenTodos(items: readonly ChatItem[]): string[] {
  const list = latestTodos(items)
  if (!list) return []
  return list.todos
    .filter((todo) => todo.status !== 'completed')
    .slice(0, MAX_OPEN_TODOS)
    .map((todo) => {
      const marker = todo.status === 'in_progress' ? '[in progress]' : '[ ]'
      return `- ${marker} ${truncate(collapseLine(todo.content), 200)}`
    })
}

function formatFilesSection(files: readonly string[]): string | null {
  if (!files.length) return null
  const shown = files.slice(0, MAX_MODIFIED_FILES).map((path) => `- \`${path}\``)
  const omitted = files.length - shown.length
  if (omitted > 0) shown.push(`- …and ${omitted} more`)
  return `## Files modified\n${shown.join('\n')}`
}

/**
 * Distills a chat's items into a structured, bounded Markdown handoff prompt
 * (`<= MAX_HANDOFF_BRIEF_CHARS` characters).
 */
export function buildHandoffBrief(input: HandoffBriefInput): string {
  const fromName = providerName(input.fromProvider)
  const cwd = collapseLine(input.cwd) || '.'
  const title = input.title ? truncate(collapseLine(input.title), 140) : ''
  const headerLines = [
    `${HANDOFF_BRIEF_PREFIX}${fromName} in ${cwd}.`,
    ...(title ? [`Conversation: ${title}`] : []),
  ]
  const header = truncate(headerLines.join('\n'), 600)

  const note = input.note ? truncate(sanitize(input.note), MAX_NOTE_CHARS) : ''
  const requests = extractRecentUserRequests(input.items)
  const plan = extractLatestPlan(input.items)
  const assistant = extractLatestAssistantSummary(input.items)
  const files = formatFilesSection(extractModifiedFiles(input.items, input.cwd))
  const todos = extractOpenTodos(input.items)

  const sections: string[] = [
    ...(note ? [`## Handoff note\n${note}`] : []),
    ...(requests.length ? [`## Recent user requests\n${requests.map((entry) => `- ${entry}`).join('\n')}`] : []),
    ...(plan ? [`## Latest plan\n${plan}`] : []),
    ...(assistant ? [`## Latest assistant summary\n${assistant}`] : []),
    ...(files ? [files] : []),
    ...(todos.length ? [`## Open todos\n${todos.join('\n')}`] : []),
  ]

  return assembleBoundedBrief(header, sections, HANDOFF_CLOSING, MAX_HANDOFF_BRIEF_CHARS)
}

function assembleBoundedBrief(header: string, sections: readonly string[], closing: string, limit: number): string {
  const full = [header, ...sections, closing].join('\n\n')
  if (full.length <= limit) return full

  const fixedOverhead = header.length + closing.length + 4 // `\n\n` before and after middle
  let remaining = Math.max(0, limit - fixedOverhead)
  const fitted: string[] = []
  for (const section of sections) {
    const separator = fitted.length > 0 ? 2 : 0
    if (remaining <= separator + 24) break
    const allowance = remaining - separator
    if (section.length <= allowance) {
      fitted.push(section)
      remaining -= section.length + separator
    } else {
      fitted.push(truncate(section, allowance))
      remaining = 0
      break
    }
  }
  const assembled = fitted.length ? [header, ...fitted, closing].join('\n\n') : `${header}\n\n${closing}`
  return assembled.length <= limit ? assembled : truncate(assembled, limit)
}

// ---- model catalog helper for UI ----

/**
 * Resolves the best available model list for every provider: live models from
 * active chats take precedence, falling back to the daemon's cached model catalog.
 */
export function availableProviderModels(
  catalogs: ModelCatalogs | null,
  sessions: readonly Pick<ChatSessionInfo, 'provider' | 'models'>[] = [],
): Partial<Record<ChatProvider, ChatModelOption[]>> {
  const result: Partial<Record<ChatProvider, ChatModelOption[]>> = {}
  for (const provider of HANDOFF_PROVIDERS) {
    const live = sessions.find((session) => session.provider === provider && session.models?.length)?.models
    if (live?.length) {
      result[provider] = live
      continue
    }
    const cached = modelCatalogFor(catalogs, chatLaunchProvider(provider), undefined)?.models
    if (cached?.length) result[provider] = cached
  }
  return result
}
