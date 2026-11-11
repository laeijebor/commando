import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { dirname } from 'node:path'
import {
  applyDiffFiltersChange,
  DEFAULT_DIFF_FILTERS,
  parseDiffFilters,
  parseDiffFiltersChange,
  type DiffFilters,
} from '../shared/diff-filters.js'
import { defaultSessionBriefStatePath } from './session-briefs.js'

const ROUTE = '/api/diff-filters'

export function defaultDiffFiltersPath(): string { return `${defaultSessionBriefStatePath()}.diff-filters.json` }

function writeJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
  response.end(JSON.stringify(value))
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  if (!/^application\/json\b/i.test(request.headers['content-type'] ?? '')) throw new Error('Expected application/json')
  let bytes = 0
  const chunks: Buffer[] = []
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytes += buffer.length
    if (bytes > 256 * 1024) throw new Error('Request body too large')
    chunks.push(buffer)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new Error('Invalid JSON') }
}

/** The hide-tests / hide-generated switches and per-repo generated patterns, shared by every window. */
export class DiffFiltersStore {
  private filters: DiffFilters = DEFAULT_DIFF_FILTERS
  private writes: Promise<unknown> = Promise.resolve()
  constructor(private readonly options: { path?: string; changed: (filters: DiffFilters) => void }) {}
  private get path(): string { return this.options.path ?? defaultDiffFiltersPath() }

  get(): DiffFilters { return this.filters }

  async load(): Promise<void> {
    try { this.filters = parseDiffFilters(JSON.parse(await readFile(this.path, 'utf8'))) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.error(`[commando] Could not load diff filters from ${this.path}`, error)
    }
  }

  /** Applies a change (already parsed) and saves it; changes are written one at a time. */
  update(change: Parameters<typeof applyDiffFiltersChange>[1]): Promise<DiffFilters> {
    const write = this.writes.then(async () => {
      const next = applyDiffFiltersChange(this.filters, change)
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
      const tmp = `${this.path}.${randomUUID()}.tmp`
      try {
        await writeFile(tmp, JSON.stringify(next), { mode: 0o600, flag: 'wx' })
        await rename(tmp, this.path)
      } finally { await rm(tmp, { force: true }) }
      this.filters = next
      this.options.changed(next)
      return next
    })
    this.writes = write.catch(() => {})
    return write
  }

  /** GET and PUT /api/diff-filters; the caller has already checked owner authorization. */
  async handle(request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean> {
    if (url.pathname !== ROUTE) return false
    if (request.method === 'GET') {
      writeJson(response, 200, { ok: true, filters: this.filters })
      return true
    }
    if (request.method !== 'PUT') {
      response.writeHead(405, { Allow: 'GET, PUT' })
      response.end()
      return true
    }
    let change
    try {
      change = parseDiffFiltersChange(await readBody(request))
      applyDiffFiltersChange(this.filters, change) // Rejects a change that can't apply (too many repos) as a 400.
    }
    catch (error) {
      writeJson(response, 400, { ok: false, error: error instanceof Error ? error.message : 'Invalid diff filters' })
      return true
    }
    try { writeJson(response, 200, { ok: true, filters: await this.update(change) }) }
    catch (error) {
      console.error('[commando] Could not save diff filters', error)
      writeJson(response, 500, { ok: false, error: error instanceof Error ? error.message : 'Could not save diff filters' })
    }
    return true
  }
}
