/**
 * Past agent conversations the daemon found on disk, for the chat's
 * ⌘P picker: switch a chat pane to one, or resume one in a new pane.
 */

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
  /** The pane currently hosting this conversation, verified by the server. */
  openPaneId?: string
  branch?: string
  /** Claude only: the config dir (`~/.claudep`) whose login it belongs to. */
  configDir?: string
  /** Main checkout of the repo `cwd` is in, shared by all its worktrees. */
  repoRoot?: string
  /** The checkout (main or worktree) `cwd` is in. */
  checkoutRoot?: string
  session?: { id: string; name: string; group?: string }
  headline?: string
  refs?: { label: string; url?: string }[]
  paneOpen?: boolean
  /** When its pane closed (or a newer chat replaced it there); only for closed panes. */
  closedAt?: number
  profile?: string
}

/** `replace` switches the chat pane to the conversation; `split` resumes it in a new pane beside it. */
export type ChatConversationPlacement = 'replace' | 'split' | 'session'

export interface ResumeChatConversationRequest {
  paneId?: string
  provider: ChatConversationProvider
  sessionId: string
  placement: ChatConversationPlacement
}

export interface ResumeChatConversationResponse {
  /** The pane now running the conversation. */
  paneId: string
}

/** OpenCode uses `ses_` ids; all accepted ids remain plain shell words. */
const SESSION_ID = /^(?:[A-Za-z0-9-]{8,80}|ses_[A-Za-z0-9]{4,76})$/

export function isChatConversationSessionId(value: unknown): value is string {
  return typeof value === 'string' && SESSION_ID.test(value)
}

export function chatConversationKey(provider: ChatConversationProvider, sessionId: string): string {
  return `${provider}:${sessionId}`
}

/** Case-insensitive match of every query word across conversation and session metadata. */
export function matchesChatConversation(conversation: ChatConversation, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  const haystack = [conversation.session?.name, conversation.session?.group, conversation.headline,
    conversation.title, ...(conversation.refs ?? []).map((ref) => ref.label), conversation.branch,
    conversation.cwd, conversation.provider, conversation.profile].filter(Boolean).join(' ').toLowerCase()
  return words.every((word) => haystack.includes(word))
}

export type ChatConversationGroup = { id: string; label: string; conversations: ChatConversation[] }

/** The current session first, other sessions by recency, then conversations outside Commando. */
export function groupChatConversations(
  conversations: readonly ChatConversation[],
  session: { id: string; name: string },
  query = '',
): ChatConversationGroup[] {
  const groups = new Map<string, ChatConversationGroup>()
  const currentId = `session:${session.name}`
  for (const conversation of [...conversations].sort((a, b) => b.updatedAt - a.updatedAt)) {
    if (!matchesChatConversation(conversation, query)) continue
    // tmux reuses numeric ids after a restart; only an open pane can vouch for one.
    const isCurrent = conversation.session && (conversation.session.name === session.name
      || (conversation.paneOpen && conversation.session.id === session.id))
    const id = isCurrent ? currentId : conversation.session ? `session:${conversation.session.name}` : 'outside'
    let group = groups.get(id)
    if (!group) {
      const label = isCurrent ? `This session · ${session.name}` : conversation.session
        ? [conversation.session.name, conversation.session.group].filter(Boolean).join(' · ') : 'Outside Commando'
      group = { id, label, conversations: [] }
      groups.set(id, group)
    }
    group.conversations.push(conversation)
  }
  return [...groups.values()].sort((a, b) => {
    const rank = (id: string) => id === currentId ? 0 : id === 'outside' ? 2 : 1
    return rank(a.id) - rank(b.id) || b.conversations[0]!.updatedAt - a.conversations[0]!.updatedAt
  })
}

export function chatConversationProviderLabel(conversation: ChatConversation): string {
  return conversation.provider === 'claude' && conversation.profile ? conversation.profile
    : { claude: 'Claude', codex: 'Codex', cursor: 'Cursor', opencode: 'OpenCode' }[conversation.provider]
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
    const headline = optionalString(entry.headline, 500)
    const profile = optionalString(entry.profile, 500)
    const session = isRecord(entry.session) && optionalString(entry.session.id, 128) && optionalString(entry.session.name, 128)
      ? { id: entry.session.id as string, name: entry.session.name as string,
          ...(optionalString(entry.session.group, 128) ? { group: entry.session.group as string } : {}) } : undefined
    const refs = Array.isArray(entry.refs) ? entry.refs.slice(0, 20).flatMap((ref) => {
      if (!isRecord(ref) || !optionalString(ref.label)) return []
      const url = optionalString(ref.url)
      return [{ label: ref.label as string, ...(url ? { url } : {}) }]
    }) : undefined
    const openPaneId = optionalString(entry.openPaneId, 100)
    return [{
      provider: entry.provider,
      sessionId: entry.sessionId,
      cwd,
      title,
      updatedAt: entry.updatedAt,
      ...(openPaneId && /^%\d+$/.test(openPaneId) ? { openPaneId } : {}),
      ...(branch ? { branch } : {}),
      ...(session ? { session } : {}),
      ...(headline ? { headline } : {}),
      ...(profile ? { profile } : {}),
      ...(refs ? { refs } : {}),
      ...(typeof entry.paneOpen === 'boolean' ? { paneOpen: entry.paneOpen } : {}),
      ...(typeof entry.closedAt === 'number' && Number.isFinite(entry.closedAt) ? { closedAt: entry.closedAt } : {}),
      ...(configDir ? { configDir } : {}),
      ...(repoRoot ? { repoRoot } : {}),
      ...(checkoutRoot ? { checkoutRoot } : {}),
    }]
  })
}
