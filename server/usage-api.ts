import type { IncomingMessage, ServerResponse } from 'node:http'

import type { ProviderUsage } from '../shared/protocol.js'
import { USAGE_REFRESH_INTERVAL_MS } from './provider-usage.js'

const ROOT = '/api/usage'

/** The slice of {@link ProviderUsageService} this route needs. */
export type UsageApiService = {
  values: () => ProviderUsage[]
  lastUpdatedAt: () => number
  consumerCount: () => number
  refresh: () => Promise<ProviderUsage[]>
}

type UsageApiOptions = {
  now?: () => number
}

function json(response: ServerResponse, status: number, value: unknown): void {
  const body = `${JSON.stringify(value)}\n`
  response.writeHead(status, {
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
    'Content-Type': 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
  })
  response.end(body)
}

/**
 * `GET /api/usage` — the cached provider usage snapshot for owner clients.
 *
 * While a consumer (the companion hub or a watching `/ws` socket) drives the
 * refresh loop the cache is at most one interval old, so the route answers from
 * it. Without a consumer the cache goes stale, so a stale read triggers a single
 * refresh first; the refresh is bounded by the service's own request timeout.
 */
export async function handleUsageApi(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  service: UsageApiService,
  options: UsageApiOptions = {},
): Promise<boolean> {
  if (url.pathname !== ROOT) return false
  if (request.method !== 'GET') {
    response.setHeader('Allow', 'GET')
    json(response, 405, { error: 'Method not allowed' })
    return true
  }
  const now = options.now ?? Date.now
  const stale = now() - service.lastUpdatedAt() >= USAGE_REFRESH_INTERVAL_MS
  if (service.consumerCount() === 0 && stale) {
    try {
      await service.refresh()
    } catch (error) {
      console.error('[commando] usage refresh failed', error)
    }
  }
  json(response, 200, { usage: service.values(), updatedAt: service.lastUpdatedAt() })
  return true
}
