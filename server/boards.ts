import { createHash, randomUUID } from 'node:crypto'
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, opendirSync, readFileSync, readSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, extname, isAbsolute, join, relative, sep } from 'node:path'
import { BOARD_ARTIFACT_ID, BOARD_ID, BOARD_ITEM_KEY, BOARD_ITEM_KINDS, BOARD_SNAPSHOT_ID, boardPrRefForUrl, boardItemKeyForCanvas, boardItemKeyForClip, boardItemKeyForFile, boardItemKeyForGuide, boardItemKeyForPage, boardItemKeyForPr, boardItemKeyForRedline, boardItemKeyForUrl, normalizeBoardUrl, type Board, type BoardGroup, type BoardItem, type BoardItemKind, type BoardItemSource, type BoardItemState, type BoardLink, type BoardPlacement, type BoardView } from '../shared/board.js'
import { redlineArtifactId } from '../shared/chat-tile-events.js'
import { canvasRelativePath } from '../shared/canvas-manifest.js'
import { guideRelativePath } from '../shared/guide.js'
import { isCommandoTargetId } from '../shared/pane-target.js'
import type { AgentSessionRef, SessionBrief, WebPane } from '../shared/protocol.js'
import { closedWebPaneKind, revivable } from './closed-web-panes.js'
import { isPanePrRef } from './pane-pr-records.js'
import type { RedlineArtifactRegistry } from './redline-artifacts.js'
import type { OpenWebPaneInput, WebPaneService } from './web-panes.js'
import { CANVAS_SNAPSHOT_ENTRY_LIMIT, CANVAS_SNAPSHOT_FILE_LIMIT, CANVAS_SNAPSHOT_INPUT_LIMIT, CANVAS_SNAPSHOT_TOTAL_LIMIT } from './canvas-snapshots.js'

export const BOARD_AUTO_TTL_MS = 30 * 24 * 60 * 60 * 1000
export const MAX_BOARD_ITEMS = 500
export const MAX_BOARD_HISTORY = 2000
export const MAX_BOARD_STATE_BYTES = 16 * 1024 * 1024
const fingerprintHash = (value: string) => /^sha256:[0-9a-f]{64}$/.test(value) ? value : `sha256:${createHash('sha256').update(value).digest('hex')}`
export const defaultBoardsPath = (port: number) => join(homedir(), '.commando', `boards-${port}`)
export const defaultBoardSnapshotsPath = (port: number) => join(homedir(), '.commando', `board-snapshots-${port}`)
export class BoardError extends Error {
  constructor(readonly status: number, message: string) { super(message) }
}
const clone = <T>(value: T): T => structuredClone(value)
const sources = ['auto', 'agent', 'user']
export const BOARD_GROUP_TONES = ['accent', 'blue', 'green', 'amber', 'pink', 'teal']
const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= 1e7
const safeText = (s: unknown, max = 8192): s is string => typeof s === 'string' && s.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(s)
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const sourceValid = (v: unknown): v is BoardItemSource => typeof v === 'string' && sources.includes(v)
const overlaps = (a: Pick<BoardGroup, 'x' | 'y' | 'w' | 'h'>, b: Pick<BoardGroup, 'x' | 'y' | 'w' | 'h'>) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
const fileItem = (item: BoardItem) => ['screenshot', 'video', 'file'].includes(item.kind) || (item.kind === 'diagram' && !!item.ref.path)

/** Absolute board coordinates; append into a free cell, including cells occupied by fixed items. */
export function packBoardItem(board: Board, key: string, groupId: string): { placement: BoardPlacement; group: BoardGroup } {
  const group = board.groups.find((g) => g.id === groupId)
  if (!group) throw new BoardError(404, 'Group does not exist')
  const columns = Math.max(1, Math.floor((group.w - 24) / 220))
  const placed = Object.entries(board.placements).filter(([k, p]) => k !== key && p.group === groupId).map(([, p]) => p)
  let cell = 0
  // Appending preserves the reading order; fixed placements can occupy arbitrary cells.
  for (const p of placed) cell = Math.max(cell, Math.ceil(Math.max(0, p.y - group.y - 40) / 170) * columns + Math.ceil(Math.max(0, p.x - group.x - 12) / 220) + 1)
  const placement = { group: groupId, x: group.x + 12 + (cell % columns) * 220, y: group.y + 40 + Math.floor(cell / columns) * 170 }
  return { placement, group: { ...group, h: Math.max(group.h, placement.y - group.y + 170 + 12) } }
}

export function packBoardGroup(groups: readonly BoardGroup[], group: BoardGroup, near?: string): BoardGroup {
  const anchor = near ? groups.find((g) => g.id === near) : undefined
  if (near && !anchor) throw new BoardError(404, 'Near group does not exist')
  const result = { ...group, x: anchor ? anchor.x + anchor.w + 32 : 0, y: anchor ? anchor.y : groups.length ? Math.max(...groups.map((g) => g.y + g.h)) + 32 : 0 }
  for (;;) {
    const collisions = groups.filter((g) => overlaps(result, g))
    if (!collisions.length) return result
    result.y = Math.max(...collisions.map((g) => g.y + g.h + 32))
  }
}

function validItem(value: unknown): value is BoardItem {
  if (!record(value) || !safeText(value.key) || !BOARD_ITEM_KEY.test(value.key) || !BOARD_ITEM_KINDS.includes(value.kind as BoardItemKind) || !safeText(value.title, 500) || !value.title.trim() || !sourceValid(value.source) || !record(value.ref)) return false
  if (![value.addedAt, value.updatedAt].every((n) => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0)) return false
  const ref = value.ref
  for (const key of ['url', 'path', 'manifest', 'file', 'artifactId', 'webPaneId', 'snapshotId']) if (ref[key] !== undefined && !safeText(ref[key])) return false
  if (ref.url !== undefined) { try { normalizeBoardUrl(ref.url as string) } catch { return false } }
  if (ref.path !== undefined && !isAbsolute(ref.path as string)) return false
  if (ref.artifactId !== undefined && !BOARD_ARTIFACT_ID.test(ref.artifactId as string)) return false
  if (ref.snapshotId !== undefined && !BOARD_SNAPSHOT_ID.test(ref.snapshotId as string)) return false
  if (ref.webPaneId !== undefined && !/^w-[0-9a-f]{8}$/.test(ref.webPaneId as string)) return false
  if (ref.manifest !== undefined && !canvasRelativePath(ref.manifest)) return false
  if (ref.file !== undefined && !canvasRelativePath(ref.file)) return false
  if (ref.pr !== undefined && !isPanePrRef(ref.pr)) return false
  if (value.thumb !== undefined && (!record(value.thumb) || typeof value.thumb.hash !== 'string' || !/^[0-9a-f]{64}$/.test(value.thumb.hash) || ![value.thumb.w, value.thumb.h].every((n) => typeof n === 'number' && Number.isFinite(n) && n > 0 && n <= 16384))) return false
  if (value.preview !== undefined && (!record(value.preview) || Object.entries(value.preview).some(([k, v]) => !['title', 'description', 'siteName', 'image', 'favicon'].includes(k) || !safeText(v, 2000) || (['image', 'favicon'].includes(k) && !/^[0-9a-f]{64}$/.test(v as string))))) return false
  if (value.caption !== undefined && !safeText(value.caption, 16000)) return false
  if (value.pinned !== undefined && typeof value.pinned !== 'boolean') return false
  if (value.tone !== undefined && !['decision', 'gotcha', 'note'].includes(value.tone as string)) return false
  if (value.origin !== undefined) {
    if (!record(value.origin) || !Number.isSafeInteger(value.origin.at) || (value.origin.at as number) < 0) return false
    if (value.origin.prompt !== undefined && !safeText(value.origin.prompt)) return false
    const session = value.origin.agentSession
    if (session !== undefined && (!record(session) || !['claude', 'codex', 'opencode', 'cursor', 'muse', 'deepseek', 'unknown'].includes(session.provider as string) || typeof session.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{5,127}$/.test(session.id))) return false
  }
  return true
}
function validateBoard(value: unknown, targetId: string): value is Board {
  if (!record(value) || value.targetId !== targetId || !Number.isSafeInteger(value.rev) || (value.rev as number) < 0 || !Array.isArray(value.items) || value.items.length > MAX_BOARD_ITEMS || !value.items.every(validItem) || !Array.isArray(value.groups) || value.groups.length > 500 || !Array.isArray(value.links) || value.links.length > 2000 || !record(value.placements)) return false
  const keys = new Set(value.items.map((i) => i.key))
  const ids = new Set<string>()
  for (const g of value.groups) {
    if (!record(g) || typeof g.id !== 'string' || !BOARD_ID.test(g.id) || ids.has(g.id) || keys.has(g.id) || !safeText(g.title, 500) || !sourceValid(g.by) || ![g.x, g.y, g.w, g.h].every(finite) || (g.w as number) < 244 || (g.h as number) < 100 || (g.tone !== undefined && !BOARD_GROUP_TONES.includes(g.tone as string))) return false
    ids.add(g.id)
  }
  if (keys.size !== value.items.length) return false
  for (const [key, p] of Object.entries(value.placements)) if (!keys.has(key) || !record(p) || !finite(p.x) || !finite(p.y) || (p.fixed !== undefined && typeof p.fixed !== 'boolean') || (p.group !== undefined && !ids.has(p.group as string))) return false
  const endpoints = new Set([...keys, ...ids]), links = new Set<string>()
  for (const l of value.links) {
    if (!record(l) || typeof l.id !== 'string' || !BOARD_ID.test(l.id) || links.has(l.id) || !endpoints.has(l.from as string) || !endpoints.has(l.to as string) || (l.label !== undefined && !safeText(l.label, 500))) return false
    links.add(l.id)
  }
  return true
}

type InputItem = Pick<BoardItem, 'key' | 'kind' | 'title' | 'source' | 'ref'> & Partial<Pick<BoardItem, 'origin' | 'caption' | 'tone' | 'pinned' | 'thumb' | 'preview'>>
type Options = {
  root?: string
  snapshotRoot?: string
  origin?: string
  artifacts?: RedlineArtifactRegistry
  webPanes?: WebPaneService
  now?: () => number
  onChange?: (targetId: string, rev: number) => void
  onError?: (error: unknown) => void
  onRead?: (targetId: string) => void
}

/** Per-target durable boards. Derived state is never written to disk. */
export class BoardStore {
  private readonly boards = new Map<string, Board>()
  private readonly observed = new Map<string, Record<string, string>>()
  private readonly folderScans = new Map<string, number>()
  private readonly dirty = new Set<string>()
  private timer: ReturnType<typeof setTimeout> | undefined
  private readonly now: () => number
  constructor(private readonly options: Options = {}) {
    this.now = options.now ?? Date.now
    if (options.root) {
      try {
        for (const name of readdirSync(options.root)) {
          const targetId = name.replace(/\.json$/, '')
          if (name !== `${targetId}.json` || !isCommandoTargetId(targetId)) continue
          try {
            const path = join(options.root, name)
            if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) continue
            if (statSync(path).size > MAX_BOARD_STATE_BYTES) throw new Error(`Board state exceeds the 16 MiB limit: ${path}`)
            const data: unknown = JSON.parse(readFileSync(path, 'utf8'))
            if (!record(data) || !validateBoard(data.board, targetId)) throw new Error(`Invalid board ${targetId}`)
            const board = clone(data.board)
            for (const item of board.items) delete (item as BoardItem & { state?: string }).state
            this.boards.set(targetId, board)
            if (record(data.observed)) this.observed.set(targetId, Object.fromEntries(Object.entries(data.observed).filter(([k, v]) => BOARD_ITEM_KEY.test(k) && typeof v === 'string').slice(-MAX_BOARD_HISTORY).map(([k, v]) => [k, fingerprintHash(v as string)])) as Record<string, string>)
          } catch (error) { this.report(error) }
        }
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') options.onError?.(error) }
    }
    this.prune()
  }
  private board(targetId: string): Board {
    if (!isCommandoTargetId(targetId)) throw new BoardError(400, 'Invalid board target id')
    return this.boards.get(targetId) ?? { targetId, rev: 0, items: [], groups: [], placements: {}, links: [] }
  }
  get(targetId: string): Board { this.prune(targetId); return clone(this.board(targetId)) }
  view(targetId: string): BoardView {
    const b = this.get(targetId)
    const paths = new Map<string, boolean>()
    this.options.onRead?.(targetId)
    return { ...b, items: b.items.map((i) => ({ ...i, state: this.state(i, targetId, paths) })) }
  }
  targets(): string[] { return [...this.boards.keys()] }
  /** Derived previews do not change source, user edits, placements, or auto-retention timestamps. */
  setPreview(targetId: string, key: string, patch: Pick<Partial<BoardItem>, 'thumb' | 'preview'>): void {
    const b = this.get(targetId), item = b.items.find((i) => i.key === key)
    if (!item) return
    const next = { ...item, ...patch }
    if (JSON.stringify(next) === JSON.stringify(item)) return
    if (!validItem(next)) throw new BoardError(400, 'Invalid board preview')
    b.items[b.items.indexOf(item)] = next
    this.save(b)
  }
  item(targetId: string, key: string): BoardItem {
    const item = this.get(targetId).items.find((i) => i.key === key)
    if (!item) throw new BoardError(404, 'Board item does not exist')
    return item
  }
  private report(error: unknown): void {
    if (this.options.onError) this.options.onError(error)
    else console.error('[commando] Board persistence failed', error)
  }
  private save(board: Board): void {
    const payload = JSON.stringify({ version: 1, board: { ...board, rev: board.rev + 1 }, observed: {} })
    if (Buffer.byteLength(payload) > MAX_BOARD_STATE_BYTES) throw new BoardError(413, 'Board state exceeds the 16 MiB limit')
    board.rev++
    this.boards.set(board.targetId, board)
    this.schedule(board.targetId)
    this.options.onChange?.(board.targetId, board.rev)
  }
  private schedule(targetId: string): void {
    this.dirty.add(targetId)
    if (!this.timer && this.options.root) {
      this.timer = setTimeout(() => { this.timer = undefined; try { this.flush() } catch (error) { this.options.onError?.(error) } }, 250)
      this.timer.unref()
    }
  }
  flush(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    if (!this.options.root) return
    mkdirSync(this.options.root, { recursive: true, mode: 0o700 })
    for (const targetId of this.dirty) {
      const path = join(this.options.root, `${targetId}.json`), tmp = `${path}.${randomUUID()}.tmp`
      try {
        writeFileSync(tmp, this.persistedBoard(this.board(targetId)), { mode: 0o600, flag: 'wx' })
        renameSync(tmp, path)
        this.dirty.delete(targetId)
      } finally { rmSync(tmp, { force: true }) }
    }
    // All references are now durable; only this store's UUID folders are collectible.
    if (this.options.snapshotRoot) {
      const retained = this.retainedSnapshots()
      try {
        for (const id of readdirSync(this.options.snapshotRoot)) if (BOARD_SNAPSHOT_ID.test(id) && !retained.has(id)) rmSync(join(this.options.snapshotRoot, id), { recursive: true, force: true })
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.options.onError?.(error) }
    }
  }
  private persistedBoard(board: Board): string {
    const prefix = `{"version":1,"board":${JSON.stringify(board)},"observed":{`
    let bytes = Buffer.byteLength(prefix) + 2
    if (bytes > MAX_BOARD_STATE_BYTES) {
      const error = new BoardError(413, `Board state exceeds the 16 MiB limit: ${board.targetId}`)
      this.report(error); throw error
    }
    const history = this.observed.get(board.targetId) ?? {}, retained: [string, string][] = []
    for (const [key, value] of Object.entries(history).slice(-MAX_BOARD_HISTORY).reverse()) {
      const entry = `${JSON.stringify(key)}:${JSON.stringify(value)}`
      const size = Buffer.byteLength(entry) + (retained.length ? 1 : 0)
      if (bytes + size > MAX_BOARD_STATE_BYTES) continue
      retained.push([key, value]); bytes += size
    }
    retained.reverse()
    this.observed.set(board.targetId, Object.fromEntries(retained))
    return prefix + retained.map(([k, v]) => `${JSON.stringify(k)}:${JSON.stringify(v)}`).join(',') + '}}'
  }
  private retainedSnapshots(): Set<string> {
    const ids = new Set([...this.boards.values()].flatMap((b) => b.items.flatMap((i) => i.ref.snapshotId ?? [])))
    if (!this.options.snapshotRoot) return ids
    const paths = [...this.boards.values()].flatMap((b) => b.items.flatMap((i) => i.ref.path ?? []))
    for (const url of this.options.webPanes?.retainedUrls() ?? []) {
      const artifact = redlineArtifactId(url), dir = artifact && this.options.artifacts?.directory(artifact)
      if (dir) paths.push(dir)
    }
    for (const path of paths) {
      const rel = relative(this.options.snapshotRoot, path), id = rel.split(sep)[0]
      if (BOARD_SNAPSHOT_ID.test(id)) ids.add(id)
    }
    return ids
  }
  private drop(b: Board, key: string): void {
    b.items = b.items.filter((i) => i.key !== key)
    delete b.placements[key]
    const history = this.observed.get(b.targetId)
    if (history) delete history[key]
    b.links = b.links.filter((l) => l.from !== key && l.to !== key)
  }
  prune(targetId?: string): void {
    for (const b of targetId ? [this.board(targetId)] : [...this.boards.values()]) {
      const expired = b.items.filter((i) => i.source === 'auto' && !i.pinned && i.updatedAt <= this.now() - BOARD_AUTO_TTL_MS)
      if (expired.length) { for (const i of expired) this.drop(b, i.key); this.save(b) }
    }
  }
  upsert(targetId: string, input: InputItem, group?: string): BoardItem {
    const b = this.get(targetId), now = this.now(), current = b.items.find((i) => i.key === input.key)
    if (group && !b.groups.some((g) => g.id === group)) throw new BoardError(404, 'Group does not exist')
    let next: BoardItem = { ...current, ...input, ref: { ...current?.ref, ...input.ref }, addedAt: current?.addedAt ?? now, updatedAt: now }
    if (current && input.source === 'auto' && current.source !== 'auto') next = { ...next, title: current.title, source: current.source, caption: current.caption, pinned: current.pinned }
    if (!validItem(next)) throw new BoardError(400, 'Invalid board item')
    if (current) b.items[b.items.findIndex((i) => i.key === input.key)] = next
    else {
      if (b.items.length >= MAX_BOARD_ITEMS) {
        const victim = b.items.filter((i) => !i.pinned && i.source === 'auto').sort((a, z) => a.updatedAt - z.updatedAt || a.addedAt - z.addedAt)[0]
        if (!victim) throw new BoardError(409, 'Board is full; remove an item before adding another')
        this.drop(b, victim.key)
      }
      b.items.push(next)
    }
    if (group && !(input.source !== 'user' && b.placements[input.key]?.fixed)) this.pack(b, input.key, group)
    this.save(b)
    return clone(next)
  }
  /** Compact, bounded capture fingerprints survive restart without extending retention. */
  capture(targetId: string, input: Omit<InputItem, 'source'>, fingerprint?: string): void {
    const seen = this.observed.get(targetId) ?? Object.create(null) as Record<string, string>
    const signature = fingerprintHash(fingerprint ?? JSON.stringify({ kind: input.kind, title: input.title, ref: input.ref }))
    if (seen[input.key] === signature) return
    this.upsert(targetId, { ...input, source: 'auto' })
    delete seen[input.key]
    seen[input.key] = signature
    for (const key of Object.keys(seen).slice(0, -MAX_BOARD_HISTORY)) delete seen[key]
    this.observed.set(targetId, seen)
    this.schedule(targetId)
  }
  patch(targetId: string, key: string, patch: Pick<Partial<BoardItem>, 'title' | 'caption' | 'pinned'>, by: BoardItemSource): BoardItem {
    const item = this.item(targetId, key)
    return this.upsert(targetId, { ...item, ...patch, source: by })
  }
  remove(targetId: string, key: string): void { this.item(targetId, key); const b = this.get(targetId); this.drop(b, key); this.save(b) }
  private pack(b: Board, key: string, group: string): void {
    const result = packBoardItem(b, key, group)
    b.placements[key] = result.placement
    b.groups[b.groups.findIndex((g) => g.id === group)] = result.group
  }
  place(targetId: string, key: string, p: Partial<BoardPlacement>, by: BoardItemSource): void {
    const b = this.get(targetId)
    if (!b.items.some((i) => i.key === key)) throw new BoardError(404, 'Board item does not exist')
    if (by !== 'user' && (b.placements[key]?.fixed || p.x !== undefined || p.y !== undefined || p.fixed !== undefined)) throw new BoardError(409, 'Agents cannot move fixed items or set coordinates')
    if ((p.x === undefined) !== (p.y === undefined) || (p.x !== undefined && (!finite(p.x) || !finite(p.y)))) throw new BoardError(400, 'x and y must be finite coordinates')
    if (p.group && !b.groups.some((g) => g.id === p.group)) throw new BoardError(404, 'Group does not exist')
    if (p.x !== undefined && p.y !== undefined) b.placements[key] = { ...p, x: p.x, y: p.y, fixed: true }
    else if (p.group) this.pack(b, key, p.group)
    else if (by === 'user' && p.fixed !== undefined && b.placements[key]) b.placements[key].fixed = p.fixed
    else delete b.placements[key]
    this.save(b)
  }
  group(targetId: string, id: string, patch: Partial<Omit<BoardGroup, 'id' | 'by'>> & { near?: string }, by: BoardItemSource, create = false): BoardGroup {
    if (!BOARD_ID.test(id) || ['__proto__', 'constructor', 'prototype'].includes(id)) throw new BoardError(400, 'Invalid group id')
    const b = this.get(targetId), current = b.groups.find((g) => g.id === id)
    if (!current && !create) throw new BoardError(404, 'Group does not exist')
    if (!current && b.groups.length >= 500) throw new BoardError(409, 'Too many groups')
    const { near, ...fields } = patch
    if (by !== 'user' && ['x', 'y', 'w', 'h'].some((k) => Object.hasOwn(fields, k))) throw new BoardError(400, 'Agents place groups by relationship, not coordinates')
    let next: BoardGroup = { id, title: id, x: 0, y: 0, w: by === 'user' ? 684 : 464, h: 222, by, ...current, ...fields }
    if (!current || near) next = packBoardGroup(b.groups.filter((g) => g.id !== id), next, near)
    if (!current && by === 'user' && fields.x !== undefined && fields.y !== undefined) next = { ...next, x: fields.x, y: fields.y }
    if (!safeText(next.title, 500) || !next.title.trim() || (next.tone !== undefined && !BOARD_GROUP_TONES.includes(next.tone)) || ![next.x, next.y, next.w, next.h].every(finite) || next.w < 244 || next.h < 100) throw new BoardError(400, 'Invalid group')
    // Moving a group follows its non-fixed items; a user's fixed coordinates stay absolute.
    if (current) for (const p of Object.values(b.placements)) if (p.group === id && !p.fixed) { p.x += next.x - current.x; p.y += next.y - current.y }
    b.groups = [...b.groups.filter((g) => g.id !== id), next]
    this.save(b)
    return clone(next)
  }
  removeGroup(targetId: string, id: string): void {
    const b = this.get(targetId)
    if (!b.groups.some((g) => g.id === id)) throw new BoardError(404, 'Group does not exist')
    b.groups = b.groups.filter((g) => g.id !== id)
    for (const [key, p] of Object.entries(b.placements)) if (p.group === id) {
      if (p.fixed) delete p.group
      else delete b.placements[key]
    }
    b.links = b.links.filter((l) => l.from !== id && l.to !== id)
    this.save(b)
  }
  link(targetId: string, from: string, to: string, label?: string): BoardLink {
    const b = this.get(targetId), endpoints = new Set([...b.items.map((i) => i.key), ...b.groups.map((g) => g.id)])
    if (!endpoints.has(from) || !endpoints.has(to) || (label !== undefined && !safeText(label, 500))) throw new BoardError(400, 'Link endpoints must exist and label must be valid')
    if (b.links.length >= 2000) throw new BoardError(409, 'Too many links')
    const link = { id: randomUUID(), from, to, ...(label !== undefined ? { label } : {}) }
    b.links.push(link); this.save(b); return link
  }
  removeLink(targetId: string, id: string): void {
    const b = this.get(targetId)
    if (!b.links.some((l) => l.id === id)) throw new BoardError(404, 'Link does not exist')
    b.links = b.links.filter((l) => l.id !== id); this.save(b)
  }
  artifactIds(): string[] { return [...new Set([...this.boards.values()].flatMap((b) => b.items.flatMap((i) => i.ref.artifactId ?? [])))] }
  private livePane(item: BoardItem, targetId?: string): WebPane | undefined {
    const service = this.options.webPanes
    return service?.list().find((p) => {
      if (!revivable(p)) return false
      const sameOwner = targetId && service.closedTabHooks?.targetIdFor(p.anchorPaneId) === targetId
      if (p.id !== item.ref.webPaneId && !sameOwner) return false
      if (item.ref.manifest) return p.content?.kind === 'canvas' && p.content.artifactId === item.ref.artifactId && p.content.manifest === item.ref.manifest
      if (item.kind === 'guide') return p.content?.kind === 'guide' && p.content.artifactId === item.ref.artifactId && p.content.file === item.ref.file
      try { return !p.content && !!item.ref.url && normalizeBoardUrl(p.url) === normalizeBoardUrl(item.ref.url) } catch { return false }
    })
  }
  private sourceExists(item: BoardItem): boolean {
    const { path, manifest, file } = item.ref
    if (!path) return false
    try {
      if (realpathSync(path) !== path) return false
      const child = manifest ?? file
      if (!child) return statSync(path).isFile()
      const resolved = realpathSync(join(path, child))
      return resolved.startsWith(path + sep) && statSync(resolved).isFile()
    } catch { return false }
  }
  /** Validated snapshot folder, shared by revival and Finder reveal. */
  snapshotDir(item: BoardItem): string | undefined {
    const { snapshotId, manifest, file } = item.ref
    if (!snapshotId || !BOARD_SNAPSHOT_ID.test(snapshotId) || !this.options.snapshotRoot) return undefined
    const path = join(this.options.snapshotRoot, snapshotId)
    try { if (!lstatSync(path).isSymbolicLink() && this.sourceExists({ ...item, ref: { path, manifest, file } })) return path } catch { /* Absent snapshots are missing. */ }
    return undefined
  }
  state(item: BoardItem, targetId?: string, paths = new Map<string, boolean>()): BoardItemState {
    if (['link', 'clip', 'pr'].includes(item.kind)) return 'open'
    if (fileItem(item)) {
      const path = item.ref.path
      if (!path) return 'missing'
      let available = paths.get(path)
      if (available === undefined) {
        try { available = !!statSync(path, { throwIfNoEntry: false }) } catch { available = false }
        paths.set(path, available)
      }
      return available ? 'open' : 'missing'
    }
    if (this.livePane(item, targetId)) return 'open'
    if (!item.ref.artifactId && item.ref.url) return 'closed'
    if (this.sourceExists(item)) return 'closed'
    if (this.snapshotDir(item)) return 'snapshot'
    return 'missing'
  }
  /** State-only changes (close/reopen) use the same revision stream without touching retention timestamps. */
  changed(targetId: string): void { if (this.boards.has(targetId)) this.save(this.get(targetId)) }

  captureWebPane(targetId: string, pane: WebPane, agentSession?: AgentSessionRef, title?: string): string | undefined {
    if (!revivable(pane)) return undefined
    const revived = this.board(targetId).items.find((i) => i.ref.webPaneId === pane.id && i.ref.snapshotId && i.ref.artifactId === (pane.content && pane.content.kind !== 'simulator' ? pane.content.artifactId : redlineArtifactId(pane.url)) && i.ref.url === pane.url)
    if (revived) return revived.key
    const kind = closedWebPaneKind(pane), content = pane.content
    const artifactId = content && content.kind !== 'simulator' ? content.artifactId : redlineArtifactId(pane.url)
    const path = artifactId ? this.options.artifacts?.directory(artifactId) ?? undefined : undefined
    const manifest = content?.kind === 'canvas' ? content.manifest : undefined
    let file = content?.kind === 'guide' ? content.file : undefined
    if (!file && kind === 'redline') {
      try { file = decodeURIComponent(new URL(pane.url).pathname.split(`/artifacts/${artifactId}/`)[1] || 'index.html') } catch { return undefined }
    }
    if (artifactId && !path) return undefined
    const existing = this.board(targetId).items.find((i) => i.ref.webPaneId === pane.id && i.ref.url === pane.url && i.ref.artifactId === artifactId && i.ref.manifest === manifest && i.ref.file === file)
    const key = existing?.key ?? (kind === 'canvas' || kind === 'slides' ? boardItemKeyForCanvas(path!, manifest) : kind === 'guide' ? boardItemKeyForGuide(path!, file!) : kind === 'redline' ? boardItemKeyForRedline(pane.url) : boardItemKeyForPage(pane.url))
    this.capture(targetId, { key, kind, title: (title || pane.title || (manifest ?? file ?? pane.url)).slice(0, 500), ref: { url: pane.url, webPaneId: pane.id, ...(artifactId ? { artifactId } : {}), ...(path ? { path } : {}), ...(manifest ? { manifest } : {}), ...(file ? { file } : {}) }, origin: { at: this.now(), ...(agentSession ? { agentSession } : {}) } }, JSON.stringify([pane.id, pane.url, pane.content, title || pane.title, pane.openRevision]))
    return key
  }
  captureBrief(brief: SessionBrief): void {
    if (!brief.targetId) return
    for (const ref of brief.references ?? []) {
      const url = ['url', 'issue', 'deployment'].includes(ref.kind) ? ref.value : ref.url
      if (!url) continue
      this.capture(brief.targetId, { key: boardItemKeyForUrl(url), kind: 'link', title: (ref.label ?? ref.value).slice(0, 500), ref: { url }, origin: { at: this.now(), agentSession: brief.agentSession } }, JSON.stringify([url, ref.label, brief.agentSession]))
    }
    for (const folder of brief.screenshots ?? []) this.captureFolder(brief.targetId, folder.dir, folder.updatedAt, brief.agentSession)
  }
  captureFolder(targetId: string, dir: string, stamp: number, agentSession?: AgentSessionRef): void {
    const scanKey = `${targetId}:${dir}`
    if (this.folderScans.get(scanKey) === stamp) return
    this.folderScans.set(scanKey, stamp)
    try {
      const root = realpathSync(dir), entries = opendirSync(root)
      let visited = 0, captured = 0
      try {
        let entry
        while (visited++ < 500 && captured < 24 && (entry = entries.readSync())) {
          if (!entry.isFile() || entry.name.startsWith('.')) continue
          const path = realpathSync(join(root, entry.name)), kind = inferBoardFileKind(path)
          if (!path.startsWith(root + sep) || (kind !== 'screenshot' && kind !== 'video') || statSync(path).size > 50 * 1024 * 1024) continue
          this.capture(targetId, { key: boardItemKeyForFile(path), kind, title: entry.name, ref: { path }, origin: { at: this.now(), agentSession } }, JSON.stringify([stamp, statSync(path).mtimeMs, agentSession]))
          captured++
        }
      } finally { entries.closeSync() }
    } catch (error) { this.options.onError?.(error) }
  }
  capturePr(targetId: string, pr: { repo: string; number: number; title?: string; url?: string; updatedAt?: string; state?: string }, agentSession?: AgentSessionRef): void {
    if (!isPanePrRef(pr)) return
    const key = boardItemKeyForPr(pr.repo, pr.number)
    // Bare persisted/hook refs must not replace a title already learned from GitHub.
    if (!pr.title && !pr.updatedAt && !pr.state && this.board(targetId).items.some((i) => i.key === key)) return
    this.capture(targetId, { key, kind: 'pr', title: pr.title ?? `${pr.repo}#${pr.number}`, ref: { pr: { repo: pr.repo, number: pr.number }, url: pr.url ?? `https://github.com/${pr.repo}/pull/${pr.number}` }, origin: { at: this.now(), agentSession } }, JSON.stringify([pr.repo.toLowerCase(), pr.number, pr.title, pr.url, pr.updatedAt, pr.state, agentSession]))
  }
  snapshotOnClose(targetId: string, pane: WebPane, title?: string, agentSession?: AgentSessionRef): void {
    const key = this.captureWebPane(targetId, pane, agentSession, title)
    if (!key) return
    const item = this.item(targetId, key)
    if (item.ref.path && item.ref.artifactId && this.options.snapshotRoot) {
      const snapshotId = copyBoardSnapshot(item.ref.path, this.options.snapshotRoot, item.ref.manifest ?? item.ref.file)
      if (snapshotId) {
        const b = this.get(targetId), stored = b.items.find((i) => i.key === key)!, old = stored.ref.snapshotId
        stored.ref.snapshotId = snapshotId
        stored.updatedAt = this.now()
        this.save(b)
        // Only delete an old folder once the replacement reference is durable.
        this.flush()
        if (old && !this.retainedSnapshots().has(old)) rmSync(join(this.options.snapshotRoot, old), { recursive: true, force: true })
      }
    }
    this.changed(targetId)
  }
  revive(targetId: string, key: string, anchor: Pick<OpenWebPaneInput, 'anchorPaneId' | 'sessionId' | 'windowId'>, by: 'agent' | 'user'): { webPaneId?: string; path?: string } {
    const item = this.item(targetId, key), state = this.state(item, targetId), webPanes = this.options.webPanes
    if (state === 'missing') throw new BoardError(409, 'Artifact source and snapshot are missing; this item cannot be revived')
    if (fileItem(item)) { this.changed(targetId); return { path: item.ref.path } }
    if (!webPanes) throw new BoardError(503, 'Web panes are unavailable')
    const live = this.livePane(item, targetId)
    if (live) { if (live.dock === 'panel') webPanes.setActiveTab(live.id); this.changed(targetId); return { webPaneId: live.id } }
    if (state === 'closed' && item.ref.webPaneId && (webPanes.closedTabs()[targetId] ?? []).some((p) => p.id === item.ref.webPaneId)) {
      const pane = webPanes.reopenClosed(targetId, item.ref.webPaneId, anchor)
      this.changed(targetId); return { webPaneId: pane.id }
    }
    const path = state === 'snapshot' ? this.snapshotDir(item) : item.ref.artifactId ? item.ref.path : undefined
    let url = item.ref.url, content: WebPane['content'], artifactId = item.ref.artifactId
    if (path) {
      artifactId = this.options.artifacts?.register(path).id
      if (!artifactId) throw new BoardError(503, 'Artifact registry is unavailable')
      const parsed = new URL(url ?? this.options.origin ?? 'http://127.0.0.1/')
      parsed.pathname = `/redline/artifacts/${artifactId}/${(item.ref.file ?? '').split('/').map(encodeURIComponent).join('/')}`
      url = parsed.href
      if (item.ref.manifest) content = { kind: 'canvas', artifactId, manifest: item.ref.manifest }
      else if (item.kind === 'guide' && item.ref.file) content = { kind: 'guide', artifactId, file: item.ref.file }
    }
    if (!url) throw new BoardError(409, 'This item has no URL to open')
    const pane = webPanes.open({ ...anchor, url, content, openedBy: by })
    webPanes.setActiveTab(pane.id)
    const b = this.get(targetId), stored = b.items.find((i) => i.key === key)!
    stored.ref = { ...stored.ref, webPaneId: pane.id, url, ...(artifactId ? { artifactId } : {}) }
    this.save(b)
    return { webPaneId: pane.id }
  }
}

export function inferBoardFileKind(path: string): BoardItemKind {
  const ext = extname(path).toLowerCase()
  return ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.svg', '.heic'].includes(ext) ? 'screenshot' : ['.mp4', '.mov', '.webm', '.m4v'].includes(ext) ? 'video' : 'file'
}
export function boardInput(input: { url?: string; path?: string; text?: string; kind?: BoardItemKind; title?: string; caption?: string; tone?: BoardItem['tone']; pinned?: boolean }, source: BoardItemSource, artifacts?: RedlineArtifactRegistry, agentSession?: AgentSessionRef, now = Date.now()): InputItem {
  if ([input.url, input.path, input.text].filter((v) => v !== undefined).length !== 1) throw new BoardError(400, 'Supply exactly one of url, path or text')
  let kind: BoardItemKind, key: string, ref: BoardItem['ref'] = {}, title: string
  if (input.url !== undefined) {
    let url: string
    try { url = normalizeBoardUrl(input.url) } catch { throw new BoardError(400, 'Invalid http(s) URL') }
    const artifactId = redlineArtifactId(url), path = artifactId && artifacts?.directory(artifactId)
    kind = artifactId ? 'redline' : boardPrRefForUrl(url) ? 'pr' : 'link'
    key = artifactId ? boardItemKeyForRedline(url) : boardItemKeyForUrl(url)
    const file = artifactId ? decodeURIComponent(new URL(url).pathname.split(`/artifacts/${artifactId}/`)[1] || 'index.html') : undefined
    ref = { url, ...(artifactId ? { artifactId } : {}), ...(path ? { path } : {}), ...(file ? { file } : {}) }; title = url.slice(0, 500)
  } else if (input.path !== undefined) {
    if (!isAbsolute(input.path) || !safeText(input.path, 4096)) throw new BoardError(400, 'path must be absolute')
    let path: string
    try { path = realpathSync(input.path) } catch { throw new BoardError(400, 'path must exist') }
    if (statSync(path).isDirectory()) {
      if (!existsSync(join(path, 'canvas.json'))) throw new BoardError(400, 'Directory must contain canvas.json')
      kind = 'canvas'; key = boardItemKeyForCanvas(path); ref = { path, manifest: 'canvas.json', artifactId: artifacts?.register(path).id }
    } else {
      if (!statSync(path).isFile()) throw new BoardError(400, 'path must be a file or canvas directory')
      const parent = dirname(path)
      if (input.kind === 'slides' && extname(path).toLowerCase() === '.html') {
        kind = 'slides'; key = boardItemKeyForCanvas(parent, basename(path)); ref = { path: parent, manifest: basename(path), artifactId: artifacts?.register(parent).id }
      } else if (input.kind === 'guide' && guideRelativePath(basename(path))) {
        kind = 'guide'; key = boardItemKeyForGuide(parent, basename(path)); ref = { path: parent, file: basename(path), artifactId: artifacts?.register(parent).id }
      } else if (extname(path).toLowerCase() === '.html' && existsSync(join(parent, 'canvas.json'))) {
        kind = 'canvas'; key = boardItemKeyForCanvas(parent); ref = { path: parent, manifest: 'canvas.json', artifactId: artifacts?.register(parent).id }
      } else { kind = inferBoardFileKind(path); key = boardItemKeyForFile(path); ref = { path } }
    }
    title = basename(path)
  } else {
    if (!safeText(input.text, 16000) || !input.text.trim()) throw new BoardError(400, 'text must be non-empty and at most 16000 characters')
    kind = 'clip'; key = boardItemKeyForClip(randomUUID()); title = input.text.slice(0, 100)
  }
  kind = input.kind ?? kind
  if (!BOARD_ITEM_KINDS.includes(kind)) throw new BoardError(400, 'Invalid item kind')
  if (kind === 'pr' && ref.url) {
    const url = new URL(ref.url), match = /^\/([^/]+\/[^/]+)\/pull\/(\d+)\/?$/.exec(url.pathname)
    if (url.hostname === 'github.com' && match && isPanePrRef({ repo: match[1], number: Number(match[2]) })) {
      ref.pr = { repo: match[1], number: Number(match[2]) }; key = boardItemKeyForPr(ref.pr.repo, ref.pr.number)
    }
  }
  if ((kind === 'pr' && !ref.pr) || (['canvas', 'slides'].includes(kind) && !ref.manifest) || (kind === 'guide' && !ref.file) || (['file', 'screenshot', 'video'].includes(kind) && !ref.path) || (kind === 'clip' && input.text === undefined)) throw new BoardError(400, 'kind does not match the supplied reference')
  if (ref.manifest && !canvasRelativePath(ref.manifest) || kind === 'guide' && ref.file && !guideRelativePath(ref.file)) throw new BoardError(400, 'Invalid artifact file')
  return { key, kind, title: input.title ?? title, source, ref, caption: input.caption ?? input.text, tone: input.tone, pinned: input.pinned, origin: { at: now, ...(agentSession ? { agentSession } : {}) } }
}

/** Independent folder snapshots: no dependency on the original registry/History lifecycle. */
export function copyBoardSnapshot(root: string, snapshotRoot: string, priority?: string): string | undefined {
  if (!isAbsolute(root)) return undefined
  try { if (lstatSync(root).isSymbolicLink() || realpathSync(root) !== root) return undefined } catch { return undefined }
  const id = randomUUID(), staging = join(snapshotRoot, `.${id}`)
  let total = 0, visited = 0, inputBytes = 0
  const paths: string[] = []
  const walk = (folder: string, depth = 0) => {
    if (depth >= 64 || visited >= CANVAS_SNAPSHOT_ENTRY_LIMIT) return
    // Revalidate every component before descending or opening a file.
    const confined = (file: string) => {
      let p = root
      if (lstatSync(p).isSymbolicLink() || realpathSync(p) !== root) return false
      for (const part of relative(root, file).split(sep)) { p = join(p, part); if (lstatSync(p).isSymbolicLink()) return false }
      return realpathSync(file).startsWith(root + sep)
    }
    if (folder !== root && !confined(folder)) return
    const dir = opendirSync(folder)
    try {
      let entry
      while (visited < CANVAS_SNAPSHOT_ENTRY_LIMIT && (entry = dir.readSync())) {
        visited++
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
        const file = join(folder, entry.name)
        try {
          if (!confined(file)) continue
          if (entry.isDirectory()) walk(file, depth + 1)
          else if (entry.isFile()) paths.push(file)
        } catch { /* A disappearing source file is omitted. */ }
      }
    } finally { dir.closeSync() }
  }
  try {
    walk(root)
    mkdirSync(staging, { recursive: true, mode: 0o700 })
    paths.sort((a, b) => Number(relative(root, b) === priority) - Number(relative(root, a) === priority) || a.localeCompare(b))
    for (const file of paths) {
      let fd: number | undefined
      try {
        let p = root, valid = !lstatSync(root).isSymbolicLink() && realpathSync(root) === root
        for (const part of relative(root, file).split(sep)) { p = join(p, part); if (lstatSync(p).isSymbolicLink()) valid = false }
        if (!valid || !realpathSync(file).startsWith(root + sep)) continue
        fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
        const s = fstatSync(fd), current = lstatSync(file)
        p = root
        if (lstatSync(root).isSymbolicLink() || realpathSync(root) !== root || !realpathSync(file).startsWith(root + sep)) continue
        for (const part of relative(root, file).split(sep)) { p = join(p, part); if (lstatSync(p).isSymbolicLink()) valid = false }
        if (!valid) continue
        if (!s.isFile() || s.size > CANVAS_SNAPSHOT_FILE_LIMIT || s.ino !== current.ino || s.dev !== current.dev || s.size + total > CANVAS_SNAPSHOT_TOTAL_LIMIT) continue
        if (inputBytes + s.size + 1 > CANVAS_SNAPSHOT_INPUT_LIMIT) break
        const buffer = Buffer.alloc(s.size + 1)
        let length = 0, n = 0
        do { n = readSync(fd, buffer, length, buffer.length - length, null); length += n } while (n && length < buffer.length)
        inputBytes += length
        if (length > s.size || length + total > CANVAS_SNAPSHOT_TOTAL_LIMIT) continue
        const dest = join(staging, relative(root, file))
        mkdirSync(dirname(dest), { recursive: true, mode: 0o700 }); writeFileSync(dest, buffer.subarray(0, length), { mode: 0o600 })
        total += length
      } finally { if (fd !== undefined) closeSync(fd) }
    }
    if (priority && (!canvasRelativePath(priority) || !existsSync(join(staging, priority)))) return undefined
    renameSync(staging, join(snapshotRoot, id))
    return id
  } finally { rmSync(staging, { recursive: true, force: true }) }
}
