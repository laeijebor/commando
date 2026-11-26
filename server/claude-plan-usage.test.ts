import { describe, expect, it, vi } from 'vitest'

import type { ChatPlanUsage } from '../shared/agent-chat.js'
import { ClaudePlanUsage, PLAN_USAGE_POLL_MS, claudeKeychainService, parseClaudeCredentials, toProviderUsage, type ClaudeCredentials } from './claude-plan-usage.js'

const MINUTE = 60_000
const BODY = {
  five_hour: null,
  limits: [
    { kind: 'session', group: 'session', percent: 12, severity: 'normal', resets_at: '2026-11-26T14:00:00Z' },
    { kind: 'weekly_all', group: 'weekly', percent: 3, severity: 'normal', resets_at: '2026-12-03T04:00:00Z' },
  ],
}

function harness(options: {
  logins?: (string | undefined)[]
  credentials?: (configDir: string | undefined) => ClaudeCredentials | null
  respond?: () => Response
} = {}) {
  let now = 1_000_000
  const logins = options.logins ?? ['/home/me/.claudep']
  const fetch = vi.fn<typeof globalThis.fetch>(async () => options.respond?.() ?? new Response(JSON.stringify(BODY), { status: 200 }))
  const readCredentials = vi.fn(async (configDir: string | undefined) => options.credentials ? options.credentials(configDir) : { accessToken: `token:${configDir ?? 'default'}`, plan: 'max' })
  const deliver = vi.fn<(configDir: string | undefined, usage: ChatPlanUsage) => void>()
  const log = vi.fn<(message: string) => void>()
  const usage = new ClaudePlanUsage({ logins: () => logins, deliver, readCredentials, fetch, now: () => now, log })
  return { usage, fetch, readCredentials, deliver, log, logins, advance: (ms: number) => { now += ms }, now: () => now }
}

describe('claude plan usage', () => {
  it('names the Keychain item Claude Code keeps for each config dir', () => {
    expect(claudeKeychainService(undefined)).toBe('Claude Code-credentials')
    expect(claudeKeychainService('/home/me/.claudep')).toBe('Claude Code-credentials-7c090123')
    expect(claudeKeychainService('/home/me/.claude')).toBe('Claude Code-credentials-cb67f5c9')
  })

  it('reads the OAuth token and plan, and nothing from an item without a Claude login', () => {
    expect(parseClaudeCredentials({ claudeAiOauth: { accessToken: ' t ', expiresAt: 5, subscriptionType: 'max' } })).toEqual({ accessToken: 't', expiresAt: 5, plan: 'max' })
    expect(parseClaudeCredentials({ mcpOAuth: {} })).toBeNull()
    expect(parseClaudeCredentials({ claudeAiOauth: { accessToken: '' } })).toBeNull()
  })

  it('fetches each login once per ten minutes and sends the reading to its chats', async () => {
    const { usage, fetch, deliver, advance, logins } = harness({ logins: ['/home/me/.claudep', '/home/me/.claudep', '/home/me/.claudew'] })
    await usage.tick()
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(deliver).toHaveBeenCalledWith('/home/me/.claudep', expect.objectContaining({ plan: 'max', limits: [
      expect.objectContaining({ kind: 'session', percent: 12 }),
      expect.objectContaining({ kind: 'weekly_all', percent: 3 }),
    ] }))
    advance(PLAN_USAGE_POLL_MS - 1)
    await usage.tick()
    expect(fetch).toHaveBeenCalledTimes(2)
    advance(1)
    logins.pop()
    await usage.tick()
    expect(fetch).toHaveBeenCalledTimes(3)
    expect(usage.reading('/home/me/.claudew')).toBeUndefined()
  })

  it('backs off from refusals, longer each time, and obeys a longer retry-after', async () => {
    let retryAfter = '0'
    const { usage, fetch, advance, log } = harness({ respond: () => new Response('{"error":{"type":"rate_limit_error"}}', { status: 429, headers: { 'retry-after': retryAfter } }) })
    await usage.tick()
    expect(usage.status('/home/me/.claudep')).toBe('rate_limited')
    expect(log).toHaveBeenCalledTimes(1)
    advance(5 * MINUTE - 1)
    await usage.tick()
    expect(fetch).toHaveBeenCalledTimes(1)
    advance(1)
    retryAfter = '1800'
    await usage.tick()
    expect(fetch).toHaveBeenCalledTimes(2)
    advance(10 * MINUTE)
    await usage.tick()
    expect(fetch).toHaveBeenCalledTimes(2)
    advance(20 * MINUTE)
    await usage.tick()
    expect(fetch).toHaveBeenCalledTimes(3)
    // One line when the state changes, not one per refusal.
    expect(log).toHaveBeenCalledTimes(1)
  })

  it('sends a refused token once, and an expired one never, until Claude Code refreshes it', async () => {
    let credentials: ClaudeCredentials = { accessToken: 'old' }
    let status = 401
    const { usage, fetch, advance, now } = harness({ credentials: () => credentials, respond: () => new Response(JSON.stringify(BODY), { status }) })
    await usage.tick()
    expect(usage.status('/home/me/.claudep')).toBe('signed_out')
    advance(30 * MINUTE)
    await usage.tick()
    expect(fetch).toHaveBeenCalledTimes(1)
    credentials = { accessToken: 'expired', expiresAt: now() - 1 }
    advance(MINUTE)
    await usage.tick()
    expect(fetch).toHaveBeenCalledTimes(1)
    credentials = { accessToken: 'new', expiresAt: now() + 60 * MINUTE }
    status = 200
    advance(MINUTE)
    await usage.tick()
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(usage.status('/home/me/.claudep')).toBe('ok')
  })

  it('takes the reading a reconnecting chat holds, so a daemon restart costs no request', async () => {
    const { usage, fetch, now, advance } = harness()
    const held: ChatPlanUsage = { limits: [{ kind: 'session', title: 'Current session', percent: 40, severity: 'normal' }], updatedAt: now() - 2 * MINUTE }
    expect(usage.joined('/home/me/.claudep', held)).toBe(held)
    await usage.tick()
    expect(fetch).not.toHaveBeenCalled()
    advance(8 * MINUTE)
    await usage.tick()
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('fetches straight away for the first chat on a login, and only once while it runs', async () => {
    const { usage, fetch } = harness()
    expect(usage.joined('/home/me/.claudep', undefined)).toBeUndefined()
    usage.joined('/home/me/.claudep', undefined)
    await usage.tick()
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(usage.reading('/home/me/.claudep')?.limits).toHaveLength(2)
  })

  it("keeps the Island's login polled while it keeps asking, without chats on it", async () => {
    const { usage, fetch, advance, logins } = harness({ logins: [] })
    expect(usage.providerUsage(undefined)).toMatchObject({ provider: 'claude', state: 'unavailable', message: 'Loading Claude usage' })
    await usage.tick()
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(String(fetch.mock.calls[0]?.[1]?.headers && (fetch.mock.calls[0][1].headers as Record<string, string>).Authorization)).toBe('Bearer token:default')
    const shown = usage.providerUsage(undefined)
    expect(shown).toMatchObject({ state: 'available', plan: 'max', windows: [{ label: '5h', usedPercent: 12 }, { label: '7d', usedPercent: 3 }] })
    expect(JSON.stringify(shown)).not.toContain('token')
    // No one asks for four minutes: the lease runs out and the login is dropped.
    advance(4 * MINUTE)
    await usage.tick()
    expect(usage.reading(undefined)).toBeUndefined()
    expect(logins).toEqual([])
  })

  it('shows the Island why there is no reading', () => {
    expect(toProviderUsage({ status: 'signed_out' }, 5)).toMatchObject({ state: 'unavailable', message: 'Sign in to Claude Code to show usage' })
    expect(toProviderUsage({ status: 'rate_limited' }, 5)).toMatchObject({ state: 'error', message: expect.stringContaining('rate limited') })
    // A reading outlives a later failure.
    expect(toProviderUsage({ status: 'error', usage: { limits: [{ kind: 'session', title: 'Current session', percent: 10, severity: 'normal' }], updatedAt: 3 } }, 5)).toMatchObject({ state: 'available', updatedAt: 3 })
  })
})
