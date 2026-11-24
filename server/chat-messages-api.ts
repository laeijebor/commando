import type { IncomingMessage, ServerResponse } from 'node:http'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { stripAttachmentNotes, type ChatState } from '../shared/agent-chat.js'
import { chatConversationKey, isChatConversationProvider } from '../shared/chat-conversations.js'
import {
  canSearchSentMessages,
  CHAT_MESSAGE_SEARCH_ROUTE,
  DEFAULT_CHAT_MESSAGE_SEARCH_LIMIT,
  isDaemonInjectedMessage,
  matchesSentMessageQuery,
  MAX_CHAT_MESSAGE_SEARCH_LIMIT,
  normalizeMessageSearchText,
  sentMessageProviderLabel,
  type SentMessageMatch,
  type SentMessageSearchResponse,
} from '../shared/chat-messages.js'
import type { AgentStatus, CommandoSnapshot, TmuxPane, TmuxSession } from '../shared/protocol.js'
import type { ChatMessageIndex, IndexedSentMessage } from './chat-message-index.js'
import type { ConversationBriefRecord, SessionBriefStore } from './session-briefs.js'

const INITIAL_SYNC_WAIT_MS = 250

type Dependencies = {
  index: Pick<ChatMessageIndex, 'search' | 'triggerSync' | 'isSyncing' | 'hasSynced'>
  snapshot: () => CommandoSnapshot
  briefs: Pick<SessionBriefStore, 'conversationRecords'>
  chats: () => ChatState[]
  agentSessions: () => AgentStatus[]
  home?: string
  initialSyncWaitMs?: number
}

function json(response: ServerResponse, status: number, value: unknown): void {
  const body = `${JSON.stringify(value)}\n`
  response.writeHead(status, {
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
    'Content-Type': 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
  })
  response.end(body)
}

function claudeProfile(provider: string, configDir: string | undefined, defaultClaudeDir: string): string | undefined {
  if (provider !== 'claude' || !configDir) return undefined
  return resolve(configDir) !== defaultClaudeDir ? basename(configDir).replace(/^\./, '') : undefined
}

function parseLimit(raw: string | null): number {
  if (!raw || !/^\d+$/.test(raw)) return DEFAULT_CHAT_MESSAGE_SEARCH_LIMIT
  return Math.max(1, Math.min(MAX_CHAT_MESSAGE_SEARCH_LIMIT, Number(raw)))
}

async function waitUpTo(promise: Promise<void>, ms: number): Promise<void> {
  if (ms <= 0) return
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      promise,
      new Promise<void>((resolveTimer) => {
        timer = setTimeout(resolveTimer, ms)
        timer.unref()
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * Daemon API for searching all user-sent messages across live chat panes and
 * indexed on-disk agent transcripts, enriched with Commando session & chat metadata.
 */
export class ChatMessagesApi {
  private readonly defaultClaudeDir: string
  private readonly initialSyncWaitMs: number

  constructor(private readonly dependencies: Dependencies) {
    this.defaultClaudeDir = resolve(join(dependencies.home ?? homedir(), '.claude'))
    this.initialSyncWaitMs = dependencies.initialSyncWaitMs ?? INITIAL_SYNC_WAIT_MS
  }

  async handle(request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean> {
    if (url.pathname !== CHAT_MESSAGE_SEARCH_ROUTE) return false
    if (request.method !== 'GET') {
      response.setHeader('Allow', 'GET')
      json(response, 405, { error: 'Method not allowed' })
      return true
    }
    try {
      const query = url.searchParams.get('q') ?? ''
      const limit = parseLimit(url.searchParams.get('limit'))
      json(response, 200, await this.search(query, limit))
    } catch (error) {
      console.warn('[commando] Chat message search failed', error)
      json(response, 500, { error: 'Could not search sent messages' })
    }
    return true
  }

  async search(query: string, limit = DEFAULT_CHAT_MESSAGE_SEARCH_LIMIT): Promise<SentMessageSearchResponse> {
    if (!canSearchSentMessages(query)) return { messages: [] }

    const syncPromise = this.dependencies.index.triggerSync()
    if (!this.dependencies.index.hasSynced()) {
      await waitUpTo(syncPromise, this.initialSyncWaitMs)
    }

    const snapshot = this.dependencies.snapshot()
    const liveChats = this.dependencies.chats()
    const sessionsById = new Map<string, TmuxSession>(snapshot.sessions.map((session) => [session.id, session]))
    const panesById = new Map<string, TmuxPane>(snapshot.panes.map((pane) => [pane.id, pane]))
    const briefsByKey = new Map<string, ConversationBriefRecord>(
      this.dependencies.briefs.conversationRecords().flatMap((record) =>
        isChatConversationProvider(record.provider) ? [[chatConversationKey(record.provider, record.id), record] as const] : [],
      ),
    )
    const openPanes = this.openConversationPanes(snapshot, liveChats)
    const liveChatsByKey = new Map<string, ChatState>()
    for (const chat of liveChats) {
      if (chat.session.sessionId) {
        liveChatsByKey.set(chatConversationKey(chat.session.provider, chat.session.sessionId), chat)
      }
    }

    const merged: SentMessageMatch[] = []
    const liveByConversationText = new Map<string, SentMessageMatch>()

    for (const chat of liveChats) {
      const pane = panesById.get(chat.paneId)
      const session = pane ? sessionsById.get(pane.sessionId) : undefined
      const convKey = chat.session.sessionId ? chatConversationKey(chat.session.provider, chat.session.sessionId) : undefined
      const brief = convKey ? briefsByKey.get(convKey) : undefined
      const profile = claudeProfile(chat.session.provider, chat.session.configDir, this.defaultClaudeDir)
      const providerLabel = sentMessageProviderLabel(chat.session.provider, profile)
      const sessionName = session?.name ?? brief?.sessionName
      const commandoSessionId = session?.id ?? brief?.sessionId
      const chatTitle = chat.session.title ?? brief?.title ?? brief?.headline ?? pane?.title
      const branch = pane?.repo?.branch

      for (const item of chat.items) {
        if (item.kind !== 'user_message') continue
        const cleaned = stripAttachmentNotes(item.text).trim()
        if (!cleaned || isDaemonInjectedMessage(cleaned) || !matchesSentMessageQuery(cleaned, query)) continue
        const match: SentMessageMatch = {
          id: `live:${chat.paneId}:${item.id}`,
          text: cleaned,
          sentAt: item.createdAt,
          provider: chat.session.provider,
          ...(chat.session.sessionId ? { sessionId: chat.session.sessionId } : {}),
          openPaneId: chat.paneId,
          itemId: item.id,
          ...(sessionName ? { sessionName } : {}),
          ...(commandoSessionId ? { commandoSessionId } : {}),
          ...(chatTitle ? { chatTitle } : {}),
          providerLabel,
          ...(chat.session.cwd ? { cwd: chat.session.cwd } : {}),
          ...(branch ? { branch } : {}),
          ...(profile ? { profile } : {}),
          paneOpen: true,
        }
        merged.push(match)
        if (convKey) {
          const dedupeKey = `${convKey}\0${normalizeMessageSearchText(cleaned)}`
          if (!liveByConversationText.has(dedupeKey)) liveByConversationText.set(dedupeKey, match)
        }
      }
    }

    const diskHits = this.dependencies.index.search(query, Math.min(MAX_CHAT_MESSAGE_SEARCH_LIMIT * 2, limit * 2))
    const seenDisk = new Set<string>()
    for (const hit of diskHits) {
      const convKey = chatConversationKey(hit.provider, hit.sessionId)
      const normText = normalizeMessageSearchText(hit.text)
      const liveMatch = liveByConversationText.get(`${convKey}\0${normText}`)
      if (liveMatch) {
        // Replayed live items often receive the resume time as createdAt; keep the transcript's true send time.
        if (hit.sentAt > 0 && (liveMatch.sentAt <= 0 || hit.sentAt < liveMatch.sentAt)) {
          liveMatch.sentAt = hit.sentAt
        }
        if (!liveMatch.branch && hit.branch) liveMatch.branch = hit.branch
        if (!liveMatch.chatTitle && hit.title) liveMatch.chatTitle = hit.title
        continue
      }

      const diskDedupeKey = `${convKey}\0${normText}\0${Math.floor(hit.sentAt / 5_000)}`
      if (seenDisk.has(diskDedupeKey)) continue
      seenDisk.add(diskDedupeKey)

      merged.push(this.enrichIndexedHit(hit, convKey, openPanes, panesById, sessionsById, briefsByKey, liveChatsByKey))
    }

    merged.sort((a, b) => b.sentAt - a.sentAt)
    return {
      messages: merged.slice(0, limit),
      ...(this.dependencies.index.isSyncing() ? { indexing: true } : {}),
    }
  }

  private enrichIndexedHit(
    hit: IndexedSentMessage,
    convKey: string,
    openPanes: ReadonlyMap<string, string>,
    panesById: ReadonlyMap<string, TmuxPane>,
    sessionsById: ReadonlyMap<string, TmuxSession>,
    briefsByKey: ReadonlyMap<string, ConversationBriefRecord>,
    liveChatsByKey: ReadonlyMap<string, ChatState>,
  ): SentMessageMatch {
    const openPaneId = openPanes.get(convKey)
    const pane = openPaneId ? panesById.get(openPaneId) : undefined
    const liveSession = pane ? sessionsById.get(pane.sessionId) : undefined
    const brief = briefsByKey.get(convKey)
    const liveChat = liveChatsByKey.get(convKey)
    const sessionName = liveSession?.name ?? brief?.sessionName
    const commandoSessionId = liveSession?.id ?? brief?.sessionId
    const chatTitle = liveChat?.session.title ?? brief?.title ?? brief?.headline ?? hit.title
    const configDir = liveChat?.session.configDir ?? hit.configDir
    const profile = claudeProfile(hit.provider, configDir, this.defaultClaudeDir)
    const providerLabel = sentMessageProviderLabel(hit.provider, profile)
    const branch = pane?.repo?.branch ?? hit.branch
    const cwd = liveChat?.session.cwd ?? pane?.path ?? hit.cwd
    const paneOpen = openPaneId ? true : brief?.paneOpen

    return {
      id: `idx:${hit.id}:${convKey}:${hit.messageId}`,
      text: hit.text,
      sentAt: hit.sentAt,
      provider: hit.provider,
      sessionId: hit.sessionId,
      ...(openPaneId ? { openPaneId } : {}),
      ...(sessionName ? { sessionName } : {}),
      ...(commandoSessionId ? { commandoSessionId } : {}),
      ...(chatTitle ? { chatTitle } : {}),
      providerLabel,
      ...(cwd ? { cwd } : {}),
      ...(branch ? { branch } : {}),
      ...(profile ? { profile } : {}),
      ...(typeof paneOpen === 'boolean' ? { paneOpen } : {}),
    }
  }

  private openConversationPanes(snapshot: CommandoSnapshot, liveChats: readonly ChatState[]): Map<string, string> {
    const open = new Map<string, string>()
    for (const chat of liveChats) {
      if (!chat.session.sessionId) continue
      const key = chatConversationKey(chat.session.provider, chat.session.sessionId)
      if (!open.has(key)) open.set(key, chat.paneId)
    }
    for (const status of this.dependencies.agentSessions()) {
      if (status.source !== 'hook' || status.provider === 'unknown' || !status.agentSessionId) continue
      if (!snapshot.panes.some((pane) => pane.id === status.paneId && !pane.dead)) continue
      const key = chatConversationKey(status.provider, status.agentSessionId)
      if (!open.has(key)) open.set(key, status.paneId)
    }
    return open
  }
}
