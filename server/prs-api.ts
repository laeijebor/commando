import type { IncomingMessage, ServerResponse } from 'node:http'
import { PrService, PrServiceError } from './prs.js'
import { validateTmuxPaneId } from './tmux-pane-actions.js'

const ROOT = '/api/prs'
const MAX_BODY_BYTES = 64 * 1024

type PrsApiDependencies = {
  panePath: (paneId: string) => string | undefined
  paneTargetId: (paneId: string) => string | undefined
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

async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  if (request.headers['content-type']?.split(';', 1)[0]?.trim() !== 'application/json') {
    throw new PrServiceError(415, 'invalid_request', 'Content-Type must be application/json')
  }
  const chunks: Buffer[] = []
  let length = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    length += buffer.length
    if (length > MAX_BODY_BYTES) {
      throw new PrServiceError(413, 'invalid_request', 'Request body is too large')
    }
    chunks.push(buffer)
  }
  let value: unknown
  try {
    value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  } catch {
    throw new PrServiceError(400, 'invalid_request', 'Request body is not valid JSON')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new PrServiceError(400, 'invalid_request', 'Request body must be an object')
  }
  return value as Record<string, unknown>
}

export async function handlePrsApi(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  service: PrService,
  dependencies: PrsApiDependencies,
): Promise<boolean> {
  if (url.pathname !== ROOT && !url.pathname.startsWith(`${ROOT}/`)) return false
  const path = url.pathname.slice(ROOT.length).split('/').filter(Boolean).map(decodeURIComponent)

  try {
    if (path.length === 0) {
      if (request.method !== 'GET') {
        response.setHeader('Allow', 'GET')
        json(response, 405, { error: 'Method not allowed' })
        return true
      }
      const refresh = url.searchParams.get('refresh')
      if (refresh !== null && refresh !== '1') {
        throw new PrServiceError(400, 'invalid_request', 'Refresh must be 1')
      }
      json(response, 200, {
        list: await service.listPullRequests(
          url.searchParams.get('repo'),
          url.searchParams.get('state'),
          { refresh: refresh === '1' },
        ),
      })
      return true
    }

    if (path.length === 1 && path[0] === 'threads') {
      if (request.method !== 'GET') {
        response.setHeader('Allow', 'GET')
        json(response, 405, { error: 'Method not allowed' })
        return true
      }
      json(response, 200, {
        threads: await service.listUnresolvedThreads(url.searchParams.get('repo'), url.searchParams.get('number')),
      })
      return true
    }

    if (path.length === 1 && path[0] === 'pane') {
      if (request.method !== 'GET') {
        response.setHeader('Allow', 'GET')
        json(response, 405, { error: 'Method not allowed' })
        return true
      }
      let paneId: string
      try {
        paneId = validateTmuxPaneId(url.searchParams.get('paneId'))
      } catch {
        throw new PrServiceError(400, 'invalid_request', 'Invalid tmux pane id')
      }
      const targetId = dependencies.paneTargetId(paneId)
      if (!targetId) throw new PrServiceError(404, 'pane_not_found', 'Tmux pane does not exist')
      json(response, 200, { list: await service.listPanePullRequests(targetId) })
      return true
    }

    if (path.length === 1 && path[0] === 'repos') {
      if (request.method !== 'GET') {
        response.setHeader('Allow', 'GET')
        json(response, 405, { error: 'Method not allowed' })
        return true
      }
      json(response, 200, { repos: await service.listRepos() })
      return true
    }

    if (path.length === 1 && path[0] === 'repo') {
      if (request.method !== 'GET') {
        response.setHeader('Allow', 'GET')
        json(response, 405, { error: 'Method not allowed' })
        return true
      }
      let paneId: string
      try {
        paneId = validateTmuxPaneId(url.searchParams.get('paneId'))
      } catch {
        throw new PrServiceError(400, 'invalid_request', 'Invalid tmux pane id')
      }
      const panePath = dependencies.panePath(paneId)
      if (!panePath) throw new PrServiceError(404, 'pane_not_found', 'Tmux pane does not exist')
      json(response, 200, { repo: await service.repoForPath(panePath) })
      return true
    }

    if (path.length === 1 && path[0] === 'prefs') {
      if (request.method === 'GET') {
        json(response, 200, { prefs: await service.getPreferences() })
      } else if (request.method === 'PUT') {
        json(response, 200, { prefs: await service.updatePreferences(await readBody(request)) })
      } else {
        response.setHeader('Allow', 'GET, PUT')
        json(response, 405, { error: 'Method not allowed' })
      }
      return true
    }

    json(response, 404, { error: 'Not found' })
  } catch (error) {
    if (error instanceof PrServiceError) {
      json(response, error.status, { error: error.message, code: error.code })
    } else {
      console.error('[commando] PR request failed', error)
      json(response, 500, { error: 'PR request failed', code: 'internal_error' })
    }
  }
  return true
}
