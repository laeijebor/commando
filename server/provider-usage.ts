import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { resolve } from 'node:path'

import type { ProviderUsage, UsageWindow } from '../shared/protocol.js'

export const USAGE_REFRESH_INTERVAL_MS = 60_000
const REQUEST_TIMEOUT_MS = 5_000

type Fetch = typeof fetch

type ProviderUsageOptions = {
  fetch?: Fetch
  now?: () => number
  /**
   * Claude's usage, from the per-login reading chats share (claude-plan-usage.ts):
   * Claude's endpoint is rate limited per account, so this loop never fetches it.
   */
  readClaude?: () => Promise<ProviderUsage>
  readCodexCredentials?: () => Promise<unknown>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function percentage(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return Math.min(100, Math.max(0, value))
}

function resetTimestamp(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 10_000_000_000 ? Math.trunc(value) : Math.trunc(value * 1_000)
  }
  if (typeof value !== 'string') return undefined
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? timestamp : undefined
}

function windowLabel(seconds: unknown, fallback: string): string {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) return fallback
  const hours = Math.round(seconds / 3_600)
  return hours >= 24 && hours % 24 === 0 ? `${hours / 24}d` : `${hours}h`
}

function usageWindow(
  label: string,
  usedValue: unknown,
  resetsAtValue: unknown,
): UsageWindow | null {
  const usedPercent = percentage(usedValue)
  if (usedPercent === null) return null
  const resetsAt = resetTimestamp(resetsAtValue)
  return {
    label,
    usedPercent,
    remainingPercent: Math.max(0, 100 - usedPercent),
    ...(resetsAt ? { resetsAt } : {}),
  }
}

export function parseCodexUsage(value: unknown, updatedAt: number): ProviderUsage {
  const source = isRecord(value) ? value : {}
  const rateLimit = isRecord(source.rate_limit) ? source.rate_limit : {}
  const windows = [
    ['5h', rateLimit.primary_window],
    ['7d', rateLimit.secondary_window],
  ].flatMap(([fallback, candidate]) => {
    if (!isRecord(candidate)) return []
    const label = windowLabel(candidate.limit_window_seconds, fallback as string)
    let resetsAt = candidate.reset_at
    if (
      resetsAt === undefined &&
      typeof candidate.reset_after_seconds === 'number' &&
      Number.isFinite(candidate.reset_after_seconds)
    ) {
      resetsAt = new Date(updatedAt + candidate.reset_after_seconds * 1_000).toISOString()
    }
    const parsed = usageWindow(label, candidate.used_percent, resetsAt)
    return parsed ? [parsed] : []
  })
  const plan = text(source.plan_type)
  return {
    provider: 'codex',
    state: windows.length ? 'available' : 'error',
    ...(plan ? { plan } : {}),
    windows,
    updatedAt,
    ...(windows.length ? {} : { message: 'Codex usage is unavailable' }),
  }
}

async function defaultCodexCredentials(): Promise<unknown> {
  const codexHome = process.env.CODEX_HOME ?? resolve(homedir(), '.codex')
  return JSON.parse(await readFile(resolve(codexHome, 'auth.json'), 'utf8')) as unknown
}

function unavailable(provider: 'claude' | 'codex', updatedAt: number): ProviderUsage {
  const name = provider === 'claude' ? 'Claude Code' : 'Codex'
  return {
    provider,
    state: 'unavailable',
    windows: [],
    updatedAt,
    message: `Sign in to ${name} to show usage`,
  }
}

function failed(provider: 'claude' | 'codex', updatedAt: number): ProviderUsage {
  const name = provider === 'claude' ? 'Claude' : 'Codex'
  return {
    provider,
    state: 'error',
    windows: [],
    updatedAt,
    message: `${name} usage refresh failed`,
  }
}

type UsageConsumer = { notify: (usage: ProviderUsage[]) => void }

export class ProviderUsageService {
  private readonly fetch: Fetch
  private readonly now: () => number
  private readonly readClaude: () => Promise<ProviderUsage>
  private readonly readCodexCredentials: () => Promise<unknown>
  private readonly consumers = new Set<UsageConsumer>()
  private timer: NodeJS.Timeout | undefined
  private refreshing: Promise<ProviderUsage[]> | null = null
  private usage: ProviderUsage[] = []
  private lastUpdated = 0

  constructor(options: ProviderUsageOptions = {}) {
    this.fetch = options.fetch ?? globalThis.fetch
    this.now = options.now ?? Date.now
    this.readClaude = options.readClaude ?? (async () => unavailable('claude', this.now()))
    this.readCodexCredentials = options.readCodexCredentials ?? defaultCodexCredentials
  }

  values(): ProviderUsage[] {
    return this.usage.map((provider) => ({
      ...provider,
      windows: provider.windows.map((window) => ({ ...window })),
    }))
  }

  /** Timestamp of the last completed refresh, or 0 while the cache is empty. */
  lastUpdatedAt(): number {
    return this.lastUpdated
  }

  consumerCount(): number {
    return this.consumers.size
  }

  /**
   * Registers a consumer of the shared refresh loop. The loop starts with the
   * first consumer and stops once the returned release function has been called
   * by every consumer; releasing twice is a no-op.
   */
  acquire(onUpdate: (usage: ProviderUsage[]) => void): () => void {
    const consumer: UsageConsumer = { notify: onUpdate }
    this.consumers.add(consumer)
    if (!this.timer) {
      void this.refresh()
      this.timer = setInterval(() => void this.refresh(), USAGE_REFRESH_INTERVAL_MS)
      this.timer.unref()
    }
    return () => {
      if (!this.consumers.delete(consumer)) return
      if (this.consumers.size === 0) this.stop()
    }
  }

  /** Stops the refresh loop regardless of consumers; used on shutdown. */
  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }

  refresh(): Promise<ProviderUsage[]> {
    if (this.refreshing) return this.refreshing
    this.refreshing = Promise.all([this.loadClaude(), this.loadCodex()])
      .then((usage) => {
        this.usage = usage
        this.lastUpdated = this.now()
        const values = this.values()
        for (const consumer of this.consumers) consumer.notify(this.values())
        return values
      })
      .finally(() => {
        this.refreshing = null
      })
    return this.refreshing
  }

  private async loadClaude(): Promise<ProviderUsage> {
    try {
      return await this.readClaude()
    } catch {
      return failed('claude', this.now())
    }
  }

  private async loadCodex(): Promise<ProviderUsage> {
    const updatedAt = this.now()
    try {
      const credentials = await this.readCodexCredentials()
      const tokens = isRecord(credentials) && isRecord(credentials.tokens)
        ? credentials.tokens
        : {}
      const accessToken = text(tokens.access_token)
      const accountId = text(tokens.account_id)
      if (!accessToken) return unavailable('codex', updatedAt)
      const response = await this.fetch('https://chatgpt.com/backend-api/wham/usage', {
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${accessToken}`,
          ...(accountId ? { 'ChatGPT-Account-Id': accountId } : {}),
          'User-Agent': 'commando-island/0.1',
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
      if (!response.ok) return failed('codex', updatedAt)
      return parseCodexUsage(await response.json(), updatedAt)
    } catch {
      return unavailable('codex', updatedAt)
    }
  }
}
