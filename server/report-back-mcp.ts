import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  isReportBackTaskStatus,
  REPORT_BACK_TASK_STATUSES,
  type ReportBackListenerStatus,
  type ReportBackTaskSnapshot,
  type ReportBackTokenInfo,
} from '../shared/report-back.js'
import { ReportBackStore, ReportBackStoreError } from './report-back-store.js'

export const REPORT_BACK_LOOPBACK_HOST = '127.0.0.1'
export const REPORT_BACK_MCP_PATH = '/mcp'
export const DEFAULT_REPORT_BACK_PORT = 4311
export const REPORT_BACK_MAX_BODY_BYTES = 64 * 1024
export const MCP_PROTOCOL_VERSION = '2025-03-26'

const BODY_READ_TIMEOUT_MS = 10_000
const BEARER_HEADER = /^Bearer\s+(\S+)$/i

const SECURITY_HEADERS = {
  'Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'none'",
  'X-Content-Type-Options': 'nosniff',
} as const

type JsonRpcId = string | number | null

type JsonRpcRequest = {
  jsonrpc: '2.0'
  id?: JsonRpcId
  method: string
  params?: unknown
}

export type ReportBackMcpAddress = {
  host: string
  port: number
  url: string
}

export type ReportBackMcpServerOptions = {
  store: ReportBackStore
  port?: number
  onTaskUpdated?: (task: ReportBackTaskSnapshot) => void
}

class HttpRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly headers?: Record<string, string>,
  ) {
    super(message)
    this.name = 'HttpRequestError'
  }
}

class JsonRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message)
    this.name = 'JsonRpcError'
  }
}

export const REPORT_BACK_MCP_TOOLS = [
  {
    name: 'post_update',
    description: 'Post a progress update for the current task to Commando.',
    inputSchema: {
      type: 'object',
      properties: {
        message: {
          type: 'string',
          description: 'Progress update text for the human owner.',
        },
      },
      required: ['message'],
      additionalProperties: false,
    },
  },
  {
    name: 'ask_user',
    description: 'Ask the human owner a question and mark the current task as waiting.',
    inputSchema: {
      type: 'object',
      properties: {
        question: {
          type: 'string',
          description: 'The question that needs an answer from the user.',
        },
      },
      required: ['question'],
      additionalProperties: false,
    },
  },
  {
    name: 'read_messages',
    description: 'Read queued human replies for the current task since an optional cursor.',
    inputSchema: {
      type: 'object',
      properties: {
        cursor: {
          type: 'string',
          description: 'Cursor returned by the previous read_messages call.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'set_status',
    description: 'Update the current task status and optional summary.',
    inputSchema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: [...REPORT_BACK_TASK_STATUSES],
          description: 'New status for the current task.',
        },
        summary: {
          type: 'string',
          description: 'Optional concise status summary.',
        },
      },
      required: ['status'],
      additionalProperties: false,
    },
  },
] as const

export function configuredReportBackPort(
  env: NodeJS.ProcessEnv = process.env,
  daemonPort = 4310,
  defaultDaemonPort = 4310,
): number | null {
  const configured = env.COMMANDO_REPORT_BACK_PORT
  if (configured !== undefined) {
    if (!/^\d+$/.test(configured)) {
      throw new Error('COMMANDO_REPORT_BACK_PORT must be an integer')
    }
    const port = Number(configured)
    if (port === 0) return null
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      throw new Error('COMMANDO_REPORT_BACK_PORT must be 0 or between 1 and 65535')
    }
    if (port === daemonPort) {
      throw new Error('COMMANDO_REPORT_BACK_PORT must differ from COMMANDO_PORT')
    }
    return port
  }
  if (daemonPort !== defaultDaemonPort) return null
  return DEFAULT_REPORT_BACK_PORT
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

function writeAccepted(response: ServerResponse): void {
  response.writeHead(202, {
    ...SECURITY_HEADERS,
    'Content-Length': 0,
  })
  response.end()
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function assertAllowedKeys(obj: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) {
      throw new JsonRpcError(-32602, `Unexpected parameter: ${key}`)
    }
  }
}

function extractBearerToken(request: IncomingMessage): string | null {
  const header = request.headers.authorization
  if (typeof header !== 'string') return null
  const match = BEARER_HEADER.exec(header.trim())
  return match?.[1] ?? null
}

async function readJsonBody(request: IncomingMessage): Promise<string> {
  const contentType = request.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase()
  if (contentType !== 'application/json') {
    throw new HttpRequestError(415, 'Content-Type must be application/json')
  }
  const declaredLength = Number(request.headers['content-length'] ?? 0)
  if (Number.isFinite(declaredLength) && declaredLength > REPORT_BACK_MAX_BODY_BYTES) {
    request.resume()
    throw new HttpRequestError(413, 'Request body exceeds 64 KiB')
  }

  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = []
    let bytes = 0

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
      bytes += buffer.length
      if (bytes > REPORT_BACK_MAX_BODY_BYTES) {
        request.resume()
        fail(new HttpRequestError(413, 'Request body exceeds 64 KiB'))
        return
      }
      chunks.push(buffer)
    }

    const onEnd = (): void => {
      cleanup()
      resolve(Buffer.concat(chunks).toString('utf8'))
    }

    const onError = (error: Error): void => fail(error)
    const onAborted = (): void => fail(new HttpRequestError(400, 'Incomplete request body'))

    const timer = setTimeout(() => {
      request.resume()
      fail(new HttpRequestError(408, 'Request body timed out'))
    }, BODY_READ_TIMEOUT_MS)
    timer.unref()

    request.on('data', onData)
    request.once('end', onEnd)
    request.once('error', onError)
    request.once('aborted', onAborted)
  })
}

function parseJsonRpcRequest(raw: string): JsonRpcRequest {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new JsonRpcError(-32700, 'Parse error')
  }
  if (!isPlainObject(parsed)) {
    throw new JsonRpcError(-32600, 'Invalid Request')
  }
  if (parsed.jsonrpc !== '2.0' || typeof parsed.method !== 'string' || parsed.method.length === 0) {
    throw new JsonRpcError(-32600, 'Invalid Request')
  }
  if (
    parsed.id !== undefined &&
    parsed.id !== null &&
    typeof parsed.id !== 'string' &&
    typeof parsed.id !== 'number'
  ) {
    throw new JsonRpcError(-32600, 'Invalid Request')
  }
  return {
    jsonrpc: '2.0',
    ...(parsed.id !== undefined ? { id: parsed.id } : {}),
    method: parsed.method,
    ...(parsed.params !== undefined ? { params: parsed.params } : {}),
  }
}

function formatToolResult(payload: Record<string, unknown>): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    structuredContent: payload,
  }
}

export class ReportBackMcpServer {
  private readonly store: ReportBackStore
  private readonly requestedPort: number
  private readonly onTaskUpdated?: (task: ReportBackTaskSnapshot) => void
  private server: Server | null = null
  private boundAddress: ReportBackMcpAddress | null = null

  constructor(options: ReportBackMcpServerOptions) {
    this.store = options.store
    this.requestedPort = options.port ?? DEFAULT_REPORT_BACK_PORT
    this.onTaskUpdated = options.onTaskUpdated
  }

  async start(): Promise<ReportBackMcpAddress> {
    if (this.boundAddress) return this.boundAddress
    const server = createServer((request, response) => {
      void this.handleRequest(request, response).catch((error: unknown) => {
        this.handleUnexpectedError(response, error)
      })
    })
    this.server = server

    return new Promise<ReportBackMcpAddress>((resolve, reject) => {
      const onError = (error: Error): void => {
        this.server = null
        reject(error)
      }
      server.once('error', onError)
      server.listen(this.requestedPort, REPORT_BACK_LOOPBACK_HOST, () => {
        server.off('error', onError)
        const info = server.address() as AddressInfo | null
        const port = info?.port ?? this.requestedPort
        this.boundAddress = {
          host: REPORT_BACK_LOOPBACK_HOST,
          port,
          url: `http://${REPORT_BACK_LOOPBACK_HOST}:${port}${REPORT_BACK_MCP_PATH}`,
        }
        resolve(this.boundAddress)
      })
    })
  }

  address(): ReportBackMcpAddress | null {
    return this.boundAddress ? { ...this.boundAddress } : null
  }

  listenerStatus(): ReportBackListenerStatus {
    if (!this.boundAddress) return { enabled: false }
    return {
      enabled: true,
      host: this.boundAddress.host,
      port: this.boundAddress.port,
      url: this.boundAddress.url,
    }
  }

  async close(): Promise<void> {
    const server = this.server
    this.server = null
    this.boundAddress = null
    if (!server) return
    await new Promise<void>((resolve) => {
      server.close(() => resolve())
      server.closeAllConnections?.()
    })
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    let url: URL
    try {
      url = new URL(request.url ?? '/', `http://${REPORT_BACK_LOOPBACK_HOST}`)
    } catch {
      writeJson(response, 400, { error: 'Invalid request URL' })
      return
    }

    if (url.pathname !== REPORT_BACK_MCP_PATH) {
      writeJson(response, 404, { error: 'Not found' })
      return
    }

    if (request.method !== 'POST') {
      writeJson(response, 405, { error: 'Method not allowed' }, { Allow: 'POST' })
      return
    }

    const bearer = extractBearerToken(request)
    const tokenInfo = bearer ? this.store.authenticate(bearer) : null
    if (!tokenInfo) {
      writeJson(
        response,
        401,
        { error: 'Unauthorized' },
        { 'WWW-Authenticate': 'Bearer realm="commando-report-back"' },
      )
      return
    }

    let rawBody: string
    try {
      rawBody = await readJsonBody(request)
    } catch (error) {
      if (error instanceof HttpRequestError) {
        writeJson(response, error.status, { error: error.message }, error.headers)
        return
      }
      throw error
    }

    let rpc: JsonRpcRequest
    try {
      rpc = parseJsonRpcRequest(rawBody)
    } catch (error) {
      if (error instanceof JsonRpcError) {
        writeJson(response, 400, {
          jsonrpc: '2.0',
          id: null,
          error: { code: error.code, message: error.message },
        })
        return
      }
      throw error
    }

    if (rpc.id === undefined) {
      // JSON-RPC notifications (including notifications/initialized) receive 202 Accepted.
      writeAccepted(response)
      return
    }

    try {
      const result = this.dispatchMethod(rpc.method, rpc.params, tokenInfo)
      writeJson(response, 200, { jsonrpc: '2.0', id: rpc.id, result })
    } catch (error) {
      if (error instanceof JsonRpcError) {
        writeJson(response, 200, {
          jsonrpc: '2.0',
          id: rpc.id,
          error: { code: error.code, message: error.message },
        })
        return
      }
      if (error instanceof ReportBackStoreError && error.status === 400) {
        writeJson(response, 200, {
          jsonrpc: '2.0',
          id: rpc.id,
          error: { code: -32602, message: error.message },
        })
        return
      }
      writeJson(response, 200, {
        jsonrpc: '2.0',
        id: rpc.id,
        error: { code: -32603, message: 'Internal error' },
      })
    }
  }

  private dispatchMethod(
    method: string,
    params: unknown,
    tokenInfo: ReportBackTokenInfo,
  ): Record<string, unknown> {
    switch (method) {
      case 'initialize':
        return {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: 'commando-report-back', version: '1.0.0' },
        }
      case 'ping':
        return {}
      case 'tools/list':
        return { tools: REPORT_BACK_MCP_TOOLS }
      case 'tools/call':
        return this.dispatchToolCall(params, tokenInfo)
      default:
        throw new JsonRpcError(-32601, `Method not found: ${method}`)
    }
  }

  private dispatchToolCall(
    params: unknown,
    tokenInfo: ReportBackTokenInfo,
  ): Record<string, unknown> {
    if (!isPlainObject(params) || typeof params.name !== 'string') {
      throw new JsonRpcError(-32602, 'tools/call requires a tool name')
    }
    const rawArgs = params.arguments ?? {}
    if (!isPlainObject(rawArgs)) {
      throw new JsonRpcError(-32602, 'Tool arguments must be an object')
    }

    switch (params.name) {
      case 'post_update':
        return this.callPostUpdate(rawArgs, tokenInfo)
      case 'ask_user':
        return this.callAskUser(rawArgs, tokenInfo)
      case 'read_messages':
        return this.callReadMessages(rawArgs, tokenInfo)
      case 'set_status':
        return this.callSetStatus(rawArgs, tokenInfo)
      default:
        throw new JsonRpcError(-32602, `Unknown tool: ${params.name}`)
    }
  }

  private callPostUpdate(
    args: Record<string, unknown>,
    tokenInfo: ReportBackTokenInfo,
  ): Record<string, unknown> {
    assertAllowedKeys(args, ['message'])
    if (typeof args.message !== 'string') {
      throw new JsonRpcError(-32602, 'post_update requires a string message')
    }
    const { event, task } = this.store.postUpdate(tokenInfo.taskId, args.message, {
      label: tokenInfo.label,
    })
    this.onTaskUpdated?.(task)
    return formatToolResult({
      ok: true,
      taskId: task.taskId,
      eventId: event.id,
      updatedAt: task.updatedAt,
    })
  }

  private callAskUser(
    args: Record<string, unknown>,
    tokenInfo: ReportBackTokenInfo,
  ): Record<string, unknown> {
    assertAllowedKeys(args, ['question'])
    if (typeof args.question !== 'string') {
      throw new JsonRpcError(-32602, 'ask_user requires a string question')
    }
    const { questionId, task } = this.store.askUser(tokenInfo.taskId, args.question, {
      label: tokenInfo.label,
    })
    this.onTaskUpdated?.(task)
    return formatToolResult({
      questionId,
      taskId: task.taskId,
      status: task.status,
    })
  }

  private callReadMessages(
    args: Record<string, unknown>,
    tokenInfo: ReportBackTokenInfo,
  ): Record<string, unknown> {
    assertAllowedKeys(args, ['cursor'])
    if (args.cursor !== undefined && typeof args.cursor !== 'string') {
      throw new JsonRpcError(-32602, 'read_messages cursor must be a string')
    }
    const result = this.store.readMessages(tokenInfo.taskId, args.cursor)
    return formatToolResult({
      taskId: tokenInfo.taskId,
      messages: result.messages,
      nextCursor: result.nextCursor,
    })
  }

  private callSetStatus(
    args: Record<string, unknown>,
    tokenInfo: ReportBackTokenInfo,
  ): Record<string, unknown> {
    assertAllowedKeys(args, ['status', 'summary'])
    if (!isReportBackTaskStatus(args.status)) {
      throw new JsonRpcError(-32602, 'set_status requires a valid status')
    }
    if (args.summary !== undefined && typeof args.summary !== 'string') {
      throw new JsonRpcError(-32602, 'set_status summary must be a string')
    }
    const { task } = this.store.setStatus(tokenInfo.taskId, args.status, args.summary, {
      label: tokenInfo.label,
    })
    this.onTaskUpdated?.(task)
    return formatToolResult({
      ok: true,
      taskId: task.taskId,
      status: task.status,
      ...(task.summary !== undefined ? { summary: task.summary } : {}),
      updatedAt: task.updatedAt,
    })
  }

  private handleUnexpectedError(response: ServerResponse, _error: unknown): void {
    if (response.destroyed) return
    if (response.headersSent) {
      response.destroy()
      return
    }
    writeJson(response, 500, { error: 'Internal server error' })
  }
}
