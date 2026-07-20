import { describe, expect, it, vi } from 'vitest'

import {
  parseClaudeUsage,
  parseCodexUsage,
  ProviderUsageService,
} from './provider-usage.js'

describe('provider usage', () => {
  it('normalizes Claude remaining usage and reset times', () => {
    expect(parseClaudeUsage({
      five_hour: { utilization: 23, resets_at: '2026-07-20T12:00:00.000Z' },
      seven_day: { utilization: 61.5, resets_at: '2026-07-25T12:00:00.000Z' },
    }, 10)).toEqual({
      provider: 'claude',
      state: 'available',
      windows: [
        {
          label: '5h',
          usedPercent: 23,
          remainingPercent: 77,
          resetsAt: Date.parse('2026-07-20T12:00:00.000Z'),
        },
        {
          label: '7d',
          usedPercent: 61.5,
          remainingPercent: 38.5,
          resetsAt: Date.parse('2026-07-25T12:00:00.000Z'),
        },
      ],
      updatedAt: 10,
    })
  })

  it('normalizes Codex rolling windows and relative resets', () => {
    expect(parseCodexUsage({
      plan_type: 'plus',
      rate_limit: {
        primary_window: {
          used_percent: 10,
          limit_window_seconds: 18_000,
          reset_after_seconds: 120,
        },
        secondary_window: {
          used_percent: 35,
          limit_window_seconds: 604_800,
          reset_at: 1_800_000_000,
        },
      },
    }, 1_000)).toMatchObject({
      provider: 'codex',
      state: 'available',
      plan: 'plus',
      windows: [
        { label: '5h', usedPercent: 10, remainingPercent: 90, resetsAt: 121_000 },
        { label: '7d', usedPercent: 35, remainingPercent: 65, resetsAt: 1_800_000_000_000 },
      ],
    })
  })

  it('uses existing CLI credentials without exposing them in results', async () => {
    const request = vi.fn<typeof fetch>(async (input) => {
      const url = String(input)
      return url.includes('anthropic')
        ? new Response(JSON.stringify({ five_hour: { utilization: 5 } }), { status: 200 })
        : new Response(JSON.stringify({
            rate_limit: { primary_window: { used_percent: 8, limit_window_seconds: 18_000 } },
          }), { status: 200 })
    })
    const service = new ProviderUsageService({
      fetch: request,
      now: () => 42,
      readClaudeCredentials: async () => ({
        claudeAiOauth: { accessToken: 'private-claude-token' },
      }),
      readCodexCredentials: async () => ({
        tokens: { access_token: 'private-codex-token', account_id: 'private-account' },
      }),
    })

    const result = await service.refresh()

    expect(result.map(({ provider, state }) => ({ provider, state }))).toEqual([
      { provider: 'claude', state: 'available' },
      { provider: 'codex', state: 'available' },
    ])
    expect(JSON.stringify(result)).not.toContain('private-')
    expect(request).toHaveBeenCalledTimes(2)
  })
})
