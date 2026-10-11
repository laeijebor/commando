import { createHash } from 'node:crypto'
import { mkdir, readdir, stat, unlink, utimes, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import { chatPlansDir } from './chat-plans-dir.js'
import type { NoteVaultManager } from './note-vaults.js'
import { chatPlanTitle } from '../shared/agent-chat.js'
import { MAX_NOTE_BODY_LENGTH, MAX_NOTE_TITLE_LENGTH } from './notes.js'

/** Saved plans go in this folder of the default vault. */
export const CHAT_PLANS_FOLDER = 'Plans'
const MAX_PLAN_BYTES = 256 * 1024
/** Plan files a new chat pane read on start are pruned like chat images. */
const CHAT_PLAN_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

export class ChatPlanStore {
  constructor(private readonly vaults: NoteVaultManager, readonly dir: string = chatPlansDir()) {}

  /** Files the plan as a note in the default vault's Plans folder. */
  async saveToVault(markdown: string): Promise<{ path: string; title: string; noteId: string }> {
    const { store } = await this.vaults.defaultStore()
    const title = chatPlanTitle(markdown, MAX_NOTE_TITLE_LENGTH)
    const note = await store.create({ title, body: markdown.trim().slice(0, MAX_NOTE_BODY_LENGTH), folder: CHAT_PLANS_FOLDER })
    return { path: store.pathFor(note), title, noteId: note.id }
  }

  /** Writes the plan where a new chat can read it, named by its content. */
  async stash(markdown: string): Promise<{ path: string }> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 })
    const path = join(this.dir, `${createHash('sha256').update(markdown).digest('hex')}.md`)
    await writeFile(path, markdown, { mode: 0o600 })
    // Re-saving an old plan counts as using it.
    const now = new Date()
    await utimes(path, now, now)
    return { path }
  }

  /** Removes plan files nobody has used for a month. */
  async prune(now = Date.now()): Promise<number> {
    let names: string[]
    try {
      names = await readdir(this.dir)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0
      throw error
    }
    let removed = 0
    for (const name of names) {
      if (!/^[0-9a-f]{64}\.md$/.test(name)) continue
      const path = join(this.dir, name)
      const info = await stat(path).catch(() => null)
      if (info && now - info.mtimeMs > CHAT_PLAN_MAX_AGE_MS) {
        try {
          await unlink(path)
          removed += 1
        } catch (error) {
          console.warn(`[commando] couldn't prune the chat plan ${path}`, error)
        }
      }
    }
    return removed
  }
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
  response.end(JSON.stringify(body))
}

async function readPlan(request: IncomingMessage): Promise<string | { error: string; status: number }> {
  if (request.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
    return { error: 'Content-Type must be application/json', status: 415 }
  }
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > MAX_PLAN_BYTES * 2) return { error: 'The plan is too long', status: 413 }
    chunks.push(buffer)
  }
  let value: unknown
  try {
    value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return { error: 'The request is not valid JSON', status: 400 }
  }
  const markdown = typeof value === 'object' && value !== null ? (value as { markdown?: unknown }).markdown : undefined
  if (typeof markdown !== 'string' || !markdown.trim()) return { error: 'A plan is required', status: 400 }
  if (Buffer.byteLength(markdown, 'utf8') > MAX_PLAN_BYTES || markdown.includes('\0')) return { error: 'The plan is too long', status: 413 }
  return markdown
}

/**
 * `POST /api/chat/plans/vault` files a chat's plan in the default notes vault;
 * `POST /api/chat/plans/file` stashes it for a new chat pane to read. Both take
 * `{ markdown }` and answer with the saved path. Behind the API's auth.
 */
export async function handleChatPlans(request: IncomingMessage, response: ServerResponse, url: URL, store: ChatPlanStore): Promise<boolean> {
  const target = url.pathname === '/api/chat/plans/vault' ? 'vault' : url.pathname === '/api/chat/plans/file' ? 'file' : null
  if (!target) return false
  if (request.method !== 'POST') {
    response.writeHead(405, { Allow: 'POST' })
    response.end()
    return true
  }
  const plan = await readPlan(request)
  if (typeof plan !== 'string') {
    json(response, plan.status, { error: plan.error })
    return true
  }
  try {
    json(response, 201, target === 'vault' ? await store.saveToVault(plan) : await store.stash(plan))
  } catch (error) {
    console.error(`[commando] couldn't save a chat plan (${target})`, error)
    json(response, 500, { error: `Commando couldn't save the plan: ${error instanceof Error ? error.message : String(error)}` })
  }
  return true
}
