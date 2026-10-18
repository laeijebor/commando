import { stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ChatSessionInfo } from '../shared/agent-chat.js'
import {
  CHAT_CONVERSATION_ROUTES,
  chatConversationKey,
  isChatConversationSessionId,
  type ChatConversationPlacement,
  type ChatConversationProvider,
  type ChatConversation,
} from '../shared/chat-conversations.js'
import type { AgentStatus, CommandoSnapshot } from '../shared/protocol.js'
import { repositoryContainers } from '../shared/session-repositories.js'
import type { SessionAgentLaunch } from '../shared/tmux-create.js'
import { inheritedChatPermissionMode } from './agent-chats-api.js'
import type { ChatConversationIndex } from './chat-conversations.js'
import type { TmuxCreator } from './tmux-create.js'
import type { SessionBriefStore } from './session-briefs.js'
import type { SessionPreferenceStore } from './session-preferences.js'

const MAX_BODY_BYTES = 4 * 1024
/** How long a resumed conversation stays reserved after launch, until its new host registers. */
const REGISTER_GRACE_MS = 15_000

type Dependencies = {
  index: Pick<ChatConversationIndex, 'list' | 'find'>
  snapshot: () => CommandoSnapshot
  briefs: Pick<SessionBriefStore, 'conversationRecords'>
  sessionPreferences: Pick<SessionPreferenceStore, 'load'>
  /** The chat a pane runs, if it is a chat pane. */
  chatSession: (paneId: string) => ChatSessionInfo | undefined
  /** Chats on any pane, to keep two hosts off one conversation. */
  chatSessions: () => ChatSessionInfo[]
  /** Agent sessions reported by the daemon's status registry. */
  agentSessions: () => AgentStatus[]
  creator: Pick<TmuxCreator, 'createPane' | 'respawnChatPane'>
  beforePaneCreated: (paneId: string) => Promise<void>
  refreshSnapshot: () => Promise<unknown>
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message) }
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

async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  if (request.headers['content-type']?.split(';', 1)[0]?.trim() !== 'application/json') throw new HttpError(400, 'Content-Type must be application/json')
  const chunks: Buffer[] = []
  let length = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    length += buffer.length
    if (length > MAX_BODY_BYTES) throw new HttpError(413, 'Request body is too large')
    chunks.push(buffer)
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
  } catch {
    // Reported below.
  }
  throw new HttpError(400, 'Request body must be a JSON object')
}

/**
 * The chat's ⌘P picker: lists past conversations, and resumes one as a chat or TUI,
 * in the asking chat's pane or in a new pane beside it. A resumed chat gets
 * the asking chat's permission mode, never more.
 */
export class ChatConversationsApi {
  /** Panes switching now. */
  private readonly busy = new Set<string>()
  /** Conversations being resumed, or just resumed and not yet reported by their host. */
  private readonly reserved = new Set<string>()

  constructor(private readonly dependencies: Dependencies) {}

  async handle(request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean> {
    if (url.pathname !== CHAT_CONVERSATION_ROUTES.list && url.pathname !== CHAT_CONVERSATION_ROUTES.resume) return false
    try {
      if (url.pathname === CHAT_CONVERSATION_ROUTES.list) {
        if (request.method !== 'GET') throw new HttpError(405, 'Method not allowed')
        json(response, 200, { conversations: await this.list() })
        return true
      }
      if (request.method !== 'POST') throw new HttpError(405, 'Method not allowed')
      json(response, 200, await this.resume(await body(request)))
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500
      if (status === 405) response.setHeader('Allow', url.pathname === CHAT_CONVERSATION_ROUTES.list ? 'GET' : 'POST')
      json(response, status, { error: status === 500 ? 'Could not resume the conversation' : (error as Error).message })
      if (status === 500) console.warn('[commando] Chat conversation resume failed', error)
    }
    return true
  }

  private async list(): Promise<ChatConversation[]> {
    const snapshot = this.dependencies.snapshot()
    const [conversations, preferences] = await Promise.all([
      this.dependencies.index.list(),
      this.dependencies.sessionPreferences.load(snapshot.sessions),
    ])
    const records = new Map(this.dependencies.briefs.conversationRecords().map((record) => [`${record.provider}:${record.id}`, record]))
    const sessions = new Map(snapshot.sessions.map((session) => [session.id, session]))
    const groups = preferences.groupingMode === 'manual'
      ? preferences.groups : repositoryContainers(preferences, snapshot.sessions, snapshot.panes)
    return conversations.map((conversation) => {
      const brief = records.get(chatConversationKey(conversation.provider, conversation.sessionId))
      const session = brief ? sessions.get(brief.sessionId) : undefined
      const group = session && session.name === brief?.sessionName
        ? groups.find((group) => group.sessionIds.includes(session.id))?.name : undefined
      const profile = conversation.provider === 'claude' && conversation.configDir && resolve(conversation.configDir) !== join(homedir(), '.claude')
        ? basename(conversation.configDir).replace(/^\./, '') : undefined
      return {
        ...conversation,
        ...(profile ? { profile } : {}),
        ...(brief ? {
          session: { id: brief.sessionId, name: brief.sessionName, ...(group ? { group } : {}) },
          ...(brief.headline ? { headline: brief.headline } : {}),
          refs: brief.references.filter((reference) => reference.kind === 'url' || reference.kind === 'issue' || reference.kind === 'deployment')
            .map((reference) => ({ label: reference.label ?? reference.value, url: reference.url ?? reference.value })),
          paneOpen: brief.paneOpen,
        } : {}),
      }
    })
  }

  private async resume(input: Record<string, unknown>): Promise<{ paneId: string }> {
    const { paneId, provider, sessionId, placement } = input
    if (typeof paneId !== 'string' || !/^%\d+$/.test(paneId)) throw new HttpError(400, 'paneId must be a tmux pane id')
    if (provider !== 'claude' && provider !== 'codex' && provider !== 'cursor' && provider !== 'opencode') throw new HttpError(400, 'Unsupported conversation provider')
    if (!isChatConversationSessionId(sessionId)) throw new HttpError(400, 'Invalid conversation id')
    if (placement !== 'replace' && placement !== 'split') throw new HttpError(400, 'placement must be replace or split')
    const snapshot = this.dependencies.snapshot()
    const pane = snapshot.panes.find((entry) => entry.id === paneId)
    if (!pane) throw new HttpError(404, 'That pane no longer exists')
    const chat = this.dependencies.chatSession(paneId)
    if (!chat) throw new HttpError(409, 'Conversations can only be switched from a chat pane')
    const open = this.dependencies.chatSessions().find((session) => session.provider === provider && session.sessionId === sessionId)
      ?? this.dependencies.agentSessions().find((status) => status.source === 'hook' && status.provider === provider && status.agentSessionId === sessionId && snapshot.panes.some((pane) => pane.id === status.paneId))
    if (open) throw new HttpError(409, open.paneId === paneId ? 'This chat is already on that conversation' : `That conversation is already open in pane ${open.paneId}`)
    // Claimed before anything awaits, so two panes can't both resume one conversation.
    const key = `${provider}:${sessionId}`
    if (this.reserved.has(key)) throw new HttpError(409, 'That conversation is already being opened')
    if (this.busy.has(paneId)) throw new HttpError(409, 'This pane is already switching')
    this.reserved.add(key)
    this.busy.add(paneId)
    let launched = false
    try {
      // Only a conversation the daemon listed: its folder and profile come from the transcript, not the request.
      const conversation = await this.dependencies.index.find(provider as ChatConversationProvider, sessionId)
      if (!conversation) throw new HttpError(404, 'That conversation was not found')
      if (!(await stat(conversation.cwd).then((info) => info.isDirectory(), () => false))) throw new HttpError(409, `Its folder no longer exists: ${conversation.cwd}`)
      const agentProvider = provider === 'codex' ? 'codex-chat' : 'claude-chat'
      const launch: SessionAgentLaunch = provider === 'cursor' || provider === 'opencode' ? { provider, resume: sessionId } : {
        provider: agentProvider,
        permissionMode: inheritedChatPermissionMode(chat, agentProvider),
        resume: sessionId,
        ...(conversation.configDir ? { configDir: conversation.configDir } : {}),
      }
      return await this.launch(paneId, conversation.cwd, launch, placement, () => { launched = true })
    } catch (error) {
      if (error instanceof HttpError) throw error
      throw new HttpError(502, error instanceof Error ? error.message : String(error))
    } finally {
      this.busy.delete(paneId)
      // A launched chat's host reports the conversation shortly; until then it stays claimed.
      if (launched) setTimeout(() => this.reserved.delete(key), REGISTER_GRACE_MS).unref()
      else this.reserved.delete(key)
    }
  }

  /** `started` runs once tmux has started the chat, even if a later step fails. */
  private async launch(paneId: string, cwd: string, agent: SessionAgentLaunch, placement: ChatConversationPlacement, started: () => void): Promise<{ paneId: string }> {
    if (placement === 'replace') {
      await this.dependencies.creator.respawnChatPane(paneId, cwd, agent)
      started()
      await this.dependencies.refreshSnapshot()
      return { paneId }
    }
    await this.dependencies.beforePaneCreated(paneId)
    const created = await this.dependencies.creator.createPane({ targetId: paneId, direction: 'horizontal', placement: 'after', cwd, agent })
    started()
    await this.dependencies.refreshSnapshot()
    if (!created.paneId) throw new HttpError(502, 'tmux did not report the new pane')
    return { paneId: created.paneId }
  }
}
