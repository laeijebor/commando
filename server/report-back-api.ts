import type { IncomingMessage, ServerResponse } from 'node:http'
import type {
  ReportBackFunnelStatus,
  ReportBackListenerStatus,
  ReportBackStatus,
  ReportBackTaskSnapshot,
} from '../shared/report-back.js'
import { ReportBackStore, ReportBackStoreError } from './report-back-store.js'

const ROUTE_ROOT = '/api/report-back'
const MAX_BODY_BYTES = 64 * 1024
const BODY_READ_TIMEOUT_MS = 10_000
const MAX_PATH_LENGTH = 1_024

const SECURITY_HEADERS = {
  'Cache-Control': 'no-store',
  'Content-Security-Policy': "sandbox; default-src 'none'",
  'X-Content-Type-Options': 'nosniff',
} as const

export type ReportBackOwnerAuthorization = (
  request: IncomingMessage,
  url: URL,
) => Promise<boolean>

export type ReportBackApiOptions = {
  store: ReportBackStore
  ownerAuthorized: ReportBackOwnerAuthorization
  listenerStatus: () => ReportBackListenerStatus
  funnelStatus: () => Promise<ReportBackFunnelStatus>
  onTaskUpdated?: (task: ReportBackTaskSnapshot) => void
}

class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly headers?: Record<string, string>,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

function writeJson(
  response: ServerResponse,
  status: number,
  body: unknown,
  extraHeaders?: Record<string, string>,
): void {
  const payload = `${JSON.stringify(body)}\n`
  response.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Length': Buffer.byteLength(payload),
    'Content-Type': 'application/json; charset=utf-8',
    ...extraHeaders,
  })
  response.end(payload)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function assertAllowedKeys(body: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) {
      throw new ApiError(400, 'invalid_request', `Unexpected field: ${key}`)
    }
  }
}

async function readJsonObject(request: IncomingMessage): Promise<Record<string, unknown>> {
  const contentType = request.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase()
  if (contentType !== 'application/json') {
    throw new ApiError(415, 'unsupported_media_type', 'Content-Type must be application/json')
  }
  const declaredLength = Number(request.headers['content-length'] ?? 0)
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    request.resume()
    throw new ApiError(413, 'body_too_large', 'Request body exceeds 64 KiB')
  }

  const raw = await new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0

    const cleanup = (): void => {
      clearTimeout(timer)
      request.off('data', onData)
      request.off('end', onEnd)
      request.off('error', onError)
      request.off('aborted', onAborted)
    }

    const fail = (error: Error): void => {
      cleanup()
      reject(error)
    }

    const onData = (chunk: Buffer | string): void => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      size += buffer.length
      if (size > MAX_BODY_BYTES) {
        request.resume()
        fail(new ApiError(413, 'body_too_large', 'Request body exceeds 64 KiB'))
        return
      }
      chunks.push(buffer)
    }

    const onEnd = (): void => {
      cleanup()
      resolve(Buffer.concat(chunks).toString('utf8'))
    }

    const onError = (error: Error): void => fail(error)
    const onAborted = (): void => fail(new ApiError(400, 'invalid_json', 'Incomplete request body'))

    const timer = setTimeout(() => {
      request.resume()
      fail(new ApiError(408, 'timeout', 'Request body timed out'))
    }, BODY_READ_TIMEOUT_MS)
    timer.unref()

    request.on('data', onData)
    request.once('end', onEnd)
    request.once('error', onError)
    request.once('aborted', onAborted)
  })

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new ApiError(400, 'invalid_json', 'Invalid JSON body')
  }
  if (!isPlainObject(parsed)) {
    throw new ApiError(400, 'invalid_request', 'Expected a JSON object')
  }
  return parsed
}

function decodeRouteSegments(pathname: string): string[] {
  if (pathname.length > MAX_PATH_LENGTH) {
    throw new ApiError(400, 'invalid_request', 'Route is too long')
  }
  const suffix = pathname.slice(ROUTE_ROOT.length)
  if (!suffix || suffix === '/') return []
  const rawSegments = suffix.split('/').filter(Boolean)
  try {
    return rawSegments.map(decodeURIComponent)
  } catch {
    throw new ApiError(400, 'invalid_request', 'Invalid route encoding')
  }
}

function assertMethod(method: string | undefined, allowed: readonly string[]): void {
  if (method && allowed.includes(method)) return
  throw new ApiError(405, 'method_not_allowed', `Use ${allowed.join(' or ')}`, {
    Allow: allowed.join(', '),
  })
}

export class ReportBackApi {
  private readonly store: ReportBackStore
  private readonly ownerAuthorized: ReportBackOwnerAuthorization
  private readonly listenerStatus: () => ReportBackListenerStatus
  private readonly funnelStatus: () => Promise<ReportBackFunnelStatus>
  private readonly onTaskUpdated?: (task: ReportBackTaskSnapshot) => void

  constructor(options: ReportBackApiOptions) {
    this.store = options.store
    this.ownerAuthorized = options.ownerAuthorized
    this.listenerStatus = options.listenerStatus
    this.funnelStatus = options.funnelStatus
    this.onTaskUpdated = options.onTaskUpdated
  }

  async handle(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
  ): Promise<boolean> {
    if (url.pathname !== ROUTE_ROOT && !url.pathname.startsWith(`${ROUTE_ROOT}/`)) {
      return false
    }

    try {
      if (!(await this.ownerAuthorized(request, url))) {
        throw new ApiError(401, 'unauthorized', 'Owner authorization required', {
          'WWW-Authenticate': 'Bearer realm="commando"',
        })
      }

      const segments = decodeRouteSegments(url.pathname)
      await this.dispatch(request, response, segments)
    } catch (error) {
      this.writeFailure(response, error)
    }
    return true
  }

  private async dispatch(
    request: IncomingMessage,
    response: ServerResponse,
    segments: string[],
  ): Promise<void> {
    const method = request.method

    if (segments.length === 1 && segments[0] === 'status') {
      assertMethod(method, ['GET'])
      const status: ReportBackStatus = {
        listener: this.listenerStatus(),
        funnel: await this.funnelStatus(),
      }
      writeJson(response, 200, status)
      return
    }

    if (segments.length === 1 && segments[0] === 'tasks') {
      assertMethod(method, ['GET'])
      writeJson(response, 200, { tasks: this.store.listTasks() })
      return
    }

    if (segments.length === 1 && segments[0] === 'tokens') {
      assertMethod(method, ['GET', 'POST'])
      if (method === 'GET') {
        writeJson(response, 200, { tokens: this.store.listTokens() })
        return
      }
      const body = await readJsonObject(request)
      assertAllowedKeys(body, ['taskId', 'label', 'ttlSeconds'])
      if (typeof body.taskId !== 'string') {
        throw new ApiError(400, 'invalid_task_id', 'taskId must be a string')
      }
      let ttlMs: number | undefined
      if (body.ttlSeconds !== undefined) {
        if (typeof body.ttlSeconds !== 'number' || !Number.isFinite(body.ttlSeconds) || body.ttlSeconds <= 0) {
          throw new ApiError(400, 'invalid_ttl', 'ttlSeconds must be a positive number')
        }
        ttlMs = Math.round(body.ttlSeconds * 1_000)
      }
      const minted = this.store.mintToken({
        taskId: body.taskId,
        ...(body.label !== undefined ? { label: body.label as string } : {}),
        ...(ttlMs !== undefined ? { ttlMs } : {}),
      })
      writeJson(response, 201, minted)
      return
    }

    if (segments.length === 2 && segments[0] === 'tokens') {
      assertMethod(method, ['DELETE'])
      const tokenId = segments[1]
      const revoked = this.store.revokeToken(tokenId)
      if (!revoked) {
        throw new ApiError(404, 'not_found', 'Token not found')
      }
      writeJson(response, 200, { token: revoked })
      return
    }

    if (segments.length === 3 && segments[0] === 'tasks' && segments[2] === 'messages') {
      assertMethod(method, ['POST'])
      const taskId = segments[1]
      const body = await readJsonObject(request)
      assertAllowedKeys(body, ['message'])
      if (typeof body.message !== 'string') {
        throw new ApiError(400, 'invalid_message', 'message must be a string')
      }
      const result = this.store.postHumanReply(taskId, body.message)
      this.onTaskUpdated?.(result.task)
      writeJson(response, 201, { reply: result.reply, task: result.task })
      return
    }

    throw new ApiError(404, 'not_found', 'Report-back route does not exist')
  }

  private writeFailure(response: ServerResponse, error: unknown): void {
    if (response.destroyed) return
    if (response.headersSent) {
      response.destroy()
      return
    }
    if (error instanceof ApiError) {
      writeJson(response, error.status, { error: error.message, code: error.code }, error.headers)
      return
    }
    if (error instanceof ReportBackStoreError) {
      writeJson(response, error.status, { error: error.message, code: error.code })
      return
    }
    writeJson(response, 500, { error: 'Report-back request failed', code: 'internal_error' })
  }
}
