import { randomBytes, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  MAX_CHAT_STASH_BYTES,
  MAX_CHAT_STASH_ENTRIES,
  MAX_CHAT_STASH_TEXT,
  isChatStashId,
  parseChatStashEntry,
  parseChatStashInput,
  type ChatStashEntry,
  type ChatStashInput,
} from '../shared/chat-stash.js'

/** One list per daemon, like canvas threads, so a test daemon never sees the live one's. */
export function defaultChatStashPath(port = 4310): string {
  return process.env.COMMANDO_CHAT_STASH_PATH ?? join(homedir(), '.commando', `chat-stash-${port}.json`)
}

/** What the stash asks of the chat image store; entries hold image ids, not bytes. */
export interface ChatStashImages {
  exists(id: string): Promise<boolean>
  /** Keeps a stashed image from being pruned as unused. */
  touch(id: string): Promise<void>
}

type StateFile = { version: 1; entries: ChatStashEntry[] }

function cloneEntry(entry: ChatStashEntry): ChatStashEntry {
  return { ...entry, images: entry.images.map((image) => ({ ...image })), source: { ...entry.source } }
}

/** Newest first, within the entry and size caps. */
function capped(entries: ChatStashEntry[]): ChatStashEntry[] {
  const kept: ChatStashEntry[] = []
  let bytes = 0
  for (const entry of entries) {
    bytes += Buffer.byteLength(entry.text)
    if (kept.length >= MAX_CHAT_STASH_ENTRIES || (kept.length && bytes > MAX_CHAT_STASH_BYTES)) break
    kept.push(entry)
  }
  return kept
}

export class ChatStashStore {
  /** Newest first. */
  private entries: ChatStashEntry[] = []
  private writes: Promise<void> = Promise.resolve()

  constructor(readonly statePath: string = defaultChatStashPath(), private readonly images?: ChatStashImages) {}

  async load(): Promise<void> {
    let raw: string
    try {
      raw = await readFile(this.statePath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    let value: unknown
    try {
      value = JSON.parse(raw) as unknown
    } catch (error) {
      throw new Error('Chat stash file contains invalid JSON', { cause: error })
    }
    const state = value as Partial<StateFile> | null
    if (!state || state.version !== 1 || !Array.isArray(state.entries)) throw new Error('Chat stash file has an invalid structure')
    // A bad entry is dropped rather than losing every other draft with it.
    const entries = state.entries.flatMap((candidate) => {
      const entry = parseChatStashEntry(candidate)
      return entry ? [entry] : []
    })
    this.entries = capped(entries.sort((left, right) => right.createdAt - left.createdAt))
    await this.touchImages(this.entries)
  }

  list(): ChatStashEntry[] {
    return this.entries.map(cloneEntry)
  }

  async push(input: ChatStashInput, now = Date.now()): Promise<ChatStashEntry> {
    const entry: ChatStashEntry = { id: randomBytes(16).toString('hex'), createdAt: now, ...input }
    await this.change(capped([entry, ...this.entries]))
    await this.touchImages([entry])
    return cloneEntry(entry)
  }

  /**
   * Removes an entry and returns it, or null when another client took it
   * first. Images the daemon no longer stores are left out and counted.
   */
  async take(id: string): Promise<{ entry: ChatStashEntry; missingImages: number } | null> {
    const entry = this.entries.find((candidate) => candidate.id === id)
    if (!entry) return null
    await this.change(this.entries.filter((candidate) => candidate !== entry))
    const stored = await Promise.all(entry.images.map((image) => this.images?.exists(image.id) ?? true))
    const images = entry.images.filter((_, index) => stored[index])
    return { entry: { ...cloneEntry(entry), images }, missingImages: entry.images.length - images.length }
  }

  /** Writes the new list; a failed write leaves the list as it was. */
  private async change(next: ChatStashEntry[]): Promise<void> {
    const previous = this.entries
    this.entries = next
    try {
      await this.persist()
    } catch (error) {
      if (this.entries === next) this.entries = previous
      throw error
    }
  }

  private async touchImages(entries: ChatStashEntry[]): Promise<void> {
    if (!this.images) return
    await Promise.all(entries.flatMap((entry) => entry.images.map((image) => this.images!.touch(image.id).catch(() => undefined))))
  }

  private persist(): Promise<void> {
    const entries = this.entries.map(cloneEntry)
    const operation = this.writes.then(() => this.writeState(entries))
    this.writes = operation.catch(() => undefined)
    return operation
  }

  private async writeState(entries: ChatStashEntry[]): Promise<void> {
    await mkdir(dirname(this.statePath), { recursive: true, mode: 0o700 })
    const temporaryPath = `${this.statePath}.${process.pid}.${randomUUID()}.tmp`
    try {
      const handle = await open(temporaryPath, 'wx', 0o600)
      try {
        await handle.writeFile(`${JSON.stringify({ version: 1, entries } satisfies StateFile)}\n`, 'utf8')
        await handle.sync()
      } finally {
        await handle.close()
      }
      await rename(temporaryPath, this.statePath)
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => undefined)
      throw error
    }
  }
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
  response.end(JSON.stringify(body))
}

/** Room for the largest draft, JSON-escaped, and its image refs. */
const MAX_BODY_BYTES = MAX_CHAT_STASH_TEXT * 6 + 64 * 1024

async function readJson(request: IncomingMessage): Promise<{ value: unknown; error?: never } | { error: string; status: number }> {
  if (request.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
    return { error: 'Content-Type must be application/json', status: 415 }
  }
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > MAX_BODY_BYTES) return { error: 'The draft is too long to stash', status: 413 }
    chunks.push(buffer)
  }
  try {
    return { value: JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown }
  } catch {
    return { error: 'The body is not valid JSON', status: 400 }
  }
}

/**
 * `/api/chat/stash` (behind the API's auth): `GET` lists, `POST` stashes a
 * draft, `DELETE /api/chat/stash/<id>` takes one out and returns it (pop,
 * restore and remove alike). `changed` runs after every change so the daemon
 * can push the new list to connected clients.
 */
export async function handleChatStashApi(request: IncomingMessage, response: ServerResponse, url: URL, store: ChatStashStore, changed: () => void): Promise<boolean> {
  if (url.pathname === '/api/chat/stash') {
    if (request.method === 'GET') {
      json(response, 200, { entries: store.list() })
      return true
    }
    if (request.method !== 'POST') {
      response.writeHead(405, { Allow: 'GET, POST' })
      response.end()
      return true
    }
    const body = await readJson(request)
    if (body.error !== undefined) {
      json(response, body.status, { error: body.error })
      return true
    }
    const input = parseChatStashInput(body.value)
    if (!input) {
      json(response, 400, { error: 'A stashed draft needs text or images, and the chat it came from' })
      return true
    }
    try {
      const entry = await store.push(input)
      changed()
      json(response, 201, { entry })
    } catch (error) {
      console.error('[commando] couldn\'t save the chat stash', error)
      json(response, 507, { error: `Commando couldn't save the stash: ${(error as NodeJS.ErrnoException).code ?? 'write failed'}` })
    }
    return true
  }
  const match = /^\/api\/chat\/stash\/([^/]+)$/.exec(url.pathname)
  if (!match) return false
  if (request.method !== 'DELETE') {
    response.writeHead(405, { Allow: 'DELETE' })
    response.end()
    return true
  }
  if (!isChatStashId(match[1])) {
    json(response, 404, { error: 'No such stashed draft' })
    return true
  }
  try {
    const taken = await store.take(match[1])
    if (!taken) {
      json(response, 404, { error: 'That draft was already taken from the stash' })
      return true
    }
    changed()
    json(response, 200, taken)
  } catch (error) {
    console.error('[commando] couldn\'t save the chat stash', error)
    json(response, 507, { error: `Commando couldn't save the stash: ${(error as NodeJS.ErrnoException).code ?? 'write failed'}` })
  }
  return true
}
