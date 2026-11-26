import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  isChatProvider,
  isModelValue,
  isPaneId,
  providerName,
  type ChatItem,
  type ChatProvider,
  type ChatSessionInfo,
} from '../shared/agent-chat.js'
import {
  buildHandoffBrief,
  handoffPermissionMode,
  supportsHandoffPermissionMode,
} from '../shared/chat-handoff.js'
import {
  chatLaunchPermission,
  chatLaunchProvider,
  type ChatPermissionMode,
  type SessionAgentLaunch,
} from '../shared/tmux-create.js'
import type { ChatPlanStore } from './chat-plans.js'
import type { TmuxCreator } from './tmux-create.js'

const HANDOFF_ROUTE = /^\/api\/chat\/([^/]+)\/handoff$/
const MAX_BODY_BYTES = 16 * 1024
const MAX_NOTE_CHARS = 4_000
const CONTROL_CHARACTER = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u

/** Matches the daemon's pane opening-prompt byte budget (see agent-chats-api.ts). */
export const MAX_PANE_PROMPT_BYTES = 7_800

type Dependencies = {
  /** The chat session running in `paneId`, if any. */
  chatSession: (paneId: string) => ChatSessionInfo | undefined
  /** Timeline items currently held for `paneId`. */
  chatItems: (paneId: string) => readonly ChatItem[]
  /** Respawns the pane with the target provider in the same worktree. */
  creator: Pick<TmuxCreator, 'respawnChatPane'>
  /** Stashes handoff briefs that exceed the pane prompt byte limit. */
  plans: Pick<ChatPlanStore, 'stash'>
  /** Preserves prior items + a divider notice in the hub for the incoming provider. */
  prepareHandoff?: (paneId: string, fromProvider: ChatProvider, toProvider: ChatProvider) => unknown
  /** Broadcasts the divider notice immediately once respawn succeeds (before the new host connects). */
  announceHandoff?: (paneId: string) => void
  /** Discards a prepared timeline carry-over if respawning fails. */
  cancelHandoff?: (paneId: string) => void
  /** Refreshes the tmux snapshot after respawning the pane. */
  refreshSnapshot?: () => Promise<unknown>
  /** Override for tests exercising the stashed-brief branch. */
  maxPanePromptBytes?: number
}

export interface ChatHandoffResponse {
  ok: true
  paneId: string
  fromProvider: ChatProvider
  toProvider: ChatProvider
  permissionMode: ChatPermissionMode
  model?: string
  stashed: boolean
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
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

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  if (request.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
    throw new HttpError(400, 'Content-Type must be application/json')
  }
  const chunks: Buffer[] = []
  let length = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    length += buffer.length
    if (length > MAX_BODY_BYTES) throw new HttpError(413, 'Request body is too large')
    chunks.push(buffer)
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>
  } catch {
    // Reported below.
  }
  throw new HttpError(400, 'Request body must be a JSON object')
}

function parseHandoffBody(value: Record<string, unknown>): { targetProvider: ChatProvider; model?: string; note?: string } {
  const { targetProvider, model, note } = value
  if (!isChatProvider(targetProvider)) throw new HttpError(400, 'Unsupported targetProvider')
  if (model !== undefined && (typeof model !== 'string' || !isModelValue(model))) {
    throw new HttpError(400, 'Invalid model id')
  }
  if (note !== undefined && (typeof note !== 'string' || note.length > MAX_NOTE_CHARS || CONTROL_CHARACTER.test(note))) {
    throw new HttpError(400, `note must be at most ${MAX_NOTE_CHARS} characters without unsupported control characters`)
  }
  const trimmedNote = note?.trim()
  return {
    targetProvider,
    ...(model && model !== 'default' ? { model } : {}),
    ...(trimmedNote ? { note: trimmedNote } : {}),
  }
}

/**
 * Owner-authenticated `POST /api/chat/:paneId/handoff`: distills the current
 * chat into a bounded brief, maps permissions safely without escalation,
 * preserves the timeline with a divider notice, and respawns the pane with
 * the target provider in the exact same working directory.
 */
export class ChatHandoffApi {
  private readonly busy = new Set<string>()

  constructor(private readonly dependencies: Dependencies) {}

  async handle(request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean> {
    const match = HANDOFF_ROUTE.exec(url.pathname)
    if (!match) return false
    try {
      if (request.method !== 'POST') {
        response.setHeader('Allow', 'POST')
        throw new HttpError(405, 'Method not allowed')
      }
      let paneId: string
      try {
        paneId = decodeURIComponent(match[1]!)
      } catch {
        throw new HttpError(400, 'Invalid tmux pane id')
      }
      if (!isPaneId(paneId)) throw new HttpError(400, 'Invalid tmux pane id')
      const input = parseHandoffBody(await readJsonBody(request))
      json(response, 200, await this.handoff(paneId, input))
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500
      json(response, status, { error: status === 500 ? 'Could not hand off the chat' : (error as Error).message })
      if (status === 500) console.warn('[commando] Chat handoff failed', error)
    }
    return true
  }

  private async handoff(
    paneId: string,
    input: { targetProvider: ChatProvider; model?: string; note?: string },
  ): Promise<ChatHandoffResponse> {
    const session = this.dependencies.chatSession(paneId)
    if (!session) throw new HttpError(404, `No active chat session in pane ${paneId}`)
    if (input.targetProvider === session.provider) {
      throw new HttpError(400, `Chat is already using ${providerName(input.targetProvider)}`)
    }
    if (session.status === 'running' || session.status === 'starting' || session.status === 'waiting') {
      throw new HttpError(409, 'Wait for the current turn to finish before handing off')
    }
    if (this.busy.has(paneId)) {
      throw new HttpError(409, 'This pane is already handing off')
    }
    const targetLaunch = chatLaunchProvider(input.targetProvider)
    const permissionMode = handoffPermissionMode(session, targetLaunch)
    if (!supportsHandoffPermissionMode(targetLaunch, permissionMode)) {
      throw new HttpError(403, `${providerName(input.targetProvider)} has no permission mode as restricted as this chat`)
    }

    this.busy.add(paneId)
    let prepared = false
    try {
      const items = this.dependencies.chatItems(paneId)
      const brief = buildHandoffBrief({
        fromProvider: session.provider,
        toProvider: input.targetProvider,
        cwd: session.cwd,
        ...(session.title ? { title: session.title } : {}),
        items,
        ...(input.note ? { note: input.note } : {}),
      })

      const maxBytes = this.dependencies.maxPanePromptBytes ?? MAX_PANE_PROMPT_BYTES
      let prompt = brief
      let readableDir: string | undefined
      let stashed = false
      if (Buffer.byteLength(brief, 'utf8') > maxBytes) {
        const file = await this.dependencies.plans.stash(brief)
        prompt = `Read the full handoff brief at ${JSON.stringify(file.path)} and continue this conversation seamlessly.`
        if (input.targetProvider === 'claude' || input.targetProvider === 'cursor') {
          readableDir = file.dir
        }
        stashed = true
      }

      const launch: SessionAgentLaunch = {
        provider: targetLaunch,
        ...chatLaunchPermission(targetLaunch, permissionMode),
        ...(input.model ? { model: input.model } : {}),
        prompt,
        ...(readableDir ? { readableDir } : {}),
      }

      this.dependencies.prepareHandoff?.(paneId, session.provider, input.targetProvider)
      prepared = true
      await this.dependencies.creator.respawnChatPane(paneId, session.cwd, launch)
      this.dependencies.announceHandoff?.(paneId)
      await this.dependencies.refreshSnapshot?.()

      return {
        ok: true,
        paneId,
        fromProvider: session.provider,
        toProvider: input.targetProvider,
        permissionMode,
        ...(input.model ? { model: input.model } : {}),
        stashed,
      }
    } catch (error) {
      if (prepared) this.dependencies.cancelHandoff?.(paneId)
      if (error instanceof HttpError) throw error
      throw new HttpError(502, error instanceof Error ? error.message : String(error))
    } finally {
      this.busy.delete(paneId)
    }
  }
}
