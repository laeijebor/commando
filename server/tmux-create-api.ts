import type { IncomingMessage, ServerResponse } from 'node:http'
import { TmuxCreateCommandError, TmuxCreator } from './tmux-create.js'

const ROOT = '/api/tmux'
const MAX_BODY_BYTES = 16 * 1024

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

async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  if (request.headers['content-type']?.split(';', 1)[0]?.trim() !== 'application/json') {
    throw new Error('Content-Type must be application/json')
  }
  const chunks: Buffer[] = []
  let length = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    length += buffer.length
    if (length > MAX_BODY_BYTES) throw new Error('Request body is too large')
    chunks.push(buffer)
  }
  let value: unknown
  try {
    value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  } catch {
    throw new Error('Request body is not valid JSON')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Request body must be an object')
  }
  return value as Record<string, unknown>
}

export async function handleTmuxCreateApi(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  creator: TmuxCreator,
  beforePaneCreated: (targetId: string) => Promise<void>,
  onCreated: () => Promise<void>,
): Promise<boolean> {
  if (!url.pathname.startsWith(`${ROOT}/`)) return false
  if (request.method !== 'POST') {
    response.setHeader('Allow', 'POST')
    json(response, 405, { error: 'Method not allowed' })
    return true
  }

  try {
    const input = await body(request)
    let created = null
    if (url.pathname === `${ROOT}/sessions`) {
      created = await creator.createSession(input as never)
    } else if (url.pathname === `${ROOT}/windows`) {
      created = await creator.createWindow(input as never)
    } else if (url.pathname === `${ROOT}/panes`) {
      const targetId = input.targetId
      if (typeof targetId !== 'string') throw new Error('Invalid tmux window or pane id')
      created = await creator.createPane(input as never, () => beforePaneCreated(targetId))
    }
    if (!created) {
      json(response, 404, { error: 'Not found' })
      return true
    }
    await onCreated()
    json(response, 201, { created })
  } catch (error) {
    const status = error instanceof TmuxCreateCommandError ? 502 : 400
    json(response, status, {
      error: error instanceof Error ? error.message : 'Unable to create tmux target',
    })
  }
  return true
}
