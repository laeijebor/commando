import type { IncomingMessage, ServerResponse } from 'node:http'
import { isCommandoTargetId } from '../shared/pane-target.js'
import { isTrackedProcessKey } from '../shared/tracked-processes.js'
import { TrackedProcessScopeError, type ProcessTracker } from './tracked-processes.js'

const API_ROOT = '/api/tracked-processes'
const MAX_REQUEST_BYTES = 16 * 1024
export const MAX_PROCESS_KEYS = 256

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

function writeJson(response: ServerResponse, status: number, value: unknown): void {
  const body = `${JSON.stringify(value)}\n`
  response.writeHead(status, {
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
    'Content-Type': 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
  })
  response.end(body)
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const contentType = request.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase()
  if (contentType !== 'application/json') throw new HttpError(415, 'Content-Type must be application/json')
  const chunks: Buffer[] = []
  let byteLength = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    byteLength += buffer.length
    if (byteLength > MAX_REQUEST_BYTES) throw new HttpError(413, 'Request body is too large')
    chunks.push(buffer)
  }
  let value: unknown
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown }
  catch { throw new HttpError(400, 'Request body is not valid JSON') }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new HttpError(400, 'Request body must be a JSON object')
  return value as Record<string, unknown>
}

/** A list of tracked process keys, as sent to stop processes; null when it is not one. */
export function parseProcessKeys(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > MAX_PROCESS_KEYS || !value.every(isTrackedProcessKey)) return null
  return [...new Set(value)]
}

export function isTrackedProcessesPath(pathname: string): boolean {
  return pathname === API_ROOT || pathname.startsWith(`${API_ROOT}/`)
}

/** Lists the processes started from panes and stops them on request. Auth is the caller's. */
export class TrackedProcessesApi {
  constructor(private readonly tracker: Pick<ProcessTracker, 'list' | 'stop'>) {}

  async handle(request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean> {
    if (!isTrackedProcessesPath(url.pathname)) return false
    try {
      if (url.pathname === API_ROOT) {
        if (request.method !== 'GET') throw new HttpError(405, 'Method not allowed')
        const processes = await this.tracker.list(url.searchParams.get('fresh') === '1' ? 0 : undefined)
        writeJson(response, 200, { processes })
        return true
      }
      if (url.pathname !== `${API_ROOT}/stop`) throw new HttpError(404, 'Not found')
      if (request.method !== 'POST') throw new HttpError(405, 'Method not allowed')
      const body = await readJson(request)
      const keys = parseProcessKeys(body.keys)
      if (!keys?.length) throw new HttpError(400, 'keys must list up to 256 process keys')
      if (body.targetId !== undefined && !isCommandoTargetId(body.targetId)) throw new HttpError(400, 'Invalid targetId')
      const result = await this.tracker.stop(keys, body.targetId === undefined ? undefined : (process) => process.targetId === body.targetId)
      const killed = await result.finished
      writeJson(response, 200, { stopped: result.stopped.map(({ key }) => key), missing: result.missing, failed: result.failed, killed })
      return true
    } catch (error) {
      if (error instanceof HttpError) {
        if (error.status === 405) response.setHeader('Allow', url.pathname === API_ROOT ? 'GET' : 'POST')
        writeJson(response, error.status, { error: error.message })
      } else if (error instanceof TrackedProcessScopeError) {
        writeJson(response, 409, { error: error.message })
      } else {
        writeJson(response, 502, { error: error instanceof Error ? error.message : 'Process action failed' })
      }
      return true
    }
  }
}
