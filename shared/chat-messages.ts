/**
 * Search across user-sent messages for the global ⌘K command palette.
 */

import { isChatProvider, providerName, stripAttachmentNotes, type ChatState } from './agent-chat.js'
import { isChatConversationProvider, isChatConversationSessionId, type ChatConversationProvider } from './chat-conversations.js'

export const CHAT_MESSAGE_SEARCH_ROUTE = '/api/chat-messages/search'
export const MIN_CHAT_MESSAGE_SEARCH_LENGTH = 3
export const DEFAULT_CHAT_MESSAGE_SEARCH_LIMIT = 50
export const MAX_CHAT_MESSAGE_SEARCH_LIMIT = 100

export interface SentMessageMatch {
  id: string
  /** User-sent message text (cleaned of attachment notes). */
  text: string
  /** Epoch ms when the message was sent. */
  sentAt: number
  provider: ChatConversationProvider
  /** Agent conversation id, when known. */
  sessionId?: string
  /** Live tmux pane currently hosting this conversation, when open. */
  openPaneId?: string
  /** Live chat item id, when matched against an open chat pane. */
  itemId?: string
  /** Commando session name (e.g. "payments-fix"), when known. */
  sessionName?: string
  /** Commando tmux session id (e.g. "$3"), when known. */
  commandoSessionId?: string
  /** Chat title (agent title, headline, custom title, or first prompt). */
  chatTitle?: string
  /** Human-readable provider or Claude profile label. */
  providerLabel: string
  cwd?: string
  branch?: string
  profile?: string
  paneOpen?: boolean
}

export interface SentMessageSearchResponse {
  messages: SentMessageMatch[]
  indexing?: boolean
}

export function canSearchSentMessages(query: string): boolean {
  return query.trim().length >= MIN_CHAT_MESSAGE_SEARCH_LENGTH
}

export function sentMessageProviderLabel(provider: ChatConversationProvider, profile?: string): string {
  return provider === 'claude' && profile ? profile
    : isChatProvider(provider) ? providerName(provider) : 'OpenCode'
}

export function normalizeMessageSearchText(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** Case-insensitive match requiring every whitespace-separated term to appear in `text`. */
export function matchesSentMessageQuery(text: string, query: string): boolean {
  const trimmed = query.trim()
  if (trimmed.length < MIN_CHAT_MESSAGE_SEARCH_LENGTH) return false
  const haystack = text.toLowerCase()
  const terms = trimmed.toLowerCase().split(/\s+/).filter(Boolean)
  return terms.length > 0 && terms.every((term) => haystack.includes(term))
}

export interface MessageSnippetSegment {
  text: string
  match: boolean
}

/**
 * Collapses whitespace and windows long messages around the first matching query term,
 * returning highlight segments for rendering.
 */
export function buildSentMessageSnippet(text: string, query: string, maxLength = 160): MessageSnippetSegment[] {
  const singleLine = normalizeMessageSearchText(text)
  if (!singleLine) return []
  const terms = [...new Set(query.trim().toLowerCase().split(/\s+/).filter(Boolean))]
    .sort((a, b) => b.length - a.length)

  const lower = singleLine.toLowerCase()
  let firstHit = -1
  for (const term of terms) {
    const idx = lower.indexOf(term)
    if (idx >= 0 && (firstHit < 0 || idx < firstHit)) firstHit = idx
  }

  let excerpt = singleLine
  if (singleLine.length > maxLength) {
    const anchor = firstHit >= 0 ? firstHit : 0
    const lead = Math.floor(maxLength * 0.35)
    let start = Math.max(0, anchor - lead)
    let end = start + maxLength
    if (end > singleLine.length) {
      end = singleLine.length
      start = Math.max(0, end - maxLength)
    }
    const prefix = start > 0 ? '…' : ''
    const suffix = end < singleLine.length ? '…' : ''
    excerpt = `${prefix}${singleLine.slice(start, end).trim()}${suffix}`
  }

  if (!terms.length) return [{ text: excerpt, match: false }]

  const escaped = terms.map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  const pattern = new RegExp(`(${escaped.join('|')})`, 'gi')
  const segments: MessageSnippetSegment[] = []
  let lastIndex = 0
  for (const hit of excerpt.matchAll(pattern)) {
    const index = hit.index ?? 0
    if (index > lastIndex) segments.push({ text: excerpt.slice(lastIndex, index), match: false })
    if (hit[0]) segments.push({ text: hit[0], match: true })
    lastIndex = index + hit[0].length
  }
  if (lastIndex < excerpt.length) segments.push({ text: excerpt.slice(lastIndex), match: false })
  return segments.length ? segments : [{ text: excerpt, match: false }]
}

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS

function sameCalendarDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}

/** Human-readable send time: "just now", "12m ago", "14:23", "Yesterday 09:15", or "Nov 20, 14:23". */
export function formatSentMessageTime(sentAt: number, now = Date.now()): string {
  if (!Number.isFinite(sentAt) || sentAt <= 0) return ''
  const elapsed = now - sentAt
  if (elapsed >= 0 && elapsed < MINUTE_MS) return 'just now'
  if (elapsed >= 0 && elapsed < HOUR_MS) return `${Math.floor(elapsed / MINUTE_MS)}m ago`
  const date = new Date(sentAt)
  const current = new Date(now)
  const clock = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  if (sameCalendarDay(date, current)) return clock
  const yesterday = new Date(current)
  yesterday.setDate(current.getDate() - 1)
  if (sameCalendarDay(date, yesterday)) return `Yesterday ${clock}`
  const sameYear = date.getFullYear() === current.getFullYear()
  const day = date.toLocaleDateString([], sameYear
    ? { month: 'short', day: 'numeric' }
    : { month: 'short', day: 'numeric', year: 'numeric' })
  return sameYear ? `${day}, ${clock}` : day
}

/** Instant client-side search across currently open chat panes while daemon results load. */
export function searchLiveChatMessages(
  chats: Readonly<Record<string, ChatState>>,
  query: string,
  lookup: (paneId: string) => { sessionName?: string; commandoSessionId?: string; branch?: string; paneTitle?: string },
  limit = DEFAULT_CHAT_MESSAGE_SEARCH_LIMIT,
): SentMessageMatch[] {
  if (!canSearchSentMessages(query)) return []
  const matches: SentMessageMatch[] = []
  for (const [paneId, chat] of Object.entries(chats)) {
    const info = lookup(paneId)
    const provider = chat.session.provider
    const profile = provider === 'claude' && chat.session.configDir
      ? claudeProfileName(chat.session.configDir)
      : undefined
    const providerLabel = sentMessageProviderLabel(provider, profile)
    const chatTitle = chat.session.title || info.paneTitle
    for (const item of chat.items) {
      if (item.kind !== 'user_message') continue
      const cleaned = stripAttachmentNotes(item.text).trim()
      if (!cleaned || !matchesSentMessageQuery(cleaned, query)) continue
      matches.push({
        id: `live:${paneId}:${item.id}`,
        text: cleaned,
        sentAt: item.createdAt,
        provider,
        ...(chat.session.sessionId ? { sessionId: chat.session.sessionId } : {}),
        openPaneId: paneId,
        itemId: item.id,
        ...(info.sessionName ? { sessionName: info.sessionName } : {}),
        ...(info.commandoSessionId ? { commandoSessionId: info.commandoSessionId } : {}),
        ...(chatTitle ? { chatTitle } : {}),
        providerLabel,
        ...(chat.session.cwd ? { cwd: chat.session.cwd } : {}),
        ...(info.branch ? { branch: info.branch } : {}),
        ...(profile ? { profile } : {}),
        paneOpen: true,
      })
    }
  }
  return matches.sort((a, b) => b.sentAt - a.sentAt).slice(0, limit)
}

function claudeProfileName(configDir: string): string | undefined {
  const normalized = configDir.replace(/\/+$/, '')
  const base = normalized.slice(normalized.lastIndexOf('/') + 1)
  if (!base || base === '.claude') return undefined
  return base.replace(/^\./, '')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function optionalString(value: unknown, max = 4096): string | undefined {
  return typeof value === 'string' && value.length <= max ? value : undefined
}

export function parseSentMessageSearchResponse(value: unknown): SentMessageSearchResponse {
  if (!isRecord(value) || !Array.isArray(value.messages)) return { messages: [] }
  const messages = value.messages.flatMap((entry): SentMessageMatch[] => {
    if (!isRecord(entry)) return []
    const id = optionalString(entry.id, 512)
    const text = optionalString(entry.text, 20_000)
    const providerLabel = optionalString(entry.providerLabel, 128)
    if (!id || !text || !providerLabel || !isChatConversationProvider(entry.provider)) return []
    if (typeof entry.sentAt !== 'number' || !Number.isFinite(entry.sentAt)) return []
    const sessionId = isChatConversationSessionId(entry.sessionId) ? entry.sessionId : undefined
    const openPaneId = optionalString(entry.openPaneId, 100)
    const itemId = optionalString(entry.itemId, 256)
    const sessionName = optionalString(entry.sessionName, 256)
    const commandoSessionId = optionalString(entry.commandoSessionId, 128)
    const chatTitle = optionalString(entry.chatTitle, 500)
    const cwd = optionalString(entry.cwd)
    const branch = optionalString(entry.branch, 500)
    const profile = optionalString(entry.profile, 256)
    return [{
      id,
      text,
      sentAt: entry.sentAt,
      provider: entry.provider,
      ...(sessionId ? { sessionId } : {}),
      ...(openPaneId ? { openPaneId } : {}),
      ...(itemId ? { itemId } : {}),
      ...(sessionName ? { sessionName } : {}),
      ...(commandoSessionId ? { commandoSessionId } : {}),
      ...(chatTitle ? { chatTitle } : {}),
      providerLabel,
      ...(cwd ? { cwd } : {}),
      ...(branch ? { branch } : {}),
      ...(profile ? { profile } : {}),
      ...(typeof entry.paneOpen === 'boolean' ? { paneOpen: entry.paneOpen } : {}),
    }]
  })
  return {
    messages,
    ...(typeof value.indexing === 'boolean' ? { indexing: value.indexing } : {}),
  }
}
