import type { IncomingMessage, ServerResponse } from 'node:http'
import { LinearService, LinearServiceError } from './linear.js'

const ROOT = '/api/linear'
const MAX_BODY_BYTES = 64 * 1024

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

async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  if (request.headers['content-type']?.split(';', 1)[0]?.trim() !== 'application/json') {
    throw new LinearServiceError(415, 'invalid_request', 'Content-Type must be application/json')
  }
  const chunks: Buffer[] = []
  let length = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    length += buffer.length
    if (length > MAX_BODY_BYTES) {
      throw new LinearServiceError(413, 'invalid_request', 'Request body is too large')
    }
    chunks.push(buffer)
  }
  let value: unknown
  try {
    value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  } catch {
    throw new LinearServiceError(400, 'invalid_request', 'Request body is not valid JSON')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new LinearServiceError(400, 'invalid_request', 'Request body must be an object')
  }
  return value as Record<string, unknown>
}

function segments(pathname: string): string[] {
  return pathname.slice(ROOT.length).split('/').filter(Boolean).map((value) => decodeURIComponent(value))
}

export async function handleLinearApi(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  service: LinearService,
): Promise<boolean> {
  if (url.pathname !== ROOT && !url.pathname.startsWith(`${ROOT}/`)) return false
  const path = segments(url.pathname)

  try {
    if (path.length === 1 && path[0] === 'accounts') {
      if (request.method === 'GET') json(response, 200, { accounts: await service.listAccounts() })
      else if (request.method === 'POST') {
        const input = await readBody(request)
        json(response, 201, { account: await service.connectAccount(input.label, input.apiKey) })
      } else {
        response.setHeader('Allow', 'GET, POST')
        json(response, 405, { error: 'Method not allowed' })
      }
      return true
    }

    const accountId = path[1]
    if (path[0] !== 'accounts' || !accountId) {
      json(response, 404, { error: 'Not found' })
      return true
    }
    if (path.length === 2 && request.method === 'DELETE') {
      await service.removeAccount(accountId)
      response.writeHead(204, { 'Cache-Control': 'no-store' })
      response.end()
      return true
    }
    if (path.length === 3 && path[2] === 'projects' && request.method === 'GET') {
      json(response, 200, await service.listProjects(accountId))
      return true
    }
    if (path.length === 5 && path[2] === 'projects' && path[4] === 'board' && request.method === 'GET') {
      json(response, 200, { board: await service.getBoard(accountId, path[3]) })
      return true
    }
    if (path.length >= 4 && path[2] === 'issues') {
      const issueId = path[3]
      if (path.length === 4 && request.method === 'GET') {
        json(response, 200, { issue: await service.getIssue(accountId, issueId) })
        return true
      }
      if (path.length === 5 && path[4] === 'state' && request.method === 'PATCH') {
        const input = await readBody(request)
        json(response, 200, { issue: await service.updateIssueState(accountId, issueId, input.stateId) })
        return true
      }
      if (path.length === 5 && path[4] === 'comments' && request.method === 'POST') {
        const input = await readBody(request)
        json(response, 201, {
          comment: await service.createComment(accountId, issueId, input.body, input.parentId),
        })
        return true
      }
    }
    json(response, 404, { error: 'Not found' })
  } catch (error) {
    if (error instanceof LinearServiceError) {
      json(response, error.status, { error: error.message, code: error.code })
    } else {
      console.error('[commando] Linear request failed', error)
      json(response, 500, { error: 'Linear request failed', code: 'internal_error' })
    }
  }
  return true
}
