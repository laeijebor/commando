import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import { stat } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { BOARD_GROUP_TONES, BoardError, BoardStore, boardInput, isBoardFileItem } from './boards.js'
import { BOARD_ID, BOARD_ITEM_KEY, BOARD_ITEM_KINDS, type BoardGroup, type BoardItem, type BoardPlacement } from '../shared/board.js'
import { BOARD_THUMB_HASH, type BoardThumbCache } from './board-thumbs.js'
import { isCommandoTargetId } from '../shared/pane-target.js'
import type { AgentSessionRef } from '../shared/protocol.js'
import type { RedlineArtifactRegistry } from './redline-artifacts.js'

const digest = (s: string) => createHash('sha256').update(s).digest()
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const MAX_BODY = 24 * 1024
const PANE_ID = /^%\d+$/
type Anchor = { id: string; targetId: string; sessionId: string; windowId: string }
type Dependencies = {
  store: BoardStore
  thumbs?: Pick<BoardThumbCache, 'read'>
  agentToken: string
  ownerAuthorized: (request: IncomingMessage, url: URL) => Promise<boolean>
  paneForId: (paneId: string) => Anchor | undefined
  paneForTarget: (targetId: string) => Anchor | undefined
  agentSession: (paneId: string) => AgentSessionRef | undefined
  artifacts?: RedlineArtifactRegistry
  /** Omitted when capabilities.revealInFinder is false. */
  revealInFinder?: (path: string) => Promise<void>
  onRevive?: () => void
}
function json(response: ServerResponse, status: number, value: unknown): void {
  const body = `${JSON.stringify(value)}\n`
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
  response.end(body)
}
async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  if (request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') throw new BoardError(415, 'Content-Type must be application/json')
  if (Number(request.headers['content-length']) > MAX_BODY) throw new BoardError(413, 'Request body is too large')
  const chunks: Buffer[] = []
  let length = 0
  for await (const chunk of request) {
    const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    length += b.length
    if (length > MAX_BODY) throw new BoardError(413, 'Request body is too large')
    chunks.push(b)
  }
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (!record(value)) throw new Error()
    return value
  } catch { throw new BoardError(400, 'Request body must be a JSON object') }
}
function text(b: Record<string, unknown>, k: string, max = 500, required = false): string | undefined {
  const v = b[k]
  if (v === undefined && !required) return undefined
  if (typeof v !== 'string' || !v.trim() || v.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v)) throw new BoardError(400, `${k} is invalid`)
  return v
}
function bool(b: Record<string, unknown>, k: string): boolean | undefined {
  if (b[k] !== undefined && typeof b[k] !== 'boolean') throw new BoardError(400, `${k} must be boolean`)
  return b[k] as boolean | undefined
}
function number(b: Record<string, unknown>, k: string): number | undefined {
  if (b[k] !== undefined && (typeof b[k] !== 'number' || !Number.isFinite(b[k]) || Math.abs(b[k]) > 1e7)) throw new BoardError(400, `${k} must be a finite coordinate`)
  return b[k] as number | undefined
}
function groupId(b: Record<string, unknown>, key = 'group'): string | undefined {
  const id = text(b, key, 128)
  if (id !== undefined && !BOARD_ID.test(id)) throw new BoardError(400, `${key} is invalid`)
  return id
}
function fields(b: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(b).some((k) => !allowed.includes(k))) throw new BoardError(400, 'Unknown request field')
}

export class BoardsApi {
  private readonly tokenDigest: Buffer
  constructor(private readonly deps: Dependencies) {
    if (deps.agentToken.length < 32) throw new Error('Agent hook token must contain at least 32 characters')
    this.tokenDigest = digest(deps.agentToken)
  }
  async handle(request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean> {
    if (url.pathname !== '/api/boards' && !url.pathname.startsWith('/api/boards/')) return false
    try {
      const candidate = /^Bearer\s+([^\s]+)$/i.exec(request.headers.authorization ?? '')?.[1]
      const agent = !!candidate && candidate.length <= 1024 && timingSafeEqual(digest(candidate), this.tokenDigest)
      const owner = agent ? false : await this.deps.ownerAuthorized(request, url)
      if (!agent && !owner) { response.setHeader('WWW-Authenticate', 'Bearer realm="commando"'); throw new BoardError(401, 'Unauthorized') }
      let parts: string[]
      try { parts = url.pathname.slice('/api/boards/'.length).split('/').map(decodeURIComponent) } catch { throw new BoardError(400, 'Invalid path encoding') }
      if (parts[0] === 'thumbs') {
        if (request.method !== 'GET') throw new BoardError(405, 'Method not allowed')
        if (parts.length !== 3 || !BOARD_THUMB_HASH.test(parts[1]) || !['320', '960'].includes(parts[2])) throw new BoardError(400, 'Invalid thumbnail hash or width')
        const bytes = await this.deps.thumbs?.read(parts[1], Number(parts[2]))
        if (!bytes) throw new BoardError(404, 'Thumbnail not found')
        response.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': bytes.length, 'Cache-Control': 'private, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff' })
        response.end(bytes); return true
      }
      let targetId: string, pane: Anchor | undefined
      if (parts[0] === 'by-pane') {
        const paneId = parts[1]
        if (!paneId || !PANE_ID.test(paneId)) throw new BoardError(400, 'Invalid pane id')
        pane = this.deps.paneForId(paneId)
        if (!pane) throw new BoardError(404, 'Tmux pane does not exist')
        targetId = pane.targetId; parts = parts.slice(2)
      } else {
        targetId = parts.shift() ?? ''
        if (!isCommandoTargetId(targetId)) throw new BoardError(400, 'Invalid board target id')
        pane = this.deps.paneForTarget(targetId)
      }
      if (agent) {
        const paneId = request.headers['x-commando-pane']
        const resolved = typeof paneId === 'string' && PANE_ID.test(paneId) ? this.deps.paneForId(paneId) : undefined
        if (!resolved || resolved.targetId !== targetId) throw new BoardError(403, 'Agent requests must identify the owning pane with X-Commando-Pane')
        pane = resolved
      }
      const source = owner ? 'user' : 'agent', store = this.deps.store, method = request.method
      if (parts.length === 0 && method === 'GET') { json(response, 200, store.view(targetId)); return true }
      const section = parts[0], key = parts[1]
      if (section === 'items' && parts.length <= 3) {
        if (key !== undefined && !BOARD_ITEM_KEY.test(key)) throw new BoardError(400, 'Invalid item key')
        if (!key && method === 'POST') {
          const b = await body(request)
          fields(b, ['kind', 'url', 'path', 'text', 'title', 'caption', 'tone', 'group', 'pinned'])
          const kind = text(b, 'kind', 20)
          if (kind !== undefined && !BOARD_ITEM_KINDS.includes(kind as BoardItem['kind'])) throw new BoardError(400, 'Invalid kind')
          const tone = text(b, 'tone', 20)
          if (tone !== undefined && !['decision', 'gotcha', 'note'].includes(tone)) throw new BoardError(400, 'Invalid tone')
          const item = boardInput({ kind: kind as BoardItem['kind'] | undefined, url: text(b, 'url', 8192), path: text(b, 'path', 4096), text: text(b, 'text', 16000), title: text(b, 'title'), caption: text(b, 'caption', 16000), tone: tone as BoardItem['tone'], pinned: bool(b, 'pinned') }, source, this.deps.artifacts, pane && this.deps.agentSession(pane.id))
          if (item.kind === 'pr' && b.title === undefined) item.title = store.get(targetId).items.find((i) => i.key === item.key)?.title ?? item.title
          json(response, 201, store.upsert(targetId, item, groupId(b))); return true
        }
        if (key && parts.length === 2 && method === 'PATCH') {
          const b = await body(request); fields(b, ['title', 'caption', 'pinned'])
          const patch: Pick<Partial<BoardItem>, 'title' | 'caption' | 'pinned'> = {}
          if (b.title !== undefined) patch.title = text(b, 'title')
          if (b.caption !== undefined) patch.caption = text(b, 'caption', 16000)
          if (b.pinned !== undefined) patch.pinned = bool(b, 'pinned')
          json(response, 200, store.patch(targetId, key, patch, source)); return true
        }
        if (key && parts.length === 2 && method === 'DELETE') { store.remove(targetId, key); json(response, 200, { ok: true }); return true }
        if (key && parts.length === 3 && parts[2] === 'reveal' && method === 'POST') {
          if (!owner) throw new BoardError(403, 'Only the owner can reveal board items')
          const item = store.item(targetId, key)
          const file = isBoardFileItem(item)
          const artifact = ['canvas', 'slides', 'guide', 'redline'].includes(item.kind)
          const path = file ? item.ref.path : artifact
            ? store.state(item, targetId) === 'snapshot' ? store.snapshotDir(item)
              : item.ref.artifactId ? this.deps.artifacts?.directory(item.ref.artifactId) : undefined
            : undefined
          if (!path) throw new BoardError(404, 'Board item has no revealable path')
          const info = await stat(path).catch(() => undefined)
          if (!info || (file ? !info.isFile() : !info.isDirectory())) throw new BoardError(404, 'Board item path does not exist')
          if (!this.deps.revealInFinder) throw new BoardError(501, 'Revealing files in Finder is unavailable on this host')
          await this.deps.revealInFinder(path)
          response.writeHead(204, { 'Cache-Control': 'no-store' }); response.end(); return true
        }
        if (key && parts.length === 3 && parts[2] === 'revive' && method === 'POST') {
          const b = await body(request); fields(b, ['anchorPaneId'])
          const id = text(b, 'anchorPaneId', 128, true)!
          const anchor = PANE_ID.test(id) ? this.deps.paneForId(id) : undefined
          if (!anchor || anchor.targetId !== targetId) throw new BoardError(400, 'anchorPaneId must own this board')
          const result = store.revive(targetId, key, { anchorPaneId: anchor.id, sessionId: anchor.sessionId, windowId: anchor.windowId }, source)
          this.deps.onRevive?.(); json(response, 200, result); return true
        }
      }
      if (section === 'place' && parts.length === 1 && method === 'POST') {
        const b = await body(request); fields(b, ['key', 'group', 'x', 'y', 'fixed'])
        const p: Partial<BoardPlacement> = { group: groupId(b) }
        if (b.x !== undefined) p.x = number(b, 'x')
        if (b.y !== undefined) p.y = number(b, 'y')
        if (b.fixed !== undefined) p.fixed = bool(b, 'fixed')
        store.place(targetId, text(b, 'key', 8192, true)!, p, source); json(response, 200, store.view(targetId)); return true
      }
      if (section === 'groups' && parts.length <= 2) {
        if (key && !BOARD_ID.test(key)) throw new BoardError(400, 'Invalid group id')
        if ((method === 'POST' || method === 'PATCH') && (method !== 'PATCH' || key)) {
          const b = await body(request); fields(b, ['id', 'title', 'tone', 'near', 'x', 'y', 'w', 'h'])
          const tone = text(b, 'tone', 20)
          if (tone !== undefined && !BOARD_GROUP_TONES.includes(tone)) throw new BoardError(400, 'Invalid group tone')
          const patch: Partial<Omit<BoardGroup, 'id' | 'by'>> & { near?: string } = {}
          const title = text(b, 'title', 500, method === 'POST')
          if (title !== undefined) patch.title = title
          if (tone !== undefined) patch.tone = tone as BoardGroup['tone']
          if (b.near !== undefined) patch.near = groupId(b, 'near')
          for (const field of ['x', 'y', 'w', 'h'] as const) if (b[field] !== undefined) patch[field] = number(b, field)
          const id = key ?? groupId(b, 'id') ?? randomUUID()
          json(response, method === 'POST' ? 201 : 200, store.group(targetId, id, patch, source, method === 'POST')); return true
        }
        if (key && method === 'DELETE') { store.removeGroup(targetId, key); json(response, 200, { ok: true }); return true }
      }
      if (section === 'links' && parts.length <= 2) {
        if (!key && method === 'POST') {
          const b = await body(request); fields(b, ['from', 'to', 'label'])
          json(response, 201, store.link(targetId, text(b, 'from', 8192, true)!, text(b, 'to', 8192, true)!, text(b, 'label'))); return true
        }
        if (key && method === 'DELETE') { store.removeLink(targetId, key); json(response, 200, { ok: true }); return true }
      }
      throw new BoardError(405, 'Unsupported Board route or method')
    } catch (error) {
      const status = error instanceof BoardError ? error.status : record(error) && typeof error.status === 'number' ? error.status : 500
      json(response, status, { error: status === 500 ? 'Unable to update board' : error instanceof Error ? error.message : 'Invalid request' })
      return true
    }
  }
}
