import type { SDKRateLimitInfo } from '@anthropic-ai/claude-agent-sdk'
import { describe, expect, it } from 'vitest'
import { parseChatSessionInfo, type ChatPlanUsage } from '../../shared/agent-chat.js'
import { NO_PLAN_LIMITS, applyCodexRateLimits, applyRateLimitEvent, toPlanUsage } from './plan-usage.js'

// The shape SDK 0.3.295 / Claude Code 2.1.296 returned for a Max account.
const REPORT = {
  subscription_type: 'max',
  rate_limits_available: true,
  rate_limits: {
    five_hour: { utilization: 38, resets_at: '2026-10-13T14:59:59.671801+00:00' },
    seven_day: { utilization: 43, resets_at: '2026-10-16T11:59:59.671828+00:00' },
    limits: [
      { kind: 'session', group: 'session', percent: 38, severity: 'normal', resets_at: '2026-10-13T14:59:59.671801+00:00', scope: null, is_active: false },
      { kind: 'weekly_all', group: 'weekly', percent: 43, severity: 'warning', resets_at: '2026-10-16T11:59:59.671828+00:00', scope: null, is_active: true },
      { kind: 'weekly_scoped', group: 'weekly', percent: 9, severity: 'normal', resets_at: '2026-10-16T11:59:59.672082+00:00', scope: { model: { id: null, display_name: 'Fable' }, surface: null }, is_active: false },
      { kind: 'broken', group: 'weekly', percent: null, severity: 'normal' },
    ],
  },
}

/** A reading, for the cases that are one. */
const reading = (report: unknown) => toPlanUsage(report, 5) as ChatPlanUsage

const event = (info: Partial<SDKRateLimitInfo> & Record<string, unknown>) => ({ status: 'allowed', ...info }) as SDKRateLimitInfo

describe('toPlanUsage', () => {
  it('keeps the server rows in order with titles, severity and reset times', () => {
    expect(toPlanUsage(REPORT, 5)).toEqual({
      plan: 'max',
      updatedAt: 5,
      limits: [
        { kind: 'session', title: 'Current session', percent: 38, severity: 'normal', resetsAt: Date.parse('2026-10-13T14:59:59.671Z') },
        { kind: 'weekly_all', title: 'Weekly · all models', percent: 43, severity: 'warning', resetsAt: Date.parse('2026-10-16T11:59:59.671Z') },
        { kind: 'weekly_scoped', title: 'Weekly · Fable', percent: 9, severity: 'normal', resetsAt: Date.parse('2026-10-16T11:59:59.672Z') },
      ],
    })
  })

  it('falls back to the 5h, 7d and per-model windows when the server sends no rows', () => {
    const { limits: _rows, ...rest } = REPORT.rate_limits
    const modelScoped = [{ display_name: 'Fable', utilization: 9, resets_at: '2026-10-16T11:59:59Z' }, { display_name: 'Opus', utilization: null, resets_at: null }]
    expect(reading({ ...REPORT, rate_limits: { ...rest, model_scoped: modelScoped } }).limits.map((limit) => [limit.title, limit.percent])).toEqual([
      ['Current session', 38], ['Weekly · all models', 43], ['Weekly · Fable', 9],
    ])
    // Named per-model fields count once, even when model_scoped repeats them.
    const named = { ...rest, seven_day_opus: { utilization: 70, resets_at: null }, seven_day_oauth_apps: { utilization: 2, resets_at: null }, model_scoped: [{ display_name: 'Opus', utilization: 70, resets_at: null }] }
    expect(reading({ ...REPORT, rate_limits: named }).limits.map((limit) => [limit.kind, limit.title, limit.percent])).toEqual([
      ['session', 'Current session', 38], ['weekly_all', 'Weekly · all models', 43], ['weekly_scoped', 'Weekly · Opus', 70], ['weekly_scoped', 'Weekly · OAuth apps', 2],
    ])
  })

  it('marks a full window as reached', () => {
    const report = { ...REPORT, rate_limits: { limits: [{ kind: 'session', group: 'session', percent: 100, severity: 'critical', resets_at: null }] } }
    expect(reading(report).limits[0]).toEqual({ kind: 'session', title: 'Current session', percent: 100, severity: 'critical', reached: true })
  })

  it('tells a login without plan limits apart from a reading that failed', () => {
    expect(toPlanUsage({ subscription_type: null, rate_limits_available: false, rate_limits: null }, 5)).toBe(NO_PLAN_LIMITS)
    expect(toPlanUsage({ subscription_type: 'max', rate_limits_available: true, rate_limits: null }, 5)).toBeNull()
    expect(toPlanUsage({ rate_limits_available: true, rate_limits: { limits: null, five_hour: { utilization: null } } }, 5)).toBeNull()
    expect(toPlanUsage('nope', 5)).toBeNull()
  })

  it('survives the session-info parser the daemon and browser use', () => {
    const planUsage = reading(REPORT)
    const info = parseChatSessionInfo({ paneId: '%1', provider: 'claude', cwd: '/w', status: 'idle', hostPid: 1, hostVersion: 1, planUsage })
    expect(info?.planUsage).toEqual(planUsage)
  })
})

describe('applyRateLimitEvent', () => {
  const base = reading(REPORT)

  it('updates the 5h and weekly windows from unifiedWindows fractions', () => {
    const next = applyRateLimitEvent(base, event({
      rateLimitType: 'five_hour',
      unifiedWindows: { five_hour: { utilization: 0.41, resetsAt: 1791903600 }, seven_day: { utilization: 0.44, resetsAt: 1792152000 } },
    }), 9)
    expect(next?.updatedAt).toBe(9)
    expect(next?.limits.map((limit) => [limit.kind, limit.percent, limit.resetsAt])).toEqual([
      ['session', 41, 1791903600_000],
      ['weekly_all', 44, 1792152000_000],
      ['weekly_scoped', 9, base.limits[2]!.resetsAt],
    ])
  })

  it('creates the windows when there was no reading yet', () => {
    const next = applyRateLimitEvent(undefined, event({ unifiedWindows: { five_hour: { utilization: 0.1, resetsAt: 100 } } }), 9)
    expect(next).toEqual({ updatedAt: 9, limits: [{ kind: 'session', title: 'Current session', percent: 10, severity: 'normal', resetsAt: 100_000 }] })
  })

  it('flags warnings and refusals on the window they are about', () => {
    const warned = applyRateLimitEvent(base, event({ status: 'allowed_warning', rateLimitType: 'five_hour', resetsAt: 200 }), 9)
    expect(warned?.limits[0]).toMatchObject({ kind: 'session', severity: 'warning', resetsAt: 200_000 })
    const refused = applyRateLimitEvent(warned, event({ status: 'rejected', rateLimitType: 'seven_day_opus', resetsAt: 300 }), 10)
    expect(refused?.limits.at(-1)).toMatchObject({ kind: 'seven_day_opus', title: 'Weekly · Opus', percent: 100, severity: 'critical', reached: true, resetsAt: 300_000 })
  })

  it('colours the per-model row a warning is about, and adds none for a window it does not know', () => {
    const opus = { ...base, limits: [...base.limits, { kind: 'weekly_scoped', title: 'Weekly · Opus', percent: 85, severity: 'normal' as const }] }
    const warned = applyRateLimitEvent(opus, event({ status: 'allowed_warning', rateLimitType: 'seven_day_opus' }), 9)
    expect(warned?.limits.map((limit) => [limit.title, limit.severity])).toEqual([
      ['Current session', 'normal'], ['Weekly · all models', 'warning'], ['Weekly · Fable', 'normal'], ['Weekly · Opus', 'warning'],
    ])
    expect(applyRateLimitEvent(base, event({ status: 'allowed_warning', rateLimitType: 'seven_day_sonnet' }), 9)).toBe(base)
  })

  it('reopens a reached window once it drops back under 100%', () => {
    const full = applyRateLimitEvent(base, event({ status: 'rejected', rateLimitType: 'five_hour' }), 9)
    expect(full?.limits[0]?.reached).toBe(true)
    const reset = applyRateLimitEvent(full, event({ unifiedWindows: { five_hour: { utilization: 0.02, resetsAt: 400 } } }), 10)
    expect(reset?.limits[0]).toMatchObject({ percent: 2, severity: 'normal' })
    expect(reset?.limits[0]).not.toHaveProperty('reached')
  })

  it('returns the same reading for an event with nothing to use', () => {
    expect(applyRateLimitEvent(base, event({}), 9)).toBe(base)
  })
})

describe('applyCodexRateLimits', () => {
  const snapshot = {
    limitId: 'codex', limitName: null, normalModelSlug: null, credits: null, individualLimit: null, spendControlReached: null,
    planType: 'pro', rateLimitReachedType: null,
    primary: { usedPercent: 78, windowDurationMins: 300, resetsAt: 1_800_000_000 },
    secondary: { usedPercent: 9, windowDurationMins: 10_080, resetsAt: 1_800_500_000 },
  }

  it('maps the 5h and weekly windows and grades them itself', () => {
    expect(applyCodexRateLimits(undefined, snapshot, 5)).toEqual({
      plan: 'pro',
      updatedAt: 5,
      limits: [
        { kind: 'session', title: 'Current session', percent: 78, severity: 'warning', resetsAt: 1_800_000_000_000 },
        { kind: 'weekly_all', title: 'Weekly', percent: 9, severity: 'normal', resetsAt: 1_800_500_000_000 },
      ],
    })
  })

  it('merges a sparse update and keeps windows it leaves out', () => {
    const first = applyCodexRateLimits(undefined, snapshot, 5)
    const next = applyCodexRateLimits(first, { primary: { usedPercent: 93, windowDurationMins: 300, resetsAt: null }, secondary: null, planType: null }, 9)
    expect(next?.plan).toBe('pro')
    expect(next?.limits.map((limit) => [limit.kind, limit.percent, limit.severity])).toEqual([['session', 93, 'critical'], ['weekly_all', 9, 'normal']])
    expect(next?.limits[0]?.resetsAt).toBe(1_800_000_000_000)
    expect(applyCodexRateLimits(first, { primary: null, secondary: null }, 9)).toBe(first)
  })

  it('names other window lengths and marks the fullest window when a limit is hit', () => {
    const next = applyCodexRateLimits(undefined, { ...snapshot, primary: { usedPercent: 99, windowDurationMins: 1_440, resetsAt: null }, secondary: null, rateLimitReachedType: 'rate_limit_reached' }, 5)
    expect(next?.limits).toEqual([{ kind: 'window_1440', title: '1d window', percent: 99, severity: 'critical', reached: true }])
    const credits = applyCodexRateLimits(undefined, { ...snapshot, rateLimitReachedType: 'workspace_member_credits_depleted' }, 5)
    expect(credits?.limits.some((limit) => limit.reached)).toBe(false)
  })
})
