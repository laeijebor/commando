import { createHash, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'

import { readJson, writeJson } from './device-lock-api.js'

const API_PATH = '/api/agent-sessions/archive'
const PANE_ID = /^%\d+$/

const digest = (value: string) => createHash('sha256').update(value).digest()

export type AgentSessionArchiveDependencies = {
  token: string
  /** The session a pane belongs to, or null when the pane is gone. */
  paneSession: (paneId: string) => { id: string; name: string } | null
  sessions: () => ReadonlyArray<{ id: string; name: string }>
  /** Archives as Commando's own Archive does: uncommitted work is committed and the worktree removed, both restorable. */
  archive: (sessionId: string) => Promise<{ archive: { id: string; name: string; worktree?: unknown }; worktreeKept?: string }>
}

/**
 * Lets an agent (the disk-cleanup skill) archive another session rather than kill it, authorised by the
 * agent hook token. The caller names the session by id and exact name, so a renumbered tmux id can't
 * archive the wrong one, and can't archive its own session.
 */
export class AgentSessionArchiveApi {
  private readonly tokenDigest: Buffer

  constructor(private readonly dependencies: AgentSessionArchiveDependencies) {
    if (dependencies.token.length < 32) throw new Error('Agent hook token must contain at least 32 characters')
    this.tokenDigest = digest(dependencies.token)
  }

  async handle(request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean> {
    if (url.pathname !== API_PATH) return false
    try {
      const candidate = /^Bearer\s+(\S+)$/i.exec(request.headers.authorization ?? '')?.[1]
      if (!candidate || candidate.length > 1_024 || !timingSafeEqual(digest(candidate), this.tokenDigest)) {
        response.setHeader('WWW-Authenticate', 'Bearer realm="commando-agent-hooks"')
        return fail(response, 401, 'Unauthorized')
      }
      if (request.method !== 'POST') return fail(response, 405, 'Method not allowed')
      const paneId = request.headers['x-commando-pane']
      if (typeof paneId !== 'string' || !PANE_ID.test(paneId)) return fail(response, 400, 'X-Commando-Pane must be a tmux pane id')
      const caller = this.dependencies.paneSession(paneId)
      if (!caller) return fail(response, 404, 'Caller pane no longer exists')
      const body = await readJson(request)
      if (typeof body.sessionId !== 'string' || typeof body.sessionName !== 'string') return fail(response, 400, 'Expected sessionId and sessionName')
      const session = this.dependencies.sessions().find((entry) => entry.id === body.sessionId)
      if (!session || session.name !== body.sessionName) return fail(response, 404, `Session "${body.sessionName}" no longer exists`)
      if (session.id === caller.id) return fail(response, 409, 'A session cannot archive itself')
      writeJson(response, 200, { ok: true, ...await this.dependencies.archive(session.id) })
    } catch (error) {
      const status = typeof (error as { status?: unknown }).status === 'number' ? (error as { status: number }).status : 500
      fail(response, status, error instanceof Error ? error.message : 'Archiving failed')
    }
    return true
  }
}

function fail(response: ServerResponse, status: number, error: string): true {
  if (!response.headersSent) writeJson(response, status, { error })
  return true
}
