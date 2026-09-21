import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ProviderUsage } from '../shared/protocol.js'
import { USAGE_REFRESH_INTERVAL_MS } from './provider-usage.js'
import { handleUsageApi, type UsageApiService } from './usage-api.js'

const servers: Server[] = []

const USAGE: ProviderUsage[] = [
  {
    provider: 'claude',
    state: 'available',
    windows: [{ label: '5h', usedPercent: 20, remainingPercent: 80 }],
    updatedAt: 1_000,
  },
]

function usageService(overrides: Partial<UsageApiService> = {}): UsageApiService {
  return {
    values: () => USAGE,
    lastUpdatedAt: () => 1_000,
    consumerCount: () => 0,
    refresh: vi.fn(async () => USAGE),
    ...overrides,
  }
}

async function startApi(service: UsageApiService, now: () => number): Promise<string> {
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? '/', 'http://localhost')
      if (!(await handleUsageApi(request, response, url, service, { now }))) {
        response.writeHead(404)
        response.end()
      }
    })()
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return `http://127.0.0.1:${port}`
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(
    (server) => new Promise((resolve) => server.close(resolve)),
  ))
})

describe('usage API', () => {
  it('serves the cached snapshot without refreshing while a consumer is active', async () => {
    const refresh = vi.fn(async () => USAGE)
    const base = await startApi(
      usageService({ consumerCount: () => 1, refresh }),
      () => 1_000 + USAGE_REFRESH_INTERVAL_MS * 10,
    )

    const response = await fetch(`${base}/api/usage`)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ usage: USAGE, updatedAt: 1_000 })
    expect(refresh).not.toHaveBeenCalled()
  })

  it('serves the cached snapshot when no consumer is active but the cache is fresh', async () => {
    const refresh = vi.fn(async () => USAGE)
    const base = await startApi(usageService({ refresh }), () => 1_000 + USAGE_REFRESH_INTERVAL_MS - 1)

    const response = await fetch(`${base}/api/usage`)

    expect(response.status).toBe(200)
    expect(refresh).not.toHaveBeenCalled()
  })

  it('refreshes once before responding when nobody drives the loop and the cache is stale', async () => {
    let updatedAt = 1_000
    const refresh = vi.fn(async () => {
      updatedAt = 99_000
      return USAGE
    })
    const base = await startApi(
      usageService({ refresh, lastUpdatedAt: () => updatedAt }),
      () => 1_000 + USAGE_REFRESH_INTERVAL_MS,
    )

    const response = await fetch(`${base}/api/usage`)

    expect(refresh).toHaveBeenCalledTimes(1)
    await expect(response.json()).resolves.toEqual({ usage: USAGE, updatedAt: 99_000 })
  })

  it('still answers from the cache when the refresh fails', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const base = await startApi(
      usageService({ refresh: vi.fn(async () => { throw new Error('offline') }) }),
      () => 1_000 + USAGE_REFRESH_INTERVAL_MS,
    )

    const response = await fetch(`${base}/api/usage`)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ usage: USAGE, updatedAt: 1_000 })
    error.mockRestore()
  })

  it('rejects non-GET methods and ignores other paths', async () => {
    const base = await startApi(usageService({ consumerCount: () => 1 }), () => 1_000)

    const posted = await fetch(`${base}/api/usage`, { method: 'POST' })
    expect(posted.status).toBe(405)
    expect(posted.headers.get('allow')).toBe('GET')

    const other = await fetch(`${base}/api/usage/extra`)
    expect(other.status).toBe(404)
  })
})
