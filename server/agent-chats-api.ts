import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ChatSessionInfo } from '../shared/agent-chat.js'
import type { AgentChatFailure, AgentChatInput, AgentChatLaunch, AgentChatResult } from '../shared/agent-chats.js'
import type { AgentStatus, CommandoSnapshot, TmuxPane } from '../shared/protocol.js'
import { CHAT_PERMISSION_MODES, chatLaunchProvider, chatPermissionModes, isChatLaunchProvider, type ChatLaunchProvider, requireSessionAgentLaunch, sanitizeBranchName, SESSION_AGENT_EXECUTABLES, TmuxAgentLaunchCompatibilityError, type ChatPermissionMode, type SessionAgentLaunch, type SessionAgentProvider, type TmuxCreateResponse } from '../shared/tmux-create.js'
import { AgentChatRequests } from './agent-chat-requests.js'
import { launchFlags, type AgentLaunch } from './agent-resume-command.js'
import type { ChatPlanStore } from './chat-plans.js'
import { TokenBucketRateLimiter } from './client-messages.js'
import { GitWorktreeError, validateBranchName } from './git-worktree.js'
import type { RepoPrepareCommands } from './repo-prepare-commands.js'
import { TmuxCreateCommandError, validClaudeConfigDir, type TmuxCreator } from './tmux-create.js'

const ROOT = '/api/agent-chats'
const PERMISSION_RANK: Record<ChatPermissionMode, number> = { plan: 0, default: 1, acceptEdits: 2, bypassPermissions: 3 }
const MAX_PROMPT_BYTES = 256 * 1024
const MAX_PANE_PROMPT_BYTES = 7_800
const CONTROL_CHARACTER = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u

type Dependencies = {
  agentToken: string
  ownerAuthorized: (request: IncomingMessage, url: URL) => Promise<boolean>
  snapshot: () => CommandoSnapshot
  status: (paneId: string) => AgentStatus | undefined
  chatSession: (paneId: string) => ChatSessionInfo | undefined
  chatOwns: (paneId: string) => boolean
  sendChat: (paneId: string, text: string, requestId: string) => boolean
  sendTerminal: (paneId: string, text: string) => Promise<void>
  agentLabel: (paneId: string) => string | undefined
  creator: Pick<TmuxCreator, 'createSession' | 'createPane' | 'setChatLineage'>
  plans: Pick<ChatPlanStore, 'stash'>
  prepareCommands: Pick<RepoPrepareCommands, 'get'>
  beforePaneCreated: (windowId: string) => Promise<void>
  refreshSnapshot: () => Promise<unknown>
  requests: AgentChatRequests
  /** The CLI running in a terminal pane: its argv and profile variables. */
  agentLaunch?: (panePid: number, provider: 'claude' | 'codex' | 'muse') => Promise<AgentLaunch | undefined>
  chatCliPath?: string
  now?: () => number
}

/**
 * Codex's default (workspace access) edits and runs commands without asking, like Claude's
 * acceptEdits; so does Muse's, inside its sandbox.
 */
function effectiveRank(provider: string, mode: ChatPermissionMode): number {
  return (provider === 'codex-chat' || provider === 'muse-chat') && mode === 'default' ? PERMISSION_RANK.acceptEdits : PERMISSION_RANK[mode]
}

/** A chat's permission mode as the four a launch takes; others (auto, dontAsk) count as asking first. */
function launchMode(chat: Pick<ChatSessionInfo, 'permissionMode'> | undefined): ChatPermissionMode {
  return chat?.permissionMode && Object.hasOwn(PERMISSION_RANK, chat.permissionMode) ? chat.permissionMode as ChatPermissionMode : 'default'
}

function chatRank(chat: Pick<ChatSessionInfo, 'provider' | 'permissionMode'>): number {
  return effectiveRank(chatLaunchProvider(chat.provider), launchMode(chat))
}

/** The most permissive mode `provider` supports that does not exceed what `rank` allows. */
function inheritedMode(provider: ChatLaunchProvider, rank: number): ChatPermissionMode {
  return [...chatPermissionModes(provider)].map((mode) => mode.value)
    .filter((mode) => effectiveRank(provider, mode) <= rank)
    .sort((left, right) => effectiveRank(provider, right) - effectiveRank(provider, left))[0] ?? 'plan'
}

/** The mode a chat started from `chat` gets: as permissive as it, never more. */
export function inheritedChatPermissionMode(chat: Pick<ChatSessionInfo, 'provider' | 'permissionMode'>, provider: ChatLaunchProvider): ChatPermissionMode {
  return inheritedMode(provider, chatRank(chat))
}

type TerminalCaller = { provider: ChatLaunchProvider; rank: number; configDir?: string; warning?: string }

const modeOfRank = (rank: number): ChatPermissionMode =>
  (Object.keys(PERMISSION_RANK) as ChatPermissionMode[]).find((mode) => PERMISSION_RANK[mode] === rank) ?? 'default'

function flagValue(flags: readonly string[], ...names: string[]): string | undefined {
  for (const [index, flag] of flags.entries()) {
    for (const name of names) {
      if (flag === name) return flags[index + 1]
      if (flag.startsWith(`${name}=`)) return flag.slice(name.length + 1)
    }
  }
  return undefined
}

/**
 * How permissive a terminal agent's launch flags make it. Only flags before the prompt count,
 * so a prompt's words cannot raise it. Mode switches made inside the TUI, and modes set in the
 * agent's config files, are not visible: this is what the command line started it with.
 */
export function terminalLaunchRank(provider: 'claude' | 'codex' | 'muse', args: readonly string[]): number {
  const flags = launchFlags(provider, args)
  if (!flags) return PERMISSION_RANK.default
  if (provider === 'muse') {
    const approval = flagValue(flags, '--approval-mode')
    if (flags.includes('--yolo') || flags.includes('--disable-approval') || approval === 'never') return PERMISSION_RANK.bypassPermissions
    return effectiveRank('muse-chat', 'default')
  }
  if (provider === 'claude') {
    if (flags.includes('--dangerously-skip-permissions')) return PERMISSION_RANK.bypassPermissions
    const mode = flagValue(flags, '--permission-mode')
    return mode && Object.hasOwn(PERMISSION_RANK, mode) ? PERMISSION_RANK[mode as ChatPermissionMode] : PERMISSION_RANK.default
  }
  if (flags.includes('--dangerously-bypass-approvals-and-sandbox')) return PERMISSION_RANK.bypassPermissions
  const config = flagValue(flags, '-c', '--config')
  const readOnly = flagValue(flags, '-s', '--sandbox') === 'read-only' || /^sandbox_mode\s*=\s*["']?read-only/u.test(config ?? '')
  // Codex's default sandbox writes the workspace without asking, like Claude's acceptEdits.
  return readOnly ? PERMISSION_RANK.plan : effectiveRank('codex-chat', 'default')
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message) }
}

const digest = (value: string): Buffer => createHash('sha256').update(value).digest()
function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
  response.end(`${JSON.stringify(value)}\n`)
}

async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  if (request.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') throw new HttpError(400, 'Content-Type must be application/json')
  const chunks: Buffer[] = []
  let length = 0
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk)
    length += buffer.length
    if (length > MAX_PROMPT_BYTES * 6 + 4096) throw new HttpError(413, 'Request body is too large')
    chunks.push(buffer)
  }
  let value: unknown
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new HttpError(400, 'Request body is not valid JSON') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, 'Request body must be an object')
  return value as Record<string, unknown>
}

function parseInput(value: Record<string, unknown>): AgentChatInput {
  for (const key of Object.keys(value)) {
    if (!['location', 'title', 'prompt', 'split', 'branch', 'worktree', 'agent', 'permissionMode'].includes(key)) throw new HttpError(400, `Unsupported field: ${key}`)
  }
  const location = value.location ?? 'session', split = value.split ?? 'right'
  if (location !== 'pane' && location !== 'session') throw new HttpError(400, 'location must be pane or session')
  if (split !== 'right' && split !== 'down') throw new HttpError(400, 'split must be right or down')
  if (value.split !== undefined && location !== 'pane') throw new HttpError(400, 'split is only supported for pane chats')
  if (typeof value.title !== 'string' || !value.title.trim() || value.title.length > 80 || /[\u0000-\u001f\u007f-\u009f]/u.test(value.title)) throw new HttpError(400, 'title must be 1–80 characters without control characters')
  if (typeof value.prompt !== 'string' || !value.prompt.trim()) throw new HttpError(400, 'prompt is required')
  if (Buffer.byteLength(value.prompt) > MAX_PROMPT_BYTES) throw new HttpError(413, 'prompt must be at most 256 KB')
  if (CONTROL_CHARACTER.test(value.prompt)) throw new HttpError(400, 'prompt contains unsupported control characters')
  if (value.branch !== undefined && (typeof value.branch !== 'string' || !value.branch.trim() || value.branch.length > 128 || /[\u0000-\u001f\u007f-\u009f]/u.test(value.branch))) throw new HttpError(400, 'Invalid branch name')
  if (value.worktree !== undefined && typeof value.worktree !== 'boolean') throw new HttpError(400, 'worktree must be a boolean')
  if (value.agent !== undefined && (typeof value.agent !== 'string' || !Object.hasOwn(SESSION_AGENT_EXECUTABLES, value.agent))) throw new HttpError(400, 'Unknown agent provider')
  if (value.permissionMode !== undefined && !CHAT_PERMISSION_MODES.some((mode) => mode.value === value.permissionMode)) throw new HttpError(400, 'Unknown permission mode')
  const input = { ...value, location, split } as AgentChatInput
  const branch = effectiveChatBranch(input)
  if (branch !== undefined) validateBranchName(branch)
  return input
}

function waitBudget(url: URL): number {
  const seconds = Number(url.searchParams.get('wait') ?? 0)
  if (!Number.isFinite(seconds) || seconds < 0 || seconds > 60) throw new HttpError(400, 'wait must be between 0 and 60 seconds')
  return seconds * 1000
}

function effectiveChatBranch(input: AgentChatInput): string | undefined {
  return input.branch ?? (input.location === 'session' && input.worktree !== false ? sanitizeBranchName(input.title) || 'chat' : undefined)
}

function failure(error: unknown): AgentChatFailure {
  const status = error instanceof HttpError ? error.status
    : error instanceof TmuxAgentLaunchCompatibilityError || error instanceof TmuxCreateCommandError ? 502
      : error instanceof GitWorktreeError ? (['branch-checked-out', 'path-exists'].includes(error.kind) ? 409 : error.kind === 'exec' ? 502 : 400) : 400
  return { ok: false, status, error: error instanceof Error ? error.message : 'Unable to open chat' }
}

export class AgentChatsApi {
  private readonly tokenDigest: Buffer
  private readonly openBuckets = new Map<string, TokenBucketRateLimiter>()
  private readonly reportBuckets = new Map<string, TokenBucketRateLimiter>()
  private creations: Promise<unknown> = Promise.resolve()

  constructor(private readonly dependencies: Dependencies) {
    if (dependencies.agentToken.length < 32) throw new Error('Agent hook token must contain at least 32 characters')
    this.tokenDigest = digest(dependencies.agentToken)
  }

  private agentAuthorized(request: IncomingMessage): boolean {
    const candidate = /^Bearer\s+([^\s]+)$/i.exec(request.headers.authorization ?? '')?.[1]
    return !!candidate && candidate.length <= 1024 && timingSafeEqual(digest(candidate), this.tokenDigest)
  }

  private caller(request: IncomingMessage): TmuxPane {
    const id = request.headers['x-commando-pane']
    if (typeof id !== 'string' || !/^%\d+$/.test(id)) throw new HttpError(400, 'X-Commando-Pane must be a tmux pane id')
    const pane = this.dependencies.snapshot().panes.find((pane) => pane.id === id)
    if (!pane) throw new HttpError(404, 'Tmux pane does not exist')
    return pane
  }

  /**
   * A terminal Claude Code or Codex caller opens the matching hosted chat, on the caller's
   * own Claude profile and no more permissive than the flags it was launched with.
   */
  private async terminalCaller(caller: TmuxPane): Promise<TerminalCaller | undefined> {
    const provider = this.dependencies.status(caller.id)?.provider
    if (provider !== 'claude' && provider !== 'codex' && provider !== 'muse') return undefined
    const hosted = chatLaunchProvider(provider)
    const launch = caller.processId === undefined ? undefined
      : await this.dependencies.agentLaunch?.(caller.processId, provider).catch(() => undefined)
    if (!launch) return { provider: hosted, rank: PERMISSION_RANK.default, warning: `Could not read the caller's ${provider} process; the chat uses the default profile and asks before edits.` }
    const rank = terminalLaunchRank(provider, launch.args)
    const configDir = provider === 'claude' ? launch.env.CLAUDE_CONFIG_DIR : undefined
    if (!configDir) return { provider: hosted, rank }
    return validClaudeConfigDir(configDir) ? { provider: hosted, rank, configDir }
      : { provider: hosted, rank, warning: `The caller's CLAUDE_CONFIG_DIR ${JSON.stringify(configDir)} is not a ~/.claude… folder; the chat uses the default profile.` }
  }

  private async launch(input: AgentChatInput, caller: TmuxPane): Promise<{ launch: AgentChatLaunch; warning?: string }> {
    const chat = this.dependencies.chatSession(caller.id)
    const terminal = chat ? undefined : await this.terminalCaller(caller)
    const provider = input.agent ?? (chat ? chatLaunchProvider(chat.provider) : terminal?.provider ?? this.dependencies.status(caller.id)?.provider)
    if (!provider || !Object.hasOwn(SESSION_AGENT_EXECUTABLES, provider)) throw new HttpError(400, 'Unknown caller agent provider; specify --agent')
    const hosted = isChatLaunchProvider(provider)
    const callerMode = chat ? launchMode(chat) : modeOfRank(terminal?.rank ?? PERMISSION_RANK.default)
    const callerRank = chat ? chatRank(chat) : terminal?.rank ?? PERMISSION_RANK.default
    if (callerRank < PERMISSION_RANK.default && !hosted) throw new HttpError(403, 'A plan-mode chat can only open claude-chat, codex-chat or muse-chat chats')
    if (!hosted && input.permissionMode !== undefined) throw new HttpError(400, 'Only claude-chat, codex-chat and muse-chat accept a permission mode')
    if (input.permissionMode !== undefined && (!hosted || !chatPermissionModes(provider).some((mode) => mode.value === input.permissionMode))) throw new HttpError(400, `${provider} does not support permission mode ${input.permissionMode}`)
    // Inherit the most permissive mode the child supports that does not exceed the caller.
    const permissionMode = input.permissionMode ?? (hosted ? inheritedMode(provider, callerRank) : 'plan')
    if (effectiveRank(provider, permissionMode) > callerRank) throw new HttpError(403, `Cannot raise permission mode from ${callerMode} to ${permissionMode}`)
    if (!hosted) return { launch: { provider: provider as SessionAgentProvider } }
    const configDir = provider !== 'claude-chat' ? undefined : chat ? (chatLaunchProvider(chat.provider) === 'claude-chat' ? chat.configDir : undefined) : terminal?.configDir
    return { launch: { provider, permissionMode, ...(configDir ? { configDir } : {}) }, ...(terminal?.warning && provider === terminal.provider ? { warning: terminal.warning } : {}) }
  }

  private take(buckets: Map<string, TokenBucketRateLimiter>, caller: TmuxPane, capacity: number, seconds: number): boolean {
    const live = new Set(this.dependencies.snapshot().panes.map((pane) => pane.targetId))
    for (const key of buckets.keys()) if (!live.has(key)) buckets.delete(key)
    let bucket = buckets.get(caller.targetId)
    if (!bucket) { bucket = new TokenBucketRateLimiter(capacity, 1 / seconds, this.dependencies.now); buckets.set(caller.targetId, bucket) }
    return bucket.take(1)
  }

  async handle(request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean> {
    if (url.pathname !== ROOT && !url.pathname.startsWith(`${ROOT}/`)) return false
    try {
      const requestId = /^\/api\/agent-chats\/requests\/(cr-[0-9a-f]+)$/.exec(url.pathname)?.[1]
      if (requestId && request.method === 'POST') {
        // An agent bearer is never promoted to owner, even in a local-only daemon.
        if (this.agentAuthorized(request) || !await this.dependencies.ownerAuthorized(request, url)) throw new HttpError(401, 'Owner authorization required')
        const value = await body(request)
        if (value.decision !== 'accepted' && value.decision !== 'dismissed') throw new HttpError(400, 'decision must be accepted or dismissed')
        if (!this.dependencies.requests.lookup(requestId)) throw new HttpError(404, 'Chat request does not exist')
        const entry = this.dependencies.requests.claim(requestId)
        if (!entry) throw new HttpError(409, 'Chat request is already being accepted or settled')
        if (value.decision === 'dismissed') this.dependencies.requests.settle(requestId, 'dismissed')
        else {
          const result = await this.create(entry.input, entry.request.callerPaneId, entry.request.callerTargetId)
          this.dependencies.requests.settle(requestId, 'accepted', result)
        }
        const outcome = this.dependencies.requests.outcome(requestId)!
        json(response, outcome.ok ? 200 : outcome.status, outcome)
        return true
      }
      if (!this.agentAuthorized(request)) { response.setHeader('WWW-Authenticate', 'Bearer realm="commando-agent-hooks"'); throw new HttpError(401, 'Unauthorized') }
      if (requestId && request.method === 'GET') {
        const entry = this.dependencies.requests.lookup(requestId)
        if (!entry) throw new HttpError(404, 'Chat request does not exist')
        // Polling is scoped to its caller just like opening and listing.
        const caller = this.caller(request)
        if (entry.request.callerTargetId !== caller.targetId) throw new HttpError(404, 'Chat request does not exist')
        await this.writeDecision(response, requestId, waitBudget(url))
        return true
      }
      const caller = this.caller(request)
      if (url.pathname === ROOT && request.method === 'GET') {
        const snapshot = this.dependencies.snapshot()
        json(response, 200, snapshot.panes.filter((pane) => pane.openedBy === caller.targetId).map((pane) => ({
          paneId: pane.id, targetId: pane.targetId, title: pane.chatTitle ?? pane.title,
          sessionName: snapshot.sessions.find((session) => session.id === pane.sessionId)?.name ?? '',
          cwd: pane.path, status: this.dependencies.status(pane.id)?.status ?? 'unknown',
        })))
      } else if (url.pathname === ROOT && request.method === 'POST') {
        const waitMs = waitBudget(url)
        const input = parseInput(await body(request))
        const { launch } = await this.launch(input, caller)
        const reason = caller.openedBy ? 'depth' : !this.take(this.openBuckets, caller, 3, 120) ? 'rate' : undefined
        if (reason) {
          const approval = this.dependencies.requests.create({
            callerPaneId: caller.id, callerTargetId: caller.targetId, requestedBy: this.dependencies.agentLabel(caller.id) ?? launch.provider,
            reason, summary: { location: input.location, title: input.title, branch: effectiveChatBranch(input),
              provider: launch.provider, ...(launch.permissionMode ? { permissionMode: launch.permissionMode } : {}), promptPreview: input.prompt.slice(0, 200) },
          }, { ...input, agent: launch.provider, ...(launch.permissionMode ? { permissionMode: launch.permissionMode } : {}) })
          await this.writeDecision(response, approval.id, waitMs)
        } else {
          const result = await this.create(input, caller.id, caller.targetId)
          json(response, result.ok ? 200 : result.status, result)
        }
      } else if (url.pathname === `${ROOT}/report` && request.method === 'POST') {
        if (!caller.openedBy) throw new HttpError(409, 'this chat was not opened by another chat')
        const parent = this.dependencies.snapshot().panes.find((pane) => pane.targetId === caller.openedBy)
        if (!parent) throw new HttpError(410, 'Parent chat no longer exists')
        const value = await body(request)
        if (typeof value.message !== 'string' || !value.message.trim() || value.message.length > 1000 || CONTROL_CHARACTER.test(value.message)) throw new HttpError(400, 'message must be 1–1000 characters without unsupported control characters')
        if (!this.take(this.reportBuckets, caller, 10, 30)) throw new HttpError(429, 'Report rate limit reached')
        const text = `[from ${caller.id} · ${caller.chatTitle ?? caller.title}] ${value.message.replace(/[\r\n]+/gu, ' ')}`
        if (this.dependencies.chatOwns(parent.id)) {
          if (!this.dependencies.sendChat(parent.id, text, randomUUID())) throw new HttpError(502, 'Parent chat is unavailable')
        } else {
          try { await this.dependencies.sendTerminal(parent.id, text) } catch (error) { throw new HttpError(502, error instanceof Error ? error.message : 'Parent agent is unavailable') }
        }
        json(response, 200, { ok: true })
      } else throw new HttpError(404, 'Not found')
    } catch (error) { const result = failure(error); json(response, result.status, result) }
    return true
  }

  private async writeDecision(response: ServerResponse, id: string, waitMs: number): Promise<void> {
    const controller = new AbortController()
    const close = (): void => controller.abort()
    response.on('close', close)
    try {
      const outcome = await this.dependencies.requests.wait(id, waitMs, controller.signal)
      if (!response.destroyed) json(response, outcome?.decision === 'pending' ? 202 : outcome && !outcome.ok ? outcome.status : 200, outcome)
    } finally { response.off('close', close) }
  }

  private create(input: AgentChatInput, paneId: string, targetId: string): Promise<AgentChatResult | AgentChatFailure> {
    const creation = this.creations.then(() => this.createNow(input, paneId, targetId))
    this.creations = creation.catch(() => {})
    return creation
  }

  private async createNow(input: AgentChatInput, paneId: string, targetId: string): Promise<AgentChatResult | AgentChatFailure> {
    let created: AgentChatResult | undefined
    try {
      await this.dependencies.refreshSnapshot()
      const snapshot = this.dependencies.snapshot()
      const caller = snapshot.panes.find((pane) => pane.id === paneId && pane.targetId === targetId)
      if (!caller) throw new HttpError(404, 'Caller pane no longer exists')
      const session = snapshot.sessions.find((session) => session.id === caller.sessionId)
      if (!session) throw new HttpError(404, 'Caller session no longer exists')
      const { launch, warning: launchWarning } = await this.launch(input, caller)
      const repo = caller.repo
      const branch = repo && effectiveChatBranch(input)
      const warning = [!repo ? 'Caller is not in a git repository; using its cwd without a worktree.' : undefined, launchWarning].filter(Boolean).join(' ') || undefined
      const cwd = input.location === 'session' && repo ? repo.root : caller.path
      const worktree = branch ? { branch, prepareCommand: await this.dependencies.prepareCommands.get(repo!.root) } : undefined
      const cliPath = this.dependencies.chatCliPath ?? join(homedir(), '.commando', 'hooks', 'commando-chat.mjs')
      const prompt = `You were opened by another agent (${this.dependencies.agentLabel(caller.id) ?? launch.provider}, pane ${caller.id}, session ${session.name}${repo?.branch ? `, branch ${repo.branch}` : ''}) at the user's request. Its brief follows. Work independently; the parent is not waiting on you. When you finish, or if you are blocked, send one line back with: node "${cliPath}" report "<message>".\n---\n${input.prompt}`
      const agent: SessionAgentLaunch = { ...launch, prompt }
      if (Buffer.byteLength(prompt) > MAX_PANE_PROMPT_BYTES) {
        const file = await this.dependencies.plans.stash(prompt)
        agent.prompt = `Read the full opening brief at ${JSON.stringify(file.path)} and follow its instructions.`
        if (agent.provider === 'claude-chat') agent.readableDir = file.dir
      }
      let result: TmuxCreateResponse
      try {
        if (input.location === 'session') {
          const slug = (sanitizeBranchName(input.title) || 'chat').replace(/[.:]/gu, '-')
          const names = new Set(snapshot.sessions.map((session) => session.name))
          let name = slug, suffix = 2
          while (names.has(name)) name = `${slug}-${suffix++}`
          result = await this.dependencies.creator.createSession({ name, cwd, ...(worktree ? { worktree } : {}), agent })
        } else {
          const pane = await this.dependencies.creator.createPane({ targetId: caller.id, direction: input.split === 'right' ? 'horizontal' : 'vertical', placement: 'after', cwd, ...(worktree ? { worktree } : {}), agent },
            () => this.dependencies.beforePaneCreated(caller.windowId))
          result = { created: pane, ...(pane.worktree ? { worktree: pane.worktree } : {}), ...(pane.agentLaunch ? { agentLaunch: pane.agentLaunch } : {}) }
        }
      } catch (error) {
        if (error instanceof TmuxAgentLaunchCompatibilityError) result = error.response
        else throw error
      }
      created = { ok: true, location: input.location, paneId: result.created.paneId, targetId: '',
        sessionId: result.created.sessionId, sessionName: result.created.sessionName, windowId: result.created.windowId,
        cwd: result.created.panePath, ...(result.worktree ? { worktree: result.worktree } : {}), agent: launch, ...(warning ? { warning } : {}) }
      await this.dependencies.creator.setChatLineage(created.paneId, caller.targetId, input.title)
      await this.dependencies.refreshSnapshot()
      created.targetId = this.dependencies.snapshot().panes.find((pane) => pane.id === created!.paneId)?.targetId ?? ''
      if (!created.targetId) throw new HttpError(502, 'Chat was created but its stable target was not mirrored; inspect the created pane and do not retry')
      requireSessionAgentLaunch({ name: created.sessionName, agent }, result)
      return created
    } catch (error) {
      return { ...failure(error), ...(created ? { status: 502, created, error: `${error instanceof Error ? error.message : String(error)}. The target was created; do not retry.` } : {}) }
    }
  }
}
