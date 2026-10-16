/**
 * Past agent conversations the daemon found on disk, for the chat's
 * ⌘P picker: switch a chat pane to one, or resume one in a new pane.
 */

import type { PaneRepo } from './protocol.js'

export const CHAT_CONVERSATION_ROUTES = {
  list: '/api/chat-conversations',
  resume: '/api/chat-conversations/resume',
} as const

export type ChatConversationProvider = 'claude' | 'codex' | 'cursor' | 'opencode'

export interface ChatConversation {
  provider: ChatConversationProvider
  sessionId: string
  /** The folder it ran in; a resume runs there too. */
  cwd: string
  title: string
  /** When its transcript last changed, ms. */
  updatedAt: number
  branch?: string
  /** Claude only: the config dir (`~/.claudep`) whose login it belongs to. */
  configDir?: string
  /** Main checkout of the repo `cwd` is in, shared by all its worktrees. */
  repoRoot?: string
  /** The checkout (main or worktree) `cwd` is in. */
  checkoutRoot?: string
}

/** `replace` switches the chat pane to the conversation; `split` resumes it in a new pane beside it. */
export type ChatConversationPlacement = 'replace' | 'split'

export interface ResumeChatConversationRequest {
  paneId: string
  provider: ChatConversationProvider
  sessionId: string
  placement: ChatConversationPlacement
}

export interface ResumeChatConversationResponse {
  /** The pane now running the conversation. */
  paneId: string
}

export type ChatConversationScope = 'worktree' | 'repo' | 'other'

export const CHAT_CONVERSATION_SCOPE_LABELS: Record<ChatConversationScope, string> = {
  worktree: 'This worktree',
  repo: 'This repo',
  other: 'Everything else',
}

/** OpenCode uses `ses_` ids; all accepted ids remain plain shell words. */
const SESSION_ID = /^(?:[A-Za-z0-9-]{8,80}|ses_[A-Za-z0-9]{4,76})$/

export function isChatConversationSessionId(value: unknown): value is string {
  return typeof value === 'string' && SESSION_ID.test(value)
}

export function chatConversationKey(provider: ChatConversationProvider, sessionId: string): string {
  return `${provider}:${sessionId}`
}

function within(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith('/') ? root : `${root}/`)
}

/**
 * Where a conversation sits relative to a pane: its checkout, another checkout of
 * its repo, or elsewhere. Outside a repo only the pane's own folder counts as "this".
 */
export function chatConversationScope(conversation: ChatConversation, pane: { path: string; repo?: PaneRepo }): ChatConversationScope {
  if (!pane.repo) return conversation.cwd === pane.path ? 'worktree' : 'other'
  const checkout = pane.repo.worktreeRoot ?? pane.repo.root
  // A known checkout decides: a worktree nested inside the main checkout is still its own.
  if (conversation.checkoutRoot ? conversation.checkoutRoot === checkout : within(conversation.cwd, checkout)) return 'worktree'
  return conversation.repoRoot === pane.repo.root ? 'repo' : 'other'
}

/** Case-insensitive match of every word in the query against the title, folder and branch. */
export function matchesChatConversation(conversation: ChatConversation, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return true
  const haystack = `${conversation.title} ${conversation.cwd} ${conversation.branch ?? ''} ${conversation.provider}`.toLowerCase()
  return words.every((word) => haystack.includes(word))
}

/** The picker's groups in order (this worktree, this repo, everything else), newest first, empty ones left out. */
export function groupChatConversations(
  conversations: readonly ChatConversation[],
  pane: { path: string; repo?: PaneRepo },
  query = '',
): { scope: ChatConversationScope; conversations: ChatConversation[] }[] {
  const groups: Record<ChatConversationScope, ChatConversation[]> = { worktree: [], repo: [], other: [] }
  for (const conversation of conversations) {
    if (matchesChatConversation(conversation, query)) groups[chatConversationScope(conversation, pane)].push(conversation)
  }
  return (['worktree', 'repo', 'other'] as const)
    .map((scope) => ({ scope, conversations: groups[scope].sort((a, b) => b.updatedAt - a.updatedAt) }))
    .filter((group) => group.conversations.length)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function optionalString(value: unknown, max = 4096): string | undefined {
  return typeof value === 'string' && value.length <= max ? value : undefined
}

/** Keeps the well-formed entries of a list response. */
export function parseChatConversations(value: unknown): ChatConversation[] {
  const list = isRecord(value) && Array.isArray(value.conversations) ? value.conversations : []
  return list.flatMap((entry): ChatConversation[] => {
    if (!isRecord(entry)) return []
    if ((entry.provider !== 'claude' && entry.provider !== 'codex' && entry.provider !== 'cursor' && entry.provider !== 'opencode') || !isChatConversationSessionId(entry.sessionId)) return []
    const cwd = optionalString(entry.cwd)
    const title = optionalString(entry.title, 500)
    if (!cwd || title === undefined || typeof entry.updatedAt !== 'number' || !Number.isFinite(entry.updatedAt)) return []
    const branch = optionalString(entry.branch, 500)
    const configDir = optionalString(entry.configDir)
    const repoRoot = optionalString(entry.repoRoot)
    const checkoutRoot = optionalString(entry.checkoutRoot)
    return [{
      provider: entry.provider,
      sessionId: entry.sessionId,
      cwd,
      title,
      updatedAt: entry.updatedAt,
      ...(branch ? { branch } : {}),
      ...(configDir ? { configDir } : {}),
      ...(repoRoot ? { repoRoot } : {}),
      ...(checkoutRoot ? { checkoutRoot } : {}),
    }]
  })
}
