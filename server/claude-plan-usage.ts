import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import type { ChatPlanUsage } from '../shared/agent-chat.js'
import type { ProviderUsage, UsageWindow } from '../shared/protocol.js'
import { toPlanUsage } from './agent-host/plan-usage.js'

const execFileAsync = promisify(execFile)

/**
 * How often each Claude login's plan limits are read. Claude's usage endpoint
 * is rate limited per account to a handful of requests (it is undocumented;
 * reports put it near five), and Claude Code's own `/usage` shares that budget.
 * Between readings, chats fold the free `rate_limit_event`s of their turns in.
 */
export const PLAN_USAGE_POLL_MS = 10 * 60_000
/** How often due logins are checked. Checking costs nothing; only due logins are fetched. */
const TICK_MS = 30_000
/** Waits after consecutive refusals (429): the endpoint answers `retry-after: 0`, so we pick our own. */
const BACKOFF_MS = [5, 10, 20, 30].map((minutes) => minutes * 60_000)
/** The longest a `retry-after` is obeyed for. */
const MAX_RETRY_AFTER_MS = 60 * 60_000
/** How soon a login without a usable token is looked at again. Reading the Keychain is local. */
const NO_TOKEN_RETRY_MS = 60_000
/** A login asked about by a reader (the Island) stays polled this long after the last ask. */
const READER_LEASE_MS = 3 * 60_000
/**
 * How long a login's first fetch waits after a chat joins: after a daemon restart
 * every chat reconnects at once, and one of them may hold a fresh reading.
 */
const JOIN_SETTLE_MS = 3_000
const REQUEST_TIMEOUT_MS = 5_000
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'

export type ClaudeCredentials = { accessToken: string; expiresAt?: number; plan?: string }

type Fetch = typeof fetch

export type PlanUsageStatus = 'pending' | 'ok' | 'signed_out' | 'rate_limited' | 'error'

type Login = {
  usage?: ChatPlanUsage
  status: PlanUsageStatus
  nextAt: number
  failures: number
  /** A token the endpoint rejected (401): it isn't sent again; Claude Code refreshes it on its next request. */
  rejectedToken?: string
  polling?: Promise<void>
  settling?: NodeJS.Timeout
}

export type ClaudePlanUsageOptions = {
  /** The config dirs of the Claude logins chats are open on; undefined is Claude's default login. */
  logins: () => Iterable<string | undefined>
  /** A new reading for every chat on the login. */
  deliver: (configDir: string | undefined, usage: ChatPlanUsage) => void
  readCredentials?: (configDir: string | undefined) => Promise<ClaudeCredentials | null>
  fetch?: Fetch
  now?: () => number
  log?: (message: string) => void
}

/** Claude Code keeps each config dir's login under its own Keychain item, named by a hash of the dir. */
export function claudeKeychainService(configDir: string | undefined): string {
  if (!configDir) return 'Claude Code-credentials'
  return `Claude Code-credentials-${createHash('sha256').update(configDir).digest('hex').slice(0, 8)}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function parseClaudeCredentials(value: unknown): ClaudeCredentials | null {
  const oauth = isRecord(value) && isRecord(value.claudeAiOauth) ? value.claudeAiOauth : undefined
  const accessToken = typeof oauth?.accessToken === 'string' ? oauth.accessToken.trim() : ''
  if (!oauth || !accessToken) return null
  return {
    accessToken,
    ...(typeof oauth.expiresAt === 'number' && Number.isFinite(oauth.expiresAt) ? { expiresAt: oauth.expiresAt } : {}),
    ...(typeof oauth.subscriptionType === 'string' && oauth.subscriptionType ? { plan: oauth.subscriptionType } : {}),
  }
}

async function keychainCredentials(configDir: string | undefined): Promise<ClaudeCredentials | null> {
  if (process.platform !== 'darwin') return null
  try {
    const { stdout } = await execFileAsync(
      '/usr/bin/security',
      ['find-generic-password', '-s', claudeKeychainService(configDir), '-w'],
      { encoding: 'utf8', timeout: 2_000, maxBuffer: 1024 * 1024 },
    )
    return parseClaudeCredentials(JSON.parse(stdout) as unknown)
  } catch {
    return null
  }
}

/** Where Claude Code keeps a login without a Keychain (Linux, or its fallback on macOS). */
export async function fileCredentials(configDir: string | undefined): Promise<ClaudeCredentials | null> {
  try {
    const path = join(configDir ?? join(homedir(), '.claude'), '.credentials.json')
    return parseClaudeCredentials(JSON.parse(await readFile(path, 'utf8')) as unknown)
  } catch {
    return null
  }
}

async function defaultReadCredentials(configDir: string | undefined): Promise<ClaudeCredentials | null> {
  const environmentToken = process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim()
  if (!configDir && environmentToken) return { accessToken: environmentToken }
  return await keychainCredentials(configDir) ?? await fileCredentials(configDir)
}

function retryAfterMs(response: Response): number {
  const value = response.headers.get('retry-after')
  const seconds = value === null ? Number.NaN : Number(value)
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds * 1_000, MAX_RETRY_AFTER_MS) : 0
}

const key = (configDir: string | undefined) => configDir ?? ''
const configDirOf = (loginKey: string) => loginKey || undefined

/**
 * Reads each Claude login's plan limits once for all its chats, every ten
 * minutes, and backs off when the endpoint refuses. Chats on hosts that take
 * `plan_usage` no longer ask Claude themselves.
 */
export class ClaudePlanUsage {
  /**
   * Every login seen, kept when no chat wants it any more so a chat that comes
   * back can't reset its schedule, back-off or refused token. There are a few.
   */
  private readonly logins = new Map<string, Login>()
  /** Logins a reader asked about, until when. */
  private readonly leases = new Map<string, number>()
  private readonly readCredentials: (configDir: string | undefined) => Promise<ClaudeCredentials | null>
  private readonly fetch: Fetch
  private readonly now: () => number
  private timer: NodeJS.Timeout | undefined

  constructor(private readonly options: ClaudePlanUsageOptions) {
    this.readCredentials = options.readCredentials ?? defaultReadCredentials
    this.fetch = options.fetch ?? globalThis.fetch
    this.now = options.now ?? Date.now
  }

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => void this.tick(), TICK_MS)
    this.timer.unref()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    for (const login of this.logins.values()) clearTimeout(login.settling)
  }

  /** The last reading of a login, if any. */
  reading(configDir: string | undefined): ChatPlanUsage | undefined {
    return this.logins.get(key(configDir))?.usage
  }

  status(configDir: string | undefined): PlanUsageStatus {
    return this.logins.get(key(configDir))?.status ?? 'pending'
  }

  /**
   * A chat on this login connected, with the reading its host already held (a
   * daemon restart keeps chats running). A newer one than ours is kept and
   * pushes the next fetch out, so restarts don't each cost a request.
   */
  joined(configDir: string | undefined, held: ChatPlanUsage | undefined): ChatPlanUsage | undefined {
    const login = this.login(key(configDir))
    if (held && (!login.usage || held.updatedAt > login.usage.updatedAt)) {
      login.usage = held
      if (login.status === 'pending') login.status = 'ok'
      login.nextAt = Math.max(login.nextAt, held.updatedAt + PLAN_USAGE_POLL_MS)
    }
    if (login.nextAt <= this.now()) this.pollSoon(key(configDir))
    return login.usage
  }

  /** For readers outside chats (the Island): keeps the login polled while they keep asking. */
  providerUsage(configDir: string | undefined): ProviderUsage {
    const loginKey = key(configDir)
    this.leases.set(loginKey, this.now() + READER_LEASE_MS)
    const login = this.login(loginKey)
    if (login.nextAt <= this.now()) void this.poll(loginKey)
    return toProviderUsage(login, this.now())
  }

  /** Fetches every due login that a chat or reader wants. */
  async tick(): Promise<void> {
    const now = this.now()
    const wanted = new Set<string>()
    for (const configDir of this.options.logins()) wanted.add(key(configDir))
    for (const [loginKey, until] of this.leases) {
      if (until > now) wanted.add(loginKey)
      else this.leases.delete(loginKey)
    }
    await Promise.all([...wanted].map((loginKey) => {
      const login = this.login(loginKey)
      return login.nextAt <= now ? this.poll(loginKey) : undefined
    }))
  }

  private login(loginKey: string): Login {
    let login = this.logins.get(loginKey)
    if (!login) {
      login = { status: 'pending', nextAt: 0, failures: 0 }
      this.logins.set(loginKey, login)
    }
    return login
  }

  /** A first fetch, a moment later, unless a reconnecting chat's reading makes it unneeded meanwhile. */
  private pollSoon(loginKey: string): void {
    const login = this.login(loginKey)
    if (login.settling || login.polling) return
    login.settling = setTimeout(() => {
      login.settling = undefined
      if (login.nextAt <= this.now()) void this.poll(loginKey)
    }, JOIN_SETTLE_MS)
    login.settling.unref()
  }

  private poll(loginKey: string): Promise<void> {
    const login = this.login(loginKey)
    login.polling ??= this.fetchLogin(loginKey, login).finally(() => { login.polling = undefined })
    return login.polling
  }

  private async fetchLogin(loginKey: string, login: Login): Promise<void> {
    const configDir = configDirOf(loginKey)
    const label = configDir ?? 'the default Claude login'
    const credentials = await this.readCredentials(configDir)
    const now = this.now()
    // An expired token, or one already refused, waits for Claude Code to refresh it.
    if (!credentials || credentials.accessToken === login.rejectedToken || (credentials.expiresAt !== undefined && credentials.expiresAt <= now)) {
      if (!credentials) this.setStatus(login, 'signed_out', label)
      login.nextAt = now + NO_TOKEN_RETRY_MS
      return
    }
    login.rejectedToken = undefined
    // Claimed before the request, so a tick while it runs doesn't send a second.
    login.nextAt = now + PLAN_USAGE_POLL_MS
    let response: Response
    try {
      response = await this.fetch(USAGE_URL, {
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${credentials.accessToken}`,
          'anthropic-beta': 'oauth-2025-04-20',
          'User-Agent': 'commando/0.1',
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
    } catch (error) {
      this.backOff(login, 0, 'error', `${label}: ${error instanceof Error ? error.message : String(error)}`)
      return
    }
    if (response.status === 401) {
      login.rejectedToken = credentials.accessToken
      login.nextAt = this.now() + NO_TOKEN_RETRY_MS
      this.setStatus(login, 'signed_out', label)
      return
    }
    if (response.status === 429 || response.status === 403) {
      this.backOff(login, retryAfterMs(response), 'rate_limited', label)
      return
    }
    if (!response.ok) {
      this.backOff(login, 0, 'error', `${label}: HTTP ${response.status}`)
      return
    }
    let body: unknown
    try {
      body = await response.json()
    } catch {
      this.backOff(login, 0, 'error', `${label}: unreadable response`)
      return
    }
    const usage = toPlanUsage({ rate_limits: body, ...(credentials.plan ? { subscription_type: credentials.plan } : {}) }, this.now())
    if (!usage || usage === 'no_plan_limits') {
      // An answer without windows; the next one is due on the usual schedule.
      this.setStatus(login, 'error', `${label}: no limits in the answer`)
      return
    }
    login.failures = 0
    login.usage = usage
    this.setStatus(login, 'ok', label)
    this.options.deliver(configDir, usage)
  }

  private backOff(login: Login, retryAfter: number, status: PlanUsageStatus, detail: string): void {
    login.failures += 1
    const wait = Math.max(retryAfter, BACKOFF_MS[Math.min(login.failures, BACKOFF_MS.length) - 1] ?? 0)
    login.nextAt = this.now() + wait
    this.setStatus(login, status, `${detail}; next try in ${Math.round(wait / 60_000)} min`)
  }

  private setStatus(login: Login, status: PlanUsageStatus, detail: string): void {
    if (login.status === status) return
    login.status = status
    if (status !== 'ok') this.options.log?.(`[plan-usage] ${status.replace('_', ' ')}: ${detail}`)
  }
}

const ISLAND_WINDOWS: Record<string, string> = { session: '5h', weekly_all: '7d' }

/** The Island's two windows from a login's reading. */
export function toProviderUsage(login: Pick<Login, 'usage' | 'status'>, now: number): ProviderUsage {
  const windows = (login.usage?.limits ?? []).flatMap((limit): UsageWindow[] => {
    const label = ISLAND_WINDOWS[limit.kind]
    if (!label) return []
    return [{ label, usedPercent: limit.percent, remainingPercent: Math.max(0, 100 - limit.percent), ...(limit.resetsAt ? { resetsAt: limit.resetsAt } : {}) }]
  })
  if (login.usage && windows.length) {
    return { provider: 'claude', state: 'available', ...(login.usage.plan ? { plan: login.usage.plan } : {}), windows, updatedAt: login.usage.updatedAt }
  }
  if (login.status === 'signed_out') {
    return { provider: 'claude', state: 'unavailable', windows: [], updatedAt: now, message: 'Sign in to Claude Code to show usage' }
  }
  if (login.status === 'pending') {
    return { provider: 'claude', state: 'unavailable', windows: [], updatedAt: now, message: 'Loading Claude usage' }
  }
  const message = login.status === 'rate_limited' ? 'Claude usage is rate limited; retrying later' : 'Claude usage refresh failed'
  return { provider: 'claude', state: 'error', windows: [], updatedAt: now, message }
}
