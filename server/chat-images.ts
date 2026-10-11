import { createHash, randomBytes } from 'node:crypto'
import { constants, createReadStream, existsSync, mkdirSync, renameSync, utimesSync, writeFileSync } from 'node:fs'
import { copyFile, mkdir, readFile, readdir, rename, rmdir, stat, unlink, utimes, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import {
  CHAT_IMAGE_EXTENSIONS,
  MAX_CHAT_IMAGE_BYTES,
  chatImageType,
  isChatImageId,
  type ChatImageRef,
  type ChatImageType,
} from '../shared/agent-chat.js'

/**
 * Chat images live in one Commando folder, named by content hash: the daemon
 * serves thumbnails from it without knowing which pane or profile wrote them,
 * the same image is stored once however often it is replayed, and Claude's
 * own config folders stay Claude's. Hosts read uploads from it and write the
 * images they find in tool results and resumed transcripts.
 *
 * Claude never sees this folder: it holds every chat's images. Each Claude
 * session gets its own folder beside it (`chat-image-sessions/<session id>`)
 * holding copies of the images attached in that session, and only that
 * folder is opened to Claude's tools.
 */
export function chatImagesDir(env: Record<string, string | undefined> = process.env): string {
  return env.COMMANDO_CHAT_IMAGES_DIR || join(homedir(), '.commando', 'chat-images')
}

/** Images in tool results can be larger than the ones people attach. */
const MAX_STORED_IMAGE_BYTES = 32 * 1024 * 1024
/** Unused images are pruned; a resumed transcript stores them again. */
export const CHAT_IMAGE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000
/** Claude session ids name the session folders; the same rule the host checks `--resume` with. */
const SESSION_ID = /^[A-Za-z0-9-]{8,80}$/
const TEMPORARY = /^\.[0-9a-f]{64}\.\w+\.[0-9a-f]+\.tmp$/

/** The image type from its first bytes; the declared type is never trusted. */
export function sniffImageType(bytes: Uint8Array): ChatImageType | null {
  const ascii = (start: number, text: string) => [...text].every((char, index) => bytes[start + index] === char.charCodeAt(0))
  if (bytes.length >= 8 && bytes[0] === 0x89 && ascii(1, 'PNG\r\n\x1a\n')) return 'image/png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.length >= 6 && (ascii(0, 'GIF87a') || ascii(0, 'GIF89a'))) return 'image/gif'
  if (bytes.length >= 12 && ascii(0, 'RIFF') && ascii(8, 'WEBP')) return 'image/webp'
  return null
}

export type ChatImageSaveError = 'unsupported' | 'too_large' | 'empty'

export class ChatImageStore {
  private loggedWriteFailure = false

  /** `log` hears about images that couldn't be stored (once per kind of failure). */
  constructor(
    readonly dir: string = chatImagesDir(),
    private readonly log?: (message: string) => void,
    readonly sessionsDir: string = join(dirname(dir), 'chat-image-sessions'),
  ) {}

  path(id: string): string | null {
    return isChatImageId(id) ? join(this.dir, id) : null
  }

  async exists(id: string): Promise<boolean> {
    const path = this.path(id)
    if (!path) return false
    try {
      return (await stat(path)).isFile()
    } catch {
      return false
    }
  }

  /** Stores an upload; refuses anything that is not a supported image within the limit. */
  async save(bytes: Uint8Array, maxBytes = MAX_CHAT_IMAGE_BYTES): Promise<{ id: string } | { error: ChatImageSaveError }> {
    const checked = this.check(bytes, maxBytes)
    if ('error' in checked) return checked
    await mkdir(this.dir, { recursive: true, mode: 0o700 })
    const path = join(this.dir, checked.id)
    if (existsSync(path)) {
      // Keep a reused image from being pruned.
      const now = new Date()
      await utimes(path, now, now).catch(() => undefined)
      return checked
    }
    const temporary = join(this.dir, `.${checked.id}.${randomBytes(6).toString('hex')}.tmp`)
    await writeFile(temporary, bytes, { mode: 0o600 })
    await rename(temporary, path)
    return checked
  }

  /**
   * Stores an image found in a tool result or transcript. Synchronous so the
   * item mapper can attach the ref as it maps; returns undefined when the data
   * is not a usable image.
   */
  saveBase64(data: string, name?: string): ChatImageRef | undefined {
    const bytes = Buffer.from(data, 'base64')
    const checked = this.check(bytes, MAX_STORED_IMAGE_BYTES)
    // Not an image Commando can show (another type, or too big); the row keeps its [image] text.
    if ('error' in checked) return undefined
    try {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 })
      const path = join(this.dir, checked.id)
      if (existsSync(path)) {
        const now = new Date()
        utimesSync(path, now, now)
      } else {
        const temporary = join(this.dir, `.${checked.id}.${randomBytes(6).toString('hex')}.tmp`)
        writeFileSync(temporary, bytes, { mode: 0o600 })
        renameSync(temporary, path)
      }
    } catch (error) {
      if (!this.loggedWriteFailure) {
        this.loggedWriteFailure = true
        this.log?.(`Couldn't store chat images in ${this.dir}: ${error instanceof Error ? error.message : String(error)}`)
      }
      return undefined
    }
    return name ? { id: checked.id, name } : { id: checked.id }
  }

  /** An uploaded image's bytes, for the message that sends it to Claude. */
  async read(id: string): Promise<Buffer> {
    const path = this.path(id)
    if (!path) throw new Error('Invalid image id')
    const stats = await stat(path)
    if (!stats.isFile() || stats.size > MAX_STORED_IMAGE_BYTES) throw new Error('Not a stored image')
    return readFile(path)
  }

  /** Creates the one folder of images Claude may open in a session, and returns it. */
  sessionDir(sessionId: string): string {
    const folder = this.sessionFolder(sessionId)
    mkdirSync(folder, { recursive: true, mode: 0o700 })
    return folder
  }

  /** The image and session a staged copy's path names, or null for any other path. */
  stagedImage(path: string): { id: string; sessionId: string } | null {
    const id = basename(path)
    const sessionId = basename(dirname(path))
    return dirname(dirname(path)) === this.sessionsDir && SESSION_ID.test(sessionId) && isChatImageId(id) ? { id, sessionId } : null
  }

  /**
   * Copies a stored image into a session's folder and returns the copy's path.
   * A copy rather than a link: through a hard link, Claude could edit the
   * stored bytes every chat shares, and a symlink resolves to the store, which
   * Claude can't open. On APFS the copy is a clone, so it costs no space.
   */
  async stage(id: string, sessionId: string): Promise<string> {
    const source = this.path(id)
    if (!source) throw new Error('Invalid image id')
    const folder = this.sessionFolder(sessionId)
    await mkdir(folder, { recursive: true, mode: 0o700 })
    const path = join(folder, id)
    // Copied every time, so the file matches its name even if Claude changed it.
    const temporary = join(folder, `.${id}.${randomBytes(6).toString('hex')}.tmp`)
    await copyFile(source, temporary, constants.COPYFILE_FICLONE)
    // A clone keeps the stored file's time; the copy's age should count from now.
    const now = new Date()
    await utimes(temporary, now, now)
    await rename(temporary, path)
    return path
  }

  /**
   * Deletes images nobody has stored or replayed for `maxAgeMs`, in the store
   * and in session folders, and session folders left empty.
   */
  async prune(maxAgeMs = CHAT_IMAGE_MAX_AGE_MS, now = Date.now()): Promise<number> {
    let removed = await pruneFolder(this.dir, maxAgeMs, now)
    for (const name of await listFolder(this.sessionsDir) ?? []) {
      if (!SESSION_ID.test(name)) continue
      const folder = join(this.sessionsDir, name)
      // Read before pruning, which touches the folder. A new session's folder stays empty
      // until its first image, so only an old folder is removed.
      const stats = await stat(folder).catch(() => null)
      if (!stats?.isDirectory()) continue
      removed += await pruneFolder(folder, maxAgeMs, now)
      try {
        if (now - stats.mtimeMs > maxAgeMs) await rmdir(folder)
      } catch (error) {
        if (!['ENOENT', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
      }
    }
    return removed
  }

  private sessionFolder(sessionId: string): string {
    if (!SESSION_ID.test(sessionId)) throw new Error(`Invalid session id: ${sessionId}`)
    return join(this.sessionsDir, sessionId)
  }

  private check(bytes: Uint8Array, maxBytes: number): { id: string } | { error: ChatImageSaveError } {
    if (bytes.length === 0) return { error: 'empty' }
    if (bytes.length > maxBytes) return { error: 'too_large' }
    const type = sniffImageType(bytes)
    if (!type) return { error: 'unsupported' }
    return { id: `${createHash('sha256').update(bytes).digest('hex')}.${CHAT_IMAGE_EXTENSIONS[type]}` }
  }
}

/** A folder's names, or null when it doesn't exist yet. */
async function listFolder(folder: string): Promise<string[] | null> {
  try {
    return await readdir(folder)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

async function pruneFolder(folder: string, maxAgeMs: number, now: number): Promise<number> {
  let removed = 0
  for (const name of await listFolder(folder) ?? []) {
    // Only our own files: content-hash names and abandoned temporaries.
    if (!isChatImageId(name) && !TEMPORARY.test(name)) continue
    const path = join(folder, name)
    try {
      const stats = await stat(path)
      if (now - stats.mtimeMs > maxAgeMs) {
        await unlink(path)
        removed += 1
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  return removed
}

const UPLOAD_ERRORS: Record<ChatImageSaveError, [number, string]> = {
  unsupported: [415, 'Only PNG, JPEG, GIF and WebP images can be attached'],
  too_large: [413, 'Images must be 10 MB or smaller'],
  empty: [400, 'The image is empty'],
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
  response.end(JSON.stringify(body))
}

/** Past this, an oversized upload is cut off instead of read to the end. */
const MAX_DRAIN_BYTES = 64 * 1024 * 1024

/**
 * Reads a request body, or null when it is over `maxBytes`. An oversized body
 * is still read (and dropped) so the client receives the 413 rather than a
 * reset connection, unless it is absurdly large.
 */
async function readBody(request: IncomingMessage, maxBytes: number): Promise<Buffer | null> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > MAX_DRAIN_BYTES) {
      request.destroy()
      return null
    }
    if (size <= maxBytes) chunks.push(buffer)
  }
  return size > maxBytes ? null : Buffer.concat(chunks)
}

/**
 * `POST /api/chat/images` (behind the API's auth): the raw image as the body.
 * Uploads travel apart from the chat WebSocket, so a large image neither
 * stalls terminal output nor needs a bigger frame limit.
 */
export async function handleChatImageUpload(request: IncomingMessage, response: ServerResponse, url: URL, store: ChatImageStore): Promise<boolean> {
  if (url.pathname !== '/api/chat/images') return false
  if (request.method !== 'POST') {
    response.writeHead(405, { Allow: 'POST' })
    response.end()
    return true
  }
  const body = await readBody(request, MAX_CHAT_IMAGE_BYTES)
  if (!body) {
    if (!response.destroyed) json(response, 413, { error: UPLOAD_ERRORS.too_large[1] })
    return true
  }
  let saved: Awaited<ReturnType<ChatImageStore['save']>>
  try {
    saved = await store.save(body)
  } catch (error) {
    console.error('[commando] chat image upload could not be stored', error)
    json(response, 507, { error: `Commando couldn't store the image: ${(error as NodeJS.ErrnoException).code ?? 'write failed'}` })
    return true
  }
  if ('error' in saved) {
    const [status, message] = UPLOAD_ERRORS[saved.error]
    json(response, status, { error: message })
    return true
  }
  json(response, 201, { image: { id: saved.id } })
  return true
}

/**
 * `GET /chat-images/<sha256>.<ext>`: served without the API token, like pane
 * screenshots, so plain `<img>` tags can load it. The id is the content's
 * hash, so it can only be asked for by someone who already has the image.
 */
export async function handleChatImage(request: IncomingMessage, response: ServerResponse, url: URL, store: ChatImageStore): Promise<boolean> {
  const match = /^\/chat-images\/([^/]+)$/.exec(url.pathname)
  if (!match) return false
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, { Allow: 'GET, HEAD' })
    response.end()
    return true
  }
  const id = match[1]!
  const path = store.path(id)
  let size = 0
  try {
    const stats = path ? await stat(path) : null
    if (!stats?.isFile()) throw new Error('missing')
    size = stats.size
  } catch {
    response.writeHead(404, { 'Cache-Control': 'no-store' })
    response.end()
    return true
  }
  response.writeHead(200, {
    'Content-Type': chatImageType(id),
    'Content-Length': size,
    // Content-addressed: the bytes behind an id never change.
    'Cache-Control': 'private, max-age=31536000, immutable',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'",
  })
  if (request.method === 'HEAD') {
    response.end()
    return true
  }
  const stream = createReadStream(path!)
  stream.on('error', () => response.destroy())
  stream.pipe(response)
  return true
}
