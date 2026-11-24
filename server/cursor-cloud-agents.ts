import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ChatSessionInfo } from '../shared/agent-chat.js'
import { CURSOR_CLOUD_AGENTS_ROUTE, type CursorCloudAgentsResponse } from '../shared/cursor-cloud-agents.js'
import type { CommandoSnapshot } from '../shared/protocol.js'
import { isCursorAuthError } from './agent-host/cursor/session.js'
import { defaultGitProcessExecutor, type GitProcessExecutor } from './git-diff.js'
import { normaliseGithubUrl } from './git-cursor-cloud.js'
import type { SessionCreations } from './session-creations.js'

type AgentInfo = {
  agentId: string; name: string; summary?: string; lastModified: number; createdAt?: number
  repos?: string[]; metadata?: Record<string, string>; archived?: boolean
}
/** Small injectable surface: neither daemon startup nor tests load the SDK. */
export type CursorCloudAgentsSdk = {
  list: (options: { runtime: 'cloud'; limit: number }) => Promise<{ items: AgentInfo[]; nextCursor?: string }>
  get: (id: string) => Promise<AgentInfo>
  listRuns: (id: string, options: { runtime: 'cloud'; limit: number }) => Promise<{ items: {
    status: 'running' | 'finished' | 'error' | 'cancelled'
    git?: { branches: { branch?: string; prUrl?: string }[] }
  }[] }>
}
type Dependencies = {
  chatSessions: () => ChatSessionInfo[]
  snapshot: () => Pick<CommandoSnapshot, 'panes'>
  creations: Pick<SessionCreations, 'start'>
  sdk?: () => Promise<CursorCloudAgentsSdk>
  execute?: GitProcessExecutor
  now?: () => number
}
class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message) }
}
function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  response.end(JSON.stringify(value))
}

export class CursorCloudAgentsApi {
  private cache?: { at: number; value: CursorCloudAgentsResponse }
  private flight?: Promise<CursorCloudAgentsResponse>
  private lastFetch = -Infinity
  private readonly opening = new Map<string, Promise<{ paneId: string }>>()
  // Bridge the short gap before a new chat host registers its session ID.
  private readonly opened = new Map<string, { paneId: string; until: number; seen?: boolean }>()
  private readonly now: () => number
  private readonly sdk: () => Promise<CursorCloudAgentsSdk>
  constructor(private readonly dependencies: Dependencies) {
    this.now = dependencies.now ?? Date.now
    this.sdk = dependencies.sdk ?? (async () => (await import('@cursor/sdk')).Agent)
  }

  async handle(request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean> {
    const route = CURSOR_CLOUD_AGENTS_ROUTE
    if (url.pathname !== route && !url.pathname.startsWith(`${route}/`)) return false
    try {
      if (url.pathname === route) {
        if (request.method !== 'GET') throw new HttpError(405, 'Method not allowed')
        json(response, 200, await this.list(url.searchParams.get('refresh') === '1'))
      } else {
        const match = new RegExp(`^${route}/([^/]+)/open$`).exec(url.pathname)
        if (!match) throw new HttpError(404, 'Not found')
        if (request.method !== 'POST') throw new HttpError(405, 'Method not allowed')
        json(response, 200, await this.open(match[1]))
      }
    } catch (error) {
      // SDK errors may contain request credentials. Only return our own messages.
      json(response, error instanceof HttpError ? error.status : isCursorAuthError(error) ? 401 : 502,
        { error: error instanceof HttpError ? error.message : isCursorAuthError(error)
          ? 'Log in to Cursor from a Cursor chat to open your cloud agents.' : 'Unable to open the Cursor cloud agent.' })
    }
    return true
  }

  list(refresh = false): Promise<CursorCloudAgentsResponse> {
    if (this.flight) return this.flight
    const age = this.cache ? this.now() - this.cache.at : Infinity
    if (this.cache && ((!refresh && age < 20_000) || (refresh && this.now() - this.lastFetch < 5_000))) return Promise.resolve(this.cache.value)
    this.lastFetch = this.now()
    this.flight = this.load().then((value) => {
      this.cache = { at: this.now(), value }
      return value
    }).finally(() => { this.flight = undefined })
    return this.flight
  }

  private async load(): Promise<CursorCloudAgentsResponse> {
    try {
      const sdk = await this.sdk()
      const page = await sdk.list({ runtime: 'cloud', limit: 50 })
      const agents: CursorCloudAgentsResponse['agents'] = page.items.filter((agent) => agent.archived !== true).sort((a, b) => b.lastModified - a.lastModified).map((agent) => ({
        agentId: agent.agentId, name: agent.name, summary: agent.summary, repoUrl: agent.repos?.[0],
        createdAt: agent.createdAt, lastModified: agent.lastModified,
        webUrl: `https://cursor.com/agents/${agent.agentId}`,
        startedInCommando: agent.metadata?.commando !== undefined,
        openPaneId: this.openPane(agent.agentId),
      }))
      let index = 0
      let failed = false
      let authError: unknown
      await Promise.all(Array.from({ length: Math.min(4, agents.length) }, async () => {
        while (index < Math.min(15, agents.length)) {
          const agent = agents[index++]
          try {
            const run = (await sdk.listRuns(agent.agentId, { runtime: 'cloud', limit: 1 })).items[0]
            if (run) Object.assign(agent, { status: run.status, branch: run.git?.branches[0]?.branch, prUrl: run.git?.branches[0]?.prUrl })
          } catch (error) {
            if (isCursorAuthError(error)) authError = error
            failed = true
          }
        }
      }))
      if (authError) throw authError
      return { login: 'ok', agents, more: page.nextCursor !== undefined, ...(failed ? { error: 'Some Cursor cloud agent statuses could not be loaded.' } : {}) }
    } catch (error) {
      return isCursorAuthError(error) ? { login: 'required', agents: [], more: false }
        : { login: 'ok', agents: [], more: false, error: 'Unable to load Cursor cloud agents. Refresh to retry.' }
    }
  }

  private openPane(id: string): string | undefined {
    const live = this.dependencies.chatSessions().find((session) => session.sessionId === id)?.paneId
    if (live) return live
    const recent = this.opened.get(id)
    if (!recent) return undefined
    // A new pane can take a moment to reach the snapshot; once it has been seen there, its absence means it closed.
    const present = this.dependencies.snapshot().panes.some((pane) => pane.id === recent.paneId && !pane.dead)
    if (present) recent.seen = true
    if (recent.until <= this.now() || (recent.seen && !present)) { this.opened.delete(id); return undefined }
    return recent.paneId
  }

  async open(id: string): Promise<{ paneId: string }> {
    if (!/^bc-[A-Za-z0-9-]{8,80}$/.test(id)) throw new HttpError(400, 'Invalid Cursor cloud agent id')
    const paneId = this.openPane(id)
    if (paneId) return { paneId }
    const pending = this.opening.get(id)
    if (pending) return pending
    const flight = this.create(id).finally(() => { this.opening.delete(id) })
    this.opening.set(id, flight)
    return flight
  }

  private async git(cwd: string, args: string[]): Promise<string> {
    return (await (this.dependencies.execute ?? defaultGitProcessExecutor)('git', args, {
      cwd, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      maxBuffer: 1024 * 1024, shell: false, timeout: 5_000, windowsHide: true,
    })).stdout.trim()
  }

  private async checkout(repoUrl: string): Promise<string | undefined> {
    const panes = this.dependencies.snapshot().panes.filter((pane) => !pane.dead)
    const paths = new Set(panes.map((pane) => pane.repo?.worktreeRoot ?? pane.repo?.root ?? pane.path))
    const roots = new Set<string>()
    for (const path of paths) {
      const root = await this.git(path, ['rev-parse', '--show-toplevel']).catch(() => '')
      if (!root || roots.has(root)) continue
      roots.add(root)
      const remotes = (await this.git(root, ['remote']).catch(() => '')).split('\n').filter(Boolean)
      for (const remote of remotes) {
        const url = await this.git(root, ['remote', 'get-url', remote]).catch(() => '')
        if (normaliseGithubUrl(url)?.toLowerCase() === repoUrl.toLowerCase()) return root
      }
    }
    return undefined
  }

  private async create(id: string): Promise<{ paneId: string }> {
    const agent = await (await this.sdk()).get(id)
    const repoUrl = agent.repos?.[0] ? normaliseGithubUrl(agent.repos[0]) : undefined
    if (!repoUrl) throw new HttpError(409, 'This Cursor cloud agent has no supported GitHub repository.')
    const cwd = await this.checkout(repoUrl)
    if (!cwd) throw new HttpError(409, `No local checkout of ${repoUrl.slice('https://github.com/'.length)} is open in Commando. Open a session in that repo, then try again.`)
    const creation = await this.dependencies.creations.start({ name: agent.name, autoName: true, cwd,
      agent: { provider: 'cursor-chat', resume: id, permissionMode: 'bypassPermissions', cursorCloud: { repoUrl } } })
    const paneId = creation.result?.created.paneId
    if (!paneId) throw new HttpError(502, 'Session creation did not report the new pane.')
    this.opened.set(id, { paneId, until: this.now() + 15_000 })
    if (this.cache) this.cache.value = { ...this.cache.value,
      agents: this.cache.value.agents.map((entry) => entry.agentId === id ? { ...entry, openPaneId: paneId } : entry) }
    return { paneId }
  }
}
