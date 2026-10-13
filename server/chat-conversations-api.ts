import { stat } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ChatSessionInfo } from '../shared/agent-chat.js'
import {
  CHAT_CONVERSATION_ROUTES,
  isChatConversationSessionId,
  type ChatConversationPlacement,
  type ChatConversationProvider,
} from '../shared/chat-conversations.js'
import type { CommandoSnapshot } from '../shared/protocol.js'
import type { SessionAgentLaunch } from '../shared/tmux-create.js'
import { inheritedChatPermissionMode } from './agent-chats-api.js'
import type { ChatConversationIndex } from './chat-conversations.js'
import type { TmuxCreator } from './tmux-create.js'

const MAX_BODY_BYTES = 4 * 1024
/** How long a resumed conversation stays reserved after launch, until its new host registers. */
const REGISTER_GRACE_MS = 15_000

type Dependencies = {
  index: Pick<ChatConversationIndex, 'list' | 'find'>
  snapshot: () => CommandoSnapshot
  /** The chat a pane runs, if it is a chat pane. */
  chatSession: (paneId: string) => ChatSessionInfo | undefined
  /** Chats on any pane, to keep two hosts off one conversation. */
  chatSessions: () => ChatSessionInfo[]
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
 * The chat's ⌘P picker: lists past conversations, and resumes one as a chat,
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
        json(response, 200, { conversations: await this.dependencies.index.list() })
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

  private async resume(input: Record<string, unknown>): Promise<{ paneId: string }> {
    const { paneId, provider, sessionId, placement } = input
    if (typeof paneId !== 'string' || !/^%\d+$/.test(paneId)) throw new HttpError(400, 'paneId must be a tmux pane id')
    if (provider !== 'claude' && provider !== 'codex') throw new HttpError(400, 'provider must be claude or codex')
    if (!isChatConversationSessionId(sessionId)) throw new HttpError(400, 'Invalid conversation id')
    if (placement !== 'replace' && placement !== 'split') throw new HttpError(400, 'placement must be replace or split')
    const pane = this.dependencies.snapshot().panes.find((entry) => entry.id === paneId)
    if (!pane) throw new HttpError(404, 'That pane no longer exists')
    const chat = this.dependencies.chatSession(paneId)
    if (!chat) throw new HttpError(409, 'Conversations can only be switched from a chat pane')
    const open = this.dependencies.chatSessions().find((session) => session.provider === provider && session.sessionId === sessionId)
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
      const launch: SessionAgentLaunch = {
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
