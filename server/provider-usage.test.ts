import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  parseCodexUsage,
  ProviderUsageService,
  USAGE_REFRESH_INTERVAL_MS,
} from './provider-usage.js'

function stubService(options: { now?: () => number } = {}): ProviderUsageService {
  return new ProviderUsageService({
    fetch: vi.fn<typeof fetch>(async () => new Response('{}', { status: 200 })),
    now: options.now ?? (() => 0),
    readClaude: async () => ({ provider: 'claude', state: 'available', windows: [], updatedAt: 0 }),
    readCodexCredentials: async () => ({ tokens: { access_token: 'token' } }),
  })
}

describe('provider usage', () => {
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

  it('takes Claude from the shared reading, never fetching it, and keeps Codex credentials out of results', async () => {
    const request = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      rate_limit: { primary_window: { used_percent: 8, limit_window_seconds: 18_000 } },
    }), { status: 200 }))
    const service = new ProviderUsageService({
      fetch: request,
      now: () => 42,
      readClaude: async () => ({ provider: 'claude', state: 'available', windows: [{ label: '5h', usedPercent: 5, remainingPercent: 95 }], updatedAt: 40 }),
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
    expect(request).toHaveBeenCalledTimes(1)
    expect(String(request.mock.calls[0]?.[0])).toContain('chatgpt.com')
  })

  it('shows a failed Claude read as an error rather than dropping the provider', async () => {
    const service = new ProviderUsageService({
      fetch: vi.fn<typeof fetch>(async () => new Response('{}', { status: 200 })),
      now: () => 7,
      readClaude: async () => { throw new Error('profiles unreadable') },
      readCodexCredentials: async () => null,
    })
    const [claude] = await service.refresh()
    expect(claude).toMatchObject({ provider: 'claude', state: 'error' })
  })
})

describe('provider usage consumers', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('runs one refresh loop for any number of consumers', async () => {
    vi.useFakeTimers()
    const service = stubService()
    const first = vi.fn()
    const second = vi.fn()

    const releaseFirst = service.acquire(first)
    const releaseSecond = service.acquire(second)
    expect(service.consumerCount()).toBe(2)
    await vi.advanceTimersByTimeAsync(0)
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(1)

    await vi.advanceTimersByTimeAsync(USAGE_REFRESH_INTERVAL_MS)
    expect(first).toHaveBeenCalledTimes(2)
    expect(second).toHaveBeenCalledTimes(2)

    releaseFirst()
    expect(service.consumerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(USAGE_REFRESH_INTERVAL_MS)
    expect(first).toHaveBeenCalledTimes(2)
    expect(second).toHaveBeenCalledTimes(3)

    releaseSecond()
    expect(service.consumerCount()).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps the loop alive when consumers are released out of order and ignores double releases', async () => {
    vi.useFakeTimers()
    const service = stubService()
    const first = vi.fn()
    const second = vi.fn()

    const releaseFirst = service.acquire(first)
    const releaseSecond = service.acquire(second)
    await vi.advanceTimersByTimeAsync(0)

    releaseSecond()
    releaseSecond()
    expect(service.consumerCount()).toBe(1)
    expect(vi.getTimerCount()).toBe(1)

    releaseFirst()
    expect(service.consumerCount()).toBe(0)
    expect(vi.getTimerCount()).toBe(0)

    const third = vi.fn()
    service.acquire(third)
    await vi.advanceTimersByTimeAsync(0)
    expect(third).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(1)
  })

  it('records when the cached snapshot was last refreshed', async () => {
    let now = 5_000
    const service = stubService({ now: () => now })

    expect(service.lastUpdatedAt()).toBe(0)
    await service.refresh()
    expect(service.lastUpdatedAt()).toBe(5_000)

    now = 9_000
    await service.refresh()
    expect(service.lastUpdatedAt()).toBe(9_000)
  })
})
