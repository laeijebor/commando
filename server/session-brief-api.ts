import { createHash, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'

import type { AgentStatusKind, SessionBrief, SessionBriefUpdateKind } from '../shared/protocol.js'
import type { SessionBriefPatch, SessionBriefStore } from './session-briefs.js'

const API_PATH = '/api/session-brief'
const MAX_REQUEST_BYTES = 16 * 1024
const PANE_ID = /^%\d+$/
const UPDATE_KINDS = new Set<SessionBriefUpdateKind>(['changed', 'decision', 'check', 'blocker', 'note'])
const STATUS_KINDS = new Set<AgentStatusKind>(['working', 'needs_input', 'done', 'failed', 'stale', 'unknown'])

type SessionBriefApiDependencies = {
  token: string
  store: SessionBriefStore
  paneTarget: (paneId: string) => { sessionId: string; sessionName: string } | null
  onChange: (brief: SessionBrief) => void
  now?: () => number
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
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

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest()
}

function bearerToken(request: IncomingMessage): string | null {
  const authorization = request.headers.authorization
  if (!authorization) return null
  return /^Bearer\s+([^\s]+)$/i.exec(authorization)?.[1] ?? null
}

function targetPaneId(request: IncomingMessage): string {
  const value = request.headers['x-commando-pane']
  if (typeof value !== 'string' || !PANE_ID.test(value)) {
    throw new HttpError(400, 'X-Commando-Pane must be a tmux pane id')
  }
  return value
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const contentType = request.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase()
  if (contentType !== 'application/json') throw new HttpError(415, 'Content-Type must be application/json')
  const declaredLength = Number(request.headers['content-length'] ?? 0)
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) {
    throw new HttpError(413, 'Request body is too large')
  }
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytes += buffer.length
    if (bytes > MAX_REQUEST_BYTES) throw new HttpError(413, 'Request body is too large')
    chunks.push(buffer)
  }
  if (bytes === 0) throw new HttpError(400, 'Request body is required')
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
    if (!isRecord(value)) throw new HttpError(400, 'Request body must be a JSON object')
    return value
  } catch (error) {
    if (error instanceof HttpError) throw error
    throw new HttpError(400, 'Request body is not valid JSON')
  }
}

function optionalText(
  body: Record<string, unknown>,
  property: string,
  maximum: number,
  nullable: boolean,
): string | null | undefined {
  const value = body[property]
  if (value === undefined) return undefined
  if (nullable && (value === null || value === '')) return null
  if (
    typeof value !== 'string' ||
    value.trim().length === 0 ||
    value.length > maximum ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)
  ) throw new HttpError(400, `${property} is invalid`)
  return value.trim()
}

export function parseSessionBriefPatch(body: Record<string, unknown>): SessionBriefPatch {
  const headline = optionalText(body, 'headline', 180, false)
  const recapMarkdown = optionalText(body, 'recapMarkdown', 2_000, true)
  const next = optionalText(body, 'next', 240, true)
  const state = body.state
  if (state !== undefined && (typeof state !== 'string' || !STATUS_KINDS.has(state as AgentStatusKind))) {
    throw new HttpError(400, 'state is invalid')
  }
  let update: SessionBriefPatch['update']
  if (body.update !== undefined) {
    if (!isRecord(body.update)) throw new HttpError(400, 'update must be a JSON object')
    const kind = body.update.kind
    const text = optionalText(body.update, 'text', 240, false)
    const detail = optionalText(body.update, 'detail', 360, false)
    if (typeof kind !== 'string' || !UPDATE_KINDS.has(kind as SessionBriefUpdateKind) || !text) {
      throw new HttpError(400, 'update is invalid')
    }
    update = {
      kind: kind as SessionBriefUpdateKind,
      text,
      ...(detail ? { detail } : {}),
    }
  }
  if (headline === undefined && recapMarkdown === undefined && next === undefined && state === undefined && !update) {
    throw new HttpError(400, 'At least one session brief field is required')
  }
  return {
    ...(headline ? { headline } : {}),
    ...(recapMarkdown !== undefined ? { recapMarkdown } : {}),
    ...(next !== undefined ? { next } : {}),
    ...(state ? { state: state as AgentStatusKind } : {}),
    ...(update ? { update } : {}),
  }
}

export class SessionBriefApi {
  private readonly tokenDigest: Buffer

  constructor(private readonly dependencies: SessionBriefApiDependencies) {
    if (dependencies.token.length < 32) throw new Error('Agent hook token must contain at least 32 characters')
    this.tokenDigest = digest(dependencies.token)
  }

  async handle(request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean> {
    if (url.pathname !== API_PATH) return false
    try {
      const candidate = bearerToken(request)
      if (
        candidate === null ||
        candidate.length > 1_024 ||
        !timingSafeEqual(digest(candidate), this.tokenDigest)
      ) {
        response.setHeader('WWW-Authenticate', 'Bearer realm="commando-agent-hooks"')
        throw new HttpError(401, 'Unauthorized')
      }
      if (request.method !== 'POST') throw new HttpError(405, 'Method not allowed')
      const paneId = targetPaneId(request)
      const target = this.dependencies.paneTarget(paneId)
      if (!target) throw new HttpError(404, 'Tmux pane does not exist')
      const patch = parseSessionBriefPatch(await readJson(request))
      const brief = await this.dependencies.store.applyAgentPatch(
        target.sessionId,
        target.sessionName,
        paneId,
        patch,
        this.dependencies.now?.() ?? Date.now(),
      )
      this.dependencies.onChange(brief)
      writeJson(response, 200, { ok: true, brief })
      return true
    } catch (error) {
      if (error instanceof HttpError) {
        if (error.status === 405) response.setHeader('Allow', 'POST')
        writeJson(response, error.status, { error: error.message })
      } else {
        writeJson(response, 500, { error: 'Unable to record session brief' })
      }
      return true
    }
  }
}
