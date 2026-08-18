import { createHash, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'

import { formatCommandoPrMarker } from '../shared/pane-target.js'

const API_PATH = '/api/pane-target-marker'
const PANE_ID = /^%\d+$/

type PaneTargetApiDependencies = {
  token: string
  paneTarget: (paneId: string) => { targetId: string } | null
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest()
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

export class PaneTargetApi {
  private readonly tokenDigest: Buffer

  constructor(private readonly dependencies: PaneTargetApiDependencies) {
    if (dependencies.token.length < 32) throw new Error('Agent hook token must contain at least 32 characters')
    this.tokenDigest = digest(dependencies.token)
  }

  handle(request: IncomingMessage, response: ServerResponse, url: URL): boolean {
    if (url.pathname !== API_PATH) return false
    const candidate = /^Bearer\s+([^\s]+)$/i.exec(request.headers.authorization ?? '')?.[1]
    if (
      !candidate ||
      candidate.length > 1_024 ||
      !timingSafeEqual(digest(candidate), this.tokenDigest)
    ) {
      response.setHeader('WWW-Authenticate', 'Bearer realm="commando-agent-hooks"')
      writeJson(response, 401, { error: 'Unauthorized' })
      return true
    }
    if (request.method !== 'GET') {
      response.setHeader('Allow', 'GET')
      writeJson(response, 405, { error: 'Method not allowed' })
      return true
    }
    const paneId = request.headers['x-commando-pane']
    if (typeof paneId !== 'string' || !PANE_ID.test(paneId)) {
      writeJson(response, 400, { error: 'X-Commando-Pane must be a tmux pane id' })
      return true
    }
    const target = this.dependencies.paneTarget(paneId)
    if (!target) {
      writeJson(response, 404, { error: 'Tmux pane does not exist' })
      return true
    }
    writeJson(response, 200, {
      targetId: target.targetId,
      marker: formatCommandoPrMarker(target.targetId),
    })
    return true
  }
}
