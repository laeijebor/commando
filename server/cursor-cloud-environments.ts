import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { CURSOR_CLOUD_ENVIRONMENTS_ROUTE, isCursorEnvironmentName, type CursorCloudEnvironmentsResponse } from '../shared/cursor-cloud-agents.js'
import { normaliseGithubUrl } from './git-cursor-cloud.js'

type Dependencies = { fetch?: typeof fetch; loadKey?: () => Promise<string | undefined>; now?: () => number }

/** Keep credentials confined to this request boundary; never surface remote diagnostics. */
export async function loadCursorApiKey(): Promise<string | undefined> {
  if (process.env.CURSOR_API_KEY) return process.env.CURSOR_API_KEY
  try {
    const auth = JSON.parse(await readFile(join(homedir(), '.cursor/sdk/auth.json'), 'utf8'))
    if (typeof auth.apiKey !== 'string' || !auth.apiKey || (typeof auth.apiKeyExpiresAtMs === 'number' && auth.apiKeyExpiresAtMs <= Date.now())) return undefined
    return auth.apiKey
  } catch { return undefined }
}

export class CursorCloudEnvironmentsApi {
  private cache?: { at: number; value: CursorCloudEnvironmentsResponse }
  private flight?: Promise<CursorCloudEnvironmentsResponse>
  private lastFetch = -Infinity
  private readonly now: () => number
  constructor(private readonly dependencies: Dependencies = {}) { this.now = dependencies.now ?? Date.now }

  async handle(request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean> {
    if (url.pathname !== CURSOR_CLOUD_ENVIRONMENTS_ROUTE) return false
    const value = request.method === 'GET' ? await this.list(url.searchParams.get('refresh') === '1') : { error: 'Method not allowed' }
    response.writeHead(request.method === 'GET' ? 200 : 405, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
    response.end(JSON.stringify(value))
    return true
  }

  list(refresh = false): Promise<CursorCloudEnvironmentsResponse> {
    if (this.flight) return this.flight
    const ttl = this.cache?.value.login === 'ok' && !this.cache.value.error ? 300_000 : 5_000
    if (this.cache && ((!refresh && this.now() - this.cache.at < ttl) || (refresh && this.now() - this.lastFetch < 5_000))) return Promise.resolve(this.cache.value)
    this.lastFetch = this.now()
    this.flight = this.load().then((value) => {
      this.cache = { at: this.now(), value }
      return value
    }).finally(() => { this.flight = undefined })
    return this.flight
  }

  private async load(): Promise<CursorCloudEnvironmentsResponse> {
    try {
      const key = await (this.dependencies.loadKey ?? loadCursorApiKey)()
      if (!key) return { login: 'required', environments: [] }
      const environments: CursorCloudEnvironmentsResponse['environments'] = []
      let cursor: string | undefined
      const seen = new Set<string>()
      do {
        const url = new URL('https://api.cursor.com/v1/environments')
        if (cursor) url.searchParams.set('cursor', cursor)
        const response = await (this.dependencies.fetch ?? fetch)(url, {
          headers: { Authorization: `Bearer ${key}` }, redirect: 'error', signal: AbortSignal.timeout(15_000),
        })
        if (response.status === 401 || response.status === 403) return { login: 'required', environments: [] }
        if (!response.ok) throw new Error('Environment request failed')
        const page = await response.json() as { items: { id: string; name?: string; repos?: { url: string }[] }[]; nextCursor?: string }
        for (const item of page.items) {
          if (typeof item.id !== 'string' || !isCursorEnvironmentName(item.name)) continue
          environments.push({ id: item.id, name: item.name, repoUrls: (item.repos ?? []).flatMap(({ url }) => {
            const normalised = normaliseGithubUrl(url)
            return normalised ? [normalised] : []
          }) })
        }
        cursor = page.nextCursor
        if (cursor && (typeof cursor !== 'string' || seen.has(cursor))) throw new Error('Invalid environment cursor')
        if (cursor) seen.add(cursor)
      } while (cursor)
      return { login: 'ok', environments }
    } catch {
      return { login: 'ok', environments: [], error: 'Unable to load Cursor cloud environments. Refresh to retry.' }
    }
  }
}
