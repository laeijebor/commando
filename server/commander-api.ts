import { createHash, timingSafeEqual } from 'node:crypto'
import { open } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import { stripVTControlCharacters } from 'node:util'
import type { ChatItem, ChatSessionInfo } from '../shared/agent-chat.js'
import { NUDGE_TAG, RELAY_MAX_CHARS, RELAY_TAG, type CommanderAgent, type TurnBrief } from '../shared/commander.js'
import type { AgentStatus, CommandoSnapshot, SessionBrief, TmuxPane } from '../shared/protocol.js'
import type { ClaudeProfile } from '../shared/tmux-create.js'
import { TokenBucketRateLimiter } from './client-messages.js'
import type { Commander } from './commander.js'
import type { CommanderRelays } from './commander-relays.js'
import type { CommanderStalls } from './commander-stalls.js'
import { claudeTranscriptFileItems, codexRolloutItems, tailJsonLines } from './commander-transcript.js'
import { record, textContent } from './external-agents/progress.js'

const ROOT = '/api/commander'
const AGENT = `${ROOT}/agent`
class HttpError extends Error { constructor(readonly status: number, message: string) { super(message) } }
const digest = (value: string) => createHash('sha256').update(value).digest()
const controls = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u
function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
  response.end(JSON.stringify(value))
}
async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  if (!/^application\/json\b/i.test(request.headers['content-type'] ?? '')) throw new HttpError(415, 'Expected application/json')
  let bytes = 0
  const chunks: Buffer[] = []
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytes += buffer.length
    if (bytes > 64 * 1024) throw new HttpError(413, 'Request body too large')
    chunks.push(buffer)
  }
  let value: unknown
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new HttpError(400, 'Invalid JSON') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, 'Expected an object')
  return value as Record<string, unknown>
}
function message(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > RELAY_MAX_CHARS || controls.test(value)) throw new HttpError(400, `text must be 1–${RELAY_MAX_CHARS} characters without control characters`)
  return value
}
export type CommanderTurn = { user?: string; assistant: string }
/** Newest turns win the shared text budget, including a single oversized latest turn. */
export function boundedTurns(turns: CommanderTurn[], limit: number): CommanderTurn[] {
  let remaining = 8000
  const kept: CommanderTurn[] = []
  for (const turn of turns.slice(-limit).reverse()) {
    if (!remaining) break
    const assistant = turn.assistant.slice(-remaining)
    remaining -= assistant.length
    const boundedUser = remaining ? turn.user?.slice(-remaining) : undefined
    remaining -= boundedUser?.length ?? 0
    kept.unshift({ ...(boundedUser ? { user: boundedUser } : {}), assistant })
  }
  return kept
}
export function chatTurns(items: ChatItem[]): CommanderTurn[] {
  const turns = new Map<string, CommanderTurn>()
  for (const item of items) {
    if (item.parentToolUseId || !['user_message', 'assistant_message'].includes(item.kind)) continue
    const turn = turns.get(item.turnId) ?? { assistant: '' }
    if (item.kind === 'user_message') turn.user = item.text
    if (item.kind === 'assistant_message') turn.assistant += (turn.assistant ? '\n' : '') + item.text
    turns.set(item.turnId, turn)
  }
  return [...turns.values()].filter((turn) => turn.assistant)
}
/** Read only a bounded tail, dropping the first partial JSON line. */
export async function claudeTranscriptTurns(path: string): Promise<CommanderTurn[]> {
  const file = await open(path, 'r')
  try {
    const size = (await file.stat()).size, start = Math.max(0, size - 256 * 1024)
    const buffer = Buffer.alloc(Math.min(size, 256 * 1024))
    const { bytesRead } = await file.read(buffer, 0, buffer.length, start)
    const lines = buffer.subarray(0, bytesRead).toString('utf8').split('\n')
    if (start) lines.shift()
    const turns: CommanderTurn[] = []
    let current: CommanderTurn = { assistant: '' }
    for (const raw of lines) {
      let value: Record<string, unknown>
      try { value = record(JSON.parse(raw)) } catch { continue }
      if (value.isSidechain || value.isMeta) continue
      const content = record(value.message).content
      // Tool results are protocol messages, not a user's new turn.
      const text = typeof content === 'string' ? content : Array.isArray(content)
        ? textContent(content.filter((block) => record(block).type === 'text')) : ''
      if (!text.trim()) continue
      if (value.type === 'user') {
        if (current.assistant) turns.push(current)
        current = { user: text, assistant: '' }
      } else if (value.type === 'assistant') current.assistant += (current.assistant ? '\n' : '') + text
    }
    if (current.assistant) turns.push(current)
    return turns
  } finally { await file.close() }
}

type Dependencies = {
  agentToken: string; ownerAuthorized: (request: IncomingMessage, url: URL) => Promise<boolean>
  snapshot: () => CommandoSnapshot; status: (id: string) => AgentStatus | undefined
  commander: Pick<Commander, 'state' | 'ensure' | 'forget' | 'switchProfile'>; relays: Pick<CommanderRelays, 'enqueue' | 'cancel' | 'values'>
  stalls: Pick<CommanderStalls, 'stalled' | 'check' | 'takeNudge' | 'releaseNudge'>
  brief: (targetId: string) => TurnBrief | undefined; sessionBrief: (paneId: string) => SessionBrief | undefined
  chatSession: (paneId: string) => ChatSessionInfo | undefined; owns: (id: string) => boolean; items: (id: string) => ChatItem[]
  seen: () => Record<string, number>; configDir: (pane: TmuxPane) => Promise<string | undefined>
  screen: (pane: TmuxPane) => Promise<string>; now?: () => number
  /** Path of a Codex rollout by session id. */
  codexRollout?: (sessionId: string) => Promise<string | undefined>
  /** Every Claude profile, hidden ones included, that Commander may switch to. */
  claudeProfiles?: () => Promise<readonly ClaudeProfile[]>
}
export type CommanderTranscript = { source: 'transcript' | 'screen'; items: ChatItem[]; screen?: string }
export class CommanderApi {
  private readonly tokenDigest: Buffer
  private readonly buckets = new Map<string, TokenBucketRateLimiter>()
  constructor(private readonly dependencies: Dependencies) {
    if (dependencies.agentToken.length < 32) throw new Error('Agent hook token must contain at least 32 characters')
    this.tokenDigest = digest(dependencies.agentToken)
  }
  agents(): CommanderAgent[] {
    const d = this.dependencies, snapshot = d.snapshot(), seen = d.seen()
    return snapshot.panes.flatMap((pane) => {
      const status = d.status(pane.id), chat = d.chatSession(pane.id), brief = d.brief(pane.targetId), worklog = d.sessionBrief(pane.id)
      if (pane.dead || pane.targetId === d.commander.state().targetId || ((!status || status.provider === 'unknown') && !d.owns(pane.id))) return []
      // A summary of an earlier turn must never ask for attention on a later one (same rule as the inbox).
      const latestEnd = d.owns(pane.id) ? status?.settledAt : status?.details?.recap?.completedAt ?? status?.settledAt
      const currentBrief = brief && status?.status !== 'working' && latestEnd !== undefined && brief.endedAt === latestEnd ? brief : undefined
      return [{ paneId: pane.id, targetId: pane.targetId, sessionId: pane.sessionId,
        sessionName: snapshot.sessions.find((s) => s.id === pane.sessionId)?.name ?? '',
        title: worklog?.title ?? chat?.title ?? pane.chatTitle ?? pane.title,
        provider: status?.provider !== 'unknown' ? status?.provider ?? chat?.provider ?? 'unknown' : chat?.provider ?? 'unknown',
        status: status?.status ?? 'unknown', needsYou: status?.status === 'needs_input' || ['follow_up', 'blocked'].includes(status?.details?.recap?.outcome ?? '') || currentBrief?.kind === 'needs_you',
        stalled: d.stalls.stalled(pane.targetId), headline: worklog?.headline ?? status?.summary ?? '',
        ...(brief ? { brief } : {}), unread: (status?.settledAt ?? 0) > (seen[pane.id] ?? 0), cwd: pane.path, updatedAt: status?.updatedAt ?? 0 }]
    })
  }
  private authorized(request: IncomingMessage): boolean {
    const token = /^Bearer\s+([^\s]+)$/i.exec(request.headers.authorization ?? '')?.[1]
    return !!token && token.length <= 1024 && timingSafeEqual(digest(token), this.tokenDigest)
  }
  private caller(request: IncomingMessage): TmuxPane {
    const id = request.headers['x-commando-pane']
    if (typeof id !== 'string' || !/^%\d+$/.test(id)) throw new HttpError(400, 'X-Commando-Pane must be a tmux pane id')
    const pane = this.dependencies.snapshot().panes.find((p) => p.id === id)
    if (!pane) throw new HttpError(404, 'Tmux pane does not exist')
    if (pane.targetId !== this.dependencies.commander.state().targetId) throw new HttpError(403, 'Only Commander may use this API')
    return pane
  }
  private target(id: unknown): TmuxPane {
    if (typeof id !== 'string' || !/^%\d+$/.test(id)) throw new HttpError(400, 'pane must be a tmux pane id')
    const agent = this.agents().find((a) => a.paneId === id)
    if (!agent) throw new HttpError(404, 'Agent pane does not exist')
    return this.dependencies.snapshot().panes.find((p) => p.id === id)!
  }
  /** A terminal agent's recent conversation for Commander's reading pane; its screen when no transcript is found. */
  private async transcript(pane: TmuxPane): Promise<CommanderTranscript> {
    const d = this.dependencies, status = d.status(pane.id), sessionId = status?.agentSessionId ?? ''
    if (/^[A-Za-z0-9_-]+$/.test(sessionId)) {
      try {
        let file: string | undefined
        if (status?.provider === 'claude') {
          const config = await d.configDir(pane)
          if (config) file = join(config, 'projects', pane.path.replace(/[^a-zA-Z0-9]/g, '-'), `${sessionId}.jsonl`)
        } else if (status?.provider === 'codex') file = await d.codexRollout?.(sessionId)
        const items = !file ? [] : status?.provider === 'claude' ? await claudeTranscriptFileItems(file) : codexRolloutItems((await tailJsonLines(file)).lines)
        if (items.length) return { source: 'transcript', items }
      } catch { /* Missing/unreadable transcripts fall back to the rendered screen. */ }
    }
    return { source: 'screen', items: [], screen: stripVTControlCharacters(await d.screen(pane)).slice(-20_000) }
  }
  private take(caller: TmuxPane): boolean {
    const live = new Set(this.dependencies.snapshot().panes.map((p) => p.targetId))
    for (const key of this.buckets.keys()) if (!live.has(key)) this.buckets.delete(key)
    let bucket = this.buckets.get(caller.targetId)
    if (!bucket) { bucket = new TokenBucketRateLimiter(30, 1 / 20, this.dependencies.now); this.buckets.set(caller.targetId, bucket) }
    return bucket.take(1)
  }
  async handle(request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean> {
    if (url.pathname !== ROOT && !url.pathname.startsWith(`${ROOT}/`)) return false
    const d = this.dependencies, path = url.pathname
    try {
      const agentRoute = path === AGENT || path.startsWith(`${AGENT}/`)
      let caller: TmuxPane | undefined
      if (agentRoute) {
        if (!this.authorized(request)) throw new HttpError(401, 'Agent authorization required')
        caller = this.caller(request)
      } else if (this.authorized(request) || !await d.ownerAuthorized(request, url)) throw new HttpError(401, 'Owner authorization required')
      const cancel = new RegExp(`^${agentRoute ? AGENT : ROOT}/relays/([a-f0-9-]+)/cancel$`).exec(path)
      if (cancel && request.method === 'POST') {
        const relay = await d.relays.cancel(cancel[1])
        if (!relay) throw new HttpError(409, 'Relay is not queued or does not exist')
        json(response, 200, { ok: true, relay })
      } else if (path === ROOT && request.method === 'POST') json(response, 200, { ok: true, state: await d.commander.ensure() })
      else if (path === ROOT && request.method === 'DELETE') { await d.commander.forget(); json(response, 200, { ok: true, state: d.commander.state() }) }
      else if (path === `${ROOT}/profile` && request.method === 'PUT') {
        const { configDir } = await body(request)
        if (configDir !== null && typeof configDir !== 'string') throw new HttpError(400, 'configDir must be a profile folder or null')
        if (configDir !== null && !(await d.claudeProfiles?.() ?? []).some((profile) => profile.configDir === configDir)) throw new HttpError(400, 'Unknown Claude profile')
        json(response, 200, { ok: true, state: await d.commander.switchProfile(configDir) })
      }
      else if (path === `${ROOT}/transcript` && request.method === 'GET') json(response, 200, { ok: true, ...await this.transcript(this.target(url.searchParams.get('pane'))) })
      else if (path === `${AGENT}/list` && request.method === 'GET') { await d.stalls.check(); json(response, 200, this.agents()) }
      else if (path === `${AGENT}/relays` && request.method === 'GET') {
        const limit = Number(url.searchParams.get('limit') ?? 20)
        if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new HttpError(400, 'limit must be 1–200')
        json(response, 200, d.relays.values(limit))
      } else if (path === `${AGENT}/read` && request.method === 'GET') {
        const pane = this.target(url.searchParams.get('pane')), count = Number(url.searchParams.get('turns') ?? 3)
        if (!Number.isInteger(count) || count < 1 || count > 10) throw new HttpError(400, 'turns must be 1–10')
        const agent = this.agents().find((a) => a.paneId === pane.id)!
        let source: 'chat' | 'transcript' | 'screen' = 'screen', turns: CommanderTurn[] = []
        if (d.owns(pane.id)) { source = 'chat'; turns = chatTurns(d.items(pane.id)) }
        else {
          const status = d.status(pane.id)
          if (status?.provider === 'claude' && /^[A-Za-z0-9_-]+$/.test(status.agentSessionId ?? '')) {
            const config = await d.configDir(pane)
            if (config) {
              try {
                turns = await claudeTranscriptTurns(join(config, 'projects', pane.path.replace(/[^a-zA-Z0-9]/g, '-'), `${status.agentSessionId}.jsonl`))
                if (turns.length) source = 'transcript'
              } catch { /* Missing/unreadable transcripts fall back to the rendered screen. */ }
            }
          }
          if (source === 'screen') turns = [{ assistant: stripVTControlCharacters(await d.screen(pane)).slice(-8000) }]
        }
        json(response, 200, { agent, turns: boundedTurns(turns, count), source })
      } else if (request.method === 'POST' && [ `${ROOT}/relays`, `${AGENT}/relay`, `${AGENT}/nudge` ].includes(path)) {
        const value = await body(request), pane = this.target(caller ? value.pane : value.paneId), text = message(value.text)
        if (caller && value.steer !== undefined && typeof value.steer !== 'boolean') throw new HttpError(400, 'steer must be a boolean')
        if (!caller && value.delivery !== undefined && !['queue', 'steer'].includes(String(value.delivery))) throw new HttpError(400, 'delivery must be queue or steer')
        if (caller && !this.take(caller)) throw new HttpError(429, 'Relay rate limit reached')
        const nudge = path === `${AGENT}/nudge`
        if (nudge) {
          await d.stalls.check()
          if (!d.stalls.stalled(pane.targetId)) throw new HttpError(409, 'Target is not stalled')
          if (!d.stalls.takeNudge(pane.targetId)) throw new HttpError(429, 'Nudge limit reached for this episode or hour')
        }
        const relay = await d.relays.enqueue({ paneId: pane.id, origin: caller ? 'commander' : 'inbox', kind: nudge ? 'nudge' : 'relay',
          delivery: nudge ? 'queue' : (caller ? value.steer === true : value.delivery === 'steer') ? 'steer' : 'queue',
          text: caller ? `${nudge ? NUDGE_TAG : RELAY_TAG} ${text}` : text }).catch((error: unknown) => {
            if (nudge) d.stalls.releaseNudge(pane.targetId)
            throw error
          })
        json(response, 200, { ok: true, relay })
      } else throw new HttpError(404, 'Not found')
    } catch (error) {
      if (!(error instanceof HttpError)) console.error('[commando] Commander request failed', error)
      json(response, error instanceof HttpError ? error.status : 502, { ok: false, error: error instanceof Error ? error.message : 'Commander request failed' })
    }
    return true
  }
}
