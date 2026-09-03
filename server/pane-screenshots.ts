import { randomBytes } from 'node:crypto'
import { close as closeCallback, constants, createReadStream, fstat as fstatCallback, open as openCallback, readFileSync, realpathSync, renameSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import type { Stats } from 'node:fs'
import { readdir, realpath, stat } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { homedir } from 'node:os'
import { basename, dirname, extname, isAbsolute, join, normalize, resolve, sep } from 'node:path'

import type { PaneScreenshotFile, PaneScreenshotFolder } from '../shared/protocol.js'

export const PANE_SCREENSHOT_PREVIEW_LIMIT = 6
export const PANE_SCREENSHOT_PER_PANE_LIMIT = 5
export const PANE_SCREENSHOT_GLOBAL_LIMIT = 64
export const PANE_SCREENSHOT_TTL_MS = 7 * 24 * 60 * 60 * 1_000
export const MAX_SCREENSHOT_FILES = 500
export const MAX_SCREENSHOT_FILE_BYTES = 50 * 1024 * 1024

const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/u
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp'])
const CONTENT_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
}

type Registration = {
  id: string
  paneId: string
  dir: string
  registeredAt: number
}

type RegistryOptions = {
  statePath?: string
  now?: () => number
}

export class PaneScreenshotError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

export function defaultPaneScreenshotStatePath(port: number): string {
  return process.env.COMMANDO_PANE_SCREENSHOTS_PATH
    ?? join(homedir(), '.commando', `pane-screenshots-${port}.json`)
}

function isImage(name: string): boolean {
  return IMAGE_EXTENSIONS.has(extname(name).toLowerCase())
}

function isPaneId(value: unknown): value is string {
  return typeof value === 'string' && /^%\d+$/.test(value)
}

async function canonicalDirectory(dir: string): Promise<string> {
  if (!isAbsolute(dir) || Buffer.byteLength(dir, 'utf8') > 4_096 || CONTROL_CHARACTER.test(dir)) {
    throw new PaneScreenshotError(400, 'dir must be an absolute path without control characters')
  }
  let real: string
  try {
    real = await realpath(dir)
  } catch {
    throw new PaneScreenshotError(400, 'dir does not exist')
  }
  try {
    if (!(await stat(real)).isDirectory()) throw new PaneScreenshotError(400, 'dir must be a directory')
  } catch (error) {
    if (error instanceof PaneScreenshotError) throw error
    throw new PaneScreenshotError(400, 'dir must be a directory')
  }
  return real
}

function inside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root + sep)
}

function openReadOnlyNoFollow(path: string): Promise<number> {
  return new Promise((resolveOpen, rejectOpen) => {
    openCallback(path, constants.O_RDONLY | constants.O_NOFOLLOW, (error, fd) => {
      if (error) rejectOpen(error)
      else resolveOpen(fd)
    })
  })
}

function statDescriptor(fd: number): Promise<Stats> {
  return new Promise((resolveStat, rejectStat) => {
    fstatCallback(fd, (error, stats) => {
      if (error) rejectStat(error)
      else resolveStat(stats)
    })
  })
}

function closeDescriptor(fd: number): Promise<void> {
  return new Promise((resolveClose, rejectClose) => {
    closeCallback(fd, (error) => {
      if (error) rejectClose(error)
      else resolveClose()
    })
  })
}

async function scanDirectory(dir: string): Promise<{ files: PaneScreenshotFile[]; otherCount: number; bytes: number; truncated: boolean }> {
  if (await realpath(dir) !== dir || !(await stat(dir)).isDirectory()) throw new Error('Screenshot directory identity changed')
  const files: PaneScreenshotFile[] = []
  let otherCount = 0
  let bytes = 0
  const entries = await readdir(dir)
  const truncated = entries.length > MAX_SCREENSHOT_FILES
  for (const entry of entries.slice(0, MAX_SCREENSHOT_FILES)) {
    const candidate = join(dir, entry)
    let real: string
    let stats: ReturnType<typeof statSync>
    try {
      real = await realpath(candidate)
      if (!inside(dir, real)) continue
      stats = await stat(real)
    } catch {
      continue
    }
    if (!stats.isFile()) continue
    bytes += stats.size
    if (isImage(entry) && stats.size <= MAX_SCREENSHOT_FILE_BYTES) {
      files.push({ name: entry, size: stats.size, modifiedAt: stats.mtimeMs })
    } else {
      otherCount += 1
    }
  }
  files.sort((left, right) => right.modifiedAt - left.modifiedAt || left.name.localeCompare(right.name))
  return { files, otherCount, bytes, truncated }
}

/** Persistent, capability-id registry for pane-published screenshot folders. */
export class PaneScreenshotRegistry {
  private readonly registrations: Registration[] = []
  private readonly statePath: string | null
  private readonly now: () => number
  private registrationUpdates: Promise<void> = Promise.resolve()

  constructor(options: RegistryOptions = {}) {
    this.statePath = options.statePath ?? null
    this.now = options.now ?? Date.now
    this.load()
  }

  async register(paneId: string, inputDir: string): Promise<PaneScreenshotFolder> {
    const operation = this.registrationUpdates.then(() => this.registerNow(paneId, inputDir))
    this.registrationUpdates = operation.then(() => undefined, () => undefined)
    return operation
  }

  private async registerNow(paneId: string, inputDir: string): Promise<PaneScreenshotFolder> {
    if (!isPaneId(paneId)) throw new PaneScreenshotError(400, 'paneId must be a tmux pane id')
    const dir = await canonicalDirectory(inputDir)
    const now = this.now()
    let registrations = this.activeRegistrations(now)
    const known = registrations.find((entry) => entry.dir === dir)
    const existing = registrations.find((entry) => entry.paneId === paneId && entry.dir === dir)
    const id = known?.id ?? randomBytes(8).toString('hex')
    registrations = registrations.filter((entry) => entry !== existing)
    registrations.push({ id, paneId, dir, registeredAt: now })

    const paneEntries = registrations
      .filter((entry) => entry.paneId === paneId)
      .sort((left, right) => right.registeredAt - left.registeredAt)
    const evictedFromPane = new Set(paneEntries.slice(PANE_SCREENSHOT_PER_PANE_LIMIT).map((entry) => entry.id + entry.dir))
    registrations = registrations.filter((entry) => !evictedFromPane.has(entry.id + entry.dir) || entry.paneId !== paneId)

    const newestById = new Map<string, number>()
    for (const entry of registrations) newestById.set(entry.id, Math.max(newestById.get(entry.id) ?? 0, entry.registeredAt))
    const retainedIds = new Set([...newestById]
      .sort((left, right) => right[1] - left[1])
      .slice(0, PANE_SCREENSHOT_GLOBAL_LIMIT)
      .map(([entryId]) => entryId))
    registrations = registrations.filter((entry) => retainedIds.has(entry.id))
    this.commit(registrations)
    return this.folderFor({ id, paneId, dir, registeredAt: now }, false)
  }

  isRegisteredForPane(paneId: string, id: string): boolean {
    return this.activeRegistrations().some((entry) => entry.paneId === paneId && entry.id === id)
  }

  /** Resolve the registered directory or a file within it for a pane reveal action. */
  async resolveForPane(paneId: string, id: string, file?: string): Promise<string | null> {
    const entry = this.activeRegistrations().find((candidate) => candidate.paneId === paneId && candidate.id === id)
    if (!entry) return null
    if (file === undefined) {
      try {
        return await realpath(entry.dir) === entry.dir && (await stat(entry.dir)).isDirectory() ? entry.dir : null
      } catch {
        return null
      }
    }
    return this.resolveFile(entry, encodeURIComponent(file), true)
  }

  async resolveImage(id: string, requestPath: string): Promise<string | null> {
    const entry = this.activeRegistrations().find((candidate) => candidate.id === id)
    return entry ? this.resolveFile(entry, requestPath, true) : null
  }

  async list(id: string): Promise<(PaneScreenshotFolder & { files: PaneScreenshotFile[] }) | null> {
    const entry = this.activeRegistrations().find((candidate) => candidate.id === id)
    if (!entry) return null
    try {
      const listing = await scanDirectory(entry.dir)
      return {
        id: entry.id,
        dir: entry.dir,
        topic: basename(entry.dir),
        imageCount: listing.files.length,
        otherCount: listing.otherCount,
        bytes: listing.bytes,
        updatedAt: entry.registeredAt,
        ...(listing.truncated ? { truncated: true as const } : {}),
        preview: listing.files.slice(0, PANE_SCREENSHOT_PREVIEW_LIMIT),
        files: listing.files,
      }
    } catch {
      return {
        id: entry.id,
        dir: entry.dir,
        topic: basename(entry.dir),
        imageCount: 0,
        otherCount: 0,
        bytes: 0,
        updatedAt: entry.registeredAt,
        missing: true,
        preview: [],
        files: [],
      }
    }
  }

  async registrationsForPane(paneId: string): Promise<PaneScreenshotFolder[]> {
    return Promise.all(this.activeRegistrations()
      .filter((entry) => entry.paneId === paneId)
      .sort((left, right) => right.registeredAt - left.registeredAt)
      .map((entry) => this.folderFor(entry, true)))
  }

  private async folderFor(entry: Registration, tolerateMissing: boolean): Promise<PaneScreenshotFolder> {
    try {
      const listing = await scanDirectory(entry.dir)
      return {
        id: entry.id,
        dir: entry.dir,
        topic: basename(entry.dir),
        imageCount: listing.files.length,
        otherCount: listing.otherCount,
        bytes: listing.bytes,
        updatedAt: entry.registeredAt,
        ...(listing.truncated ? { truncated: true as const } : {}),
        preview: listing.files.slice(0, PANE_SCREENSHOT_PREVIEW_LIMIT),
      }
    } catch {
      if (!tolerateMissing) throw new PaneScreenshotError(400, 'dir is not readable')
      return {
        id: entry.id,
        dir: entry.dir,
        topic: basename(entry.dir),
        imageCount: 0,
        otherCount: 0,
        bytes: 0,
        updatedAt: entry.registeredAt,
        missing: true,
        preview: [],
      }
    }
  }

  private async resolveFile(entry: Registration, requestPath: string, imageOnly: boolean): Promise<string | null> {
    let decoded: string
    try {
      decoded = decodeURIComponent(requestPath)
    } catch {
      return null
    }
    if (!decoded || decoded.includes('\0') || CONTROL_CHARACTER.test(decoded) || isAbsolute(decoded)) return null
    const normalized = normalize(decoded)
    if (normalized === '..' || normalized.startsWith(`..${sep}`)) return null
    const candidate = resolve(entry.dir, normalized)
    if (!inside(entry.dir, candidate) || (imageOnly && !isImage(candidate))) return null
    try {
      const real = await realpath(candidate)
      return inside(entry.dir, real) && (!imageOnly || isImage(real)) && (await stat(real)).isFile() ? real : null
    } catch {
      return null
    }
  }

  private activeRegistrations(now = this.now()): Registration[] {
    return this.registrations.filter((entry) => entry.registeredAt >= now - PANE_SCREENSHOT_TTL_MS)
  }

  private load(): void {
    if (!this.statePath) return
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(this.statePath, 'utf8')) as unknown
    } catch {
      return
    }
    if (typeof parsed !== 'object' || parsed === null || (parsed as { version?: unknown }).version !== 1) return
    const values = (parsed as { registrations?: unknown }).registrations
    if (!Array.isArray(values)) return
    const now = this.now()
    const cutoff = now - PANE_SCREENSHOT_TTL_MS
    const valid: Registration[] = []
    const paneCounts = new Map<string, number>()
    const dirsById = new Map<string, string>()
    for (const value of values.sort((a, b) => Number((b as Registration)?.registeredAt ?? 0) - Number((a as Registration)?.registeredAt ?? 0))) {
      if (typeof value !== 'object' || value === null) continue
      const { id, paneId, dir, registeredAt } = value as Partial<Registration>
      if (typeof id !== 'string' || !/^[0-9a-f]{16}$/.test(id) || !isPaneId(paneId) ||
        typeof dir !== 'string' || !isAbsolute(dir) || CONTROL_CHARACTER.test(dir) || Buffer.byteLength(dir, 'utf8') > 4_096 ||
        typeof registeredAt !== 'number' || !Number.isFinite(registeredAt) || registeredAt < cutoff) continue
      let real: string
      try {
        real = realpathSync(dir)
        if (real !== dir || !statSync(real).isDirectory()) continue
      } catch {
        continue
      }
      if (dirsById.has(id) && dirsById.get(id) !== real) continue
      if ([...dirsById].some(([otherId, otherDir]) => otherId !== id && otherDir === real)) continue
      const count = paneCounts.get(paneId) ?? 0
      if (count >= PANE_SCREENSHOT_PER_PANE_LIMIT) continue
      const ids = new Set(valid.map((entry) => entry.id))
      if (!ids.has(id) && ids.size >= PANE_SCREENSHOT_GLOBAL_LIMIT) continue
      const clamped = Math.min(registeredAt, now)
      if (valid.some((entry) => entry.paneId === paneId && entry.id === id)) continue
      valid.push({ id, paneId, dir: real, registeredAt: clamped })
      paneCounts.set(paneId, count + 1)
      dirsById.set(id, real)
    }
    this.registrations.push(...valid)
    this.persist(valid)
  }

  private commit(registrations: Registration[]): void {
    this.persist(registrations)
    this.registrations.splice(0, this.registrations.length, ...registrations)
  }

  private persist(registrations: Registration[]): void {
    if (!this.statePath) return
    mkdirSync(dirname(this.statePath), { recursive: true, mode: 0o700 })
    const temporary = `${this.statePath}.${process.pid}.tmp`
    writeFileSync(temporary, JSON.stringify({ version: 1, registrations }, null, 2), { mode: 0o600 })
    renameSync(temporary, this.statePath)
  }
}

export async function handlePaneScreenshotImage(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  registry: PaneScreenshotRegistry,
): Promise<boolean> {
  const match = /^\/screenshots\/([0-9a-f]{16})\/(.+)$/.exec(url.pathname)
  if (!match) return false
  if (request.method !== 'GET') {
    response.writeHead(405, { Allow: 'GET' })
    response.end()
    return true
  }
  const file = await registry.resolveImage(match[1], match[2])
  if (!file) {
    response.writeHead(404, { 'Cache-Control': 'no-store' })
    response.end()
    return true
  }
  let fd: number | null = null
  let size = 0
  try {
    fd = await openReadOnlyNoFollow(file)
    const stats = await statDescriptor(fd)
    if (!stats.isFile() || stats.size > MAX_SCREENSHOT_FILE_BYTES) {
      await closeDescriptor(fd)
      fd = null
      response.writeHead(404, { 'Cache-Control': 'no-store' })
      response.end()
      return true
    }
    size = stats.size
  } catch {
    if (fd !== null) await closeDescriptor(fd).catch(() => undefined)
    response.writeHead(404, { 'Cache-Control': 'no-store' })
    response.end()
    return true
  }
  response.writeHead(200, {
    'Cache-Control': 'no-store',
    'Content-Length': size,
    'Content-Type': CONTENT_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
    'X-Content-Type-Options': 'nosniff',
  })
  const stream = createReadStream(file, { fd, autoClose: true })
  stream.on('error', () => response.destroy())
  stream.pipe(response)
  return true
}

export async function handlePaneScreenshotApi(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  registry: PaneScreenshotRegistry,
): Promise<boolean> {
  const match = /^\/api\/screenshots\/([0-9a-f]{16})$/.exec(url.pathname)
  if (!match) return false
  if (request.method !== 'GET') {
    response.writeHead(405, { Allow: 'GET' })
    response.end()
    return true
  }
  const folder = await registry.list(match[1])
  if (!folder) {
    const body = JSON.stringify({ error: 'Not found' }) + '\n'
    response.writeHead(404, { 'Cache-Control': 'no-store', 'Content-Type': 'application/json; charset=utf-8' })
    response.end(body)
    return true
  }
  const body = JSON.stringify({ ok: true, folder }) + '\n'
  response.writeHead(200, {
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
    'Content-Type': 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
  })
  response.end(body)
  return true
}
