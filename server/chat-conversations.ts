import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { open, readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, isAbsolute, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { DatabaseSync } from 'node:sqlite'
import { stripAttachmentNotes } from '../shared/agent-chat.js'
import { isChatConversationSessionId, type ChatConversation, type ChatConversationProvider } from '../shared/chat-conversations.js'
import type { PaneRepo } from '../shared/protocol.js'
import { listClaudeProfiles } from './tmux-create.js'

/** Enough of a transcript's start for its folder and first prompt, and of its end for its latest title. */
const HEAD_BYTES = 256 * 1024
const MAX_HEAD_BYTES = 16 * 1024 * 1024
const TAIL_BYTES = 256 * 1024
/** The picker lists this many of the newest conversations. */
const DEFAULT_LIMIT = 1000
const MAX_TITLE = 200

type TranscriptFile = { provider: ChatConversationProvider; file: string; configDir?: string; cwd?: string }
type Candidate = TranscriptFile & { mtimeMs: number; size: number }
type Parsed = Omit<ChatConversation, 'updatedAt' | 'repoRoot' | 'checkoutRoot'> | null

export type ChatConversationIndexOptions = {
  home?: string
  codexHome?: string
  xdgDataHome?: string
  /** Claude config dirs to scan; defaults to the `~/.claude*` profiles. */
  claudeConfigDirs?: () => Promise<string[]>
  resolveRepos: (paths: readonly string[]) => Promise<Map<string, PaneRepo | undefined>>
  limit?: number
}

async function readSlice(file: string, position: number, length: number): Promise<string> {
  const handle = await open(file, 'r')
  try {
    const buffer = Buffer.alloc(length)
    const { bytesRead } = await handle.read(buffer, 0, length, position)
    return buffer.subarray(0, bytesRead).toString('utf8')
  } finally {
    await handle.close()
  }
}

/** Whole JSON lines from a slice; a line cut off at either edge is dropped. */
function jsonLines(text: string, { dropFirst, dropLast }: { dropFirst: boolean; dropLast: boolean }): Record<string, unknown>[] {
  const lines = text.split('\n')
  if (dropFirst) lines.shift()
  if (dropLast) lines.pop()
  return lines.flatMap((line) => {
    if (!line.trim()) return []
    try {
      const value = JSON.parse(line) as unknown
      return value && typeof value === 'object' && !Array.isArray(value) ? [value as Record<string, unknown>] : []
    } catch {
      return []
    }
  })
}

async function headAndTail(file: string, size: number): Promise<{ head: Record<string, unknown>[]; tail: Record<string, unknown>[]; headEnd: number }> {
  const startText = await readSlice(file, 0, Math.min(size, HEAD_BYTES))
  const head = jsonLines(startText, { dropFirst: false, dropLast: size > HEAD_BYTES })
  if (size <= HEAD_BYTES) return { head, tail: head, headEnd: size }
  const headEnd = Buffer.byteLength(startText.slice(0, startText.lastIndexOf('\n') + 1))
  const start = Math.max(HEAD_BYTES, size - TAIL_BYTES)
  return { head, tail: jsonLines(await readSlice(file, start, size - start), { dropFirst: true, dropLast: false }), headEnd }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function text(value: unknown): string {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return ''
  return value.map((part) => {
    const entry = record(part)
    return entry.type === 'text' || entry.type === 'input_text' ? String(entry.text ?? '') : ''
  }).join(' ')
}

/** A prompt the person typed, not a command caveat, hook output or injected instructions. */
function typedPrompt(value: string): string | undefined {
  // Attached images add notes (Codex's `<image …>` tags, Commando's saved-path notes) after the text.
  const trimmed = stripAttachmentNotes(value.replace(/<\/?image\b[^>]*>/g, ' ')).trim()
  const command = trimmed.match(/<command-name>\s*(\/[^\s<]+)\s*<\/command-name>/)?.[1]
  if (command) {
    const args = trimmed.match(/<command-args>([\s\S]*?)<\/command-args>/)?.[1]?.trim()
    if (!args && /^\/(clear|compact|resume|help|status|context|cost|exit|quit)$/.test(command)) return undefined
    return args ? `${command} ${args}` : command
  }
  if (!trimmed || trimmed.startsWith('<') || trimmed.startsWith('# AGENTS.md') || trimmed.startsWith('Base directory for this skill')) return undefined
  return trimmed
}

function shortTitle(value: string): string {
  const line = value.replace(/\s+/g, ' ').trim()
  return line.length > MAX_TITLE ? `${line.slice(0, MAX_TITLE - 1)}…` : line
}

export async function parseClaudeTranscript(file: string, size: number, configDir?: string): Promise<Parsed> {
  const sessionId = basename(file, '.jsonl')
  if (!isChatConversationSessionId(sessionId)) return null
  const { head, tail, headEnd } = await headAndTail(file, size)
  let cwd: string | undefined
  let branch: string | undefined
  let prompt: string | undefined
  const readEntry = (entry: Record<string, unknown>): boolean => {
    // `claude -p` runs are one-off jobs, not conversations to carry on.
    if (entry.entrypoint === 'sdk-cli') return false
    if (!cwd && typeof entry.cwd === 'string') cwd = entry.cwd
    if (!branch && typeof entry.gitBranch === 'string' && entry.gitBranch !== 'HEAD') branch = entry.gitBranch
    if (!prompt && entry.type === 'user' && !entry.isMeta && !entry.isSidechain) prompt = typedPrompt(text(record(entry.message).content))
    return true
  }
  for (const entry of head) {
    if (!readEntry(entry)) return null
    if (cwd && branch && prompt) break
  }
  // Inline images can push the first prompt beyond the head slice, or span it entirely.
  if ((!cwd || !prompt) && headEnd < size) {
    const stream = createReadStream(file, { start: headEnd, end: Math.min(size, MAX_HEAD_BYTES) - 1 })
    const reader = createInterface({ input: stream, crlfDelay: Infinity })
    try {
      for await (const line of reader) {
        for (const entry of jsonLines(line, { dropFirst: false, dropLast: false })) {
          if (!readEntry(entry)) return null
        }
        if (cwd && prompt) break
      }
    } finally {
      reader.close()
      stream.destroy()
    }
  }
  if (!cwd) return null
  let title: string | undefined
  // The newest title wins: a name the person gave it, else Claude's own.
  for (const key of ['customTitle', 'aiTitle', 'summary'] as const) {
    for (let index = tail.length - 1; index >= 0 && !title; index -= 1) {
      const value = tail[index]![key]
      if (typeof value === 'string' && value.trim()) title = value
    }
    if (title) break
  }
  const label = title ?? prompt
  if (!label) return null
  return { provider: 'claude', sessionId, cwd, title: shortTitle(label), ...(branch ? { branch } : {}), ...(configDir ? { configDir } : {}) }
}

/** Most rollouts are `codex exec` jobs; their first line says so, so only that is read for them. */
const META_BYTES = 64 * 1024

export async function parseCodexRollout(file: string, size: number, threadNames: ReadonlyMap<string, string>): Promise<Parsed> {
  const start = await readSlice(file, 0, Math.min(size, META_BYTES))
  const firstLine = start.includes('\n') ? jsonLines(start.slice(0, start.indexOf('\n')), { dropFirst: false, dropLast: false })[0] : undefined
  if (firstLine && (firstLine.type !== 'session_meta' || codexJob(record(firstLine.payload)))) return null
  const { head } = await headAndTail(file, Math.min(size, HEAD_BYTES))
  const meta = record(head[0]?.type === 'session_meta' ? head[0].payload : undefined)
  const sessionId = meta.id ?? meta.session_id
  if (!isChatConversationSessionId(sessionId) || typeof meta.cwd !== 'string') return null
  if (codexJob(meta)) return null
  let prompt: string | undefined
  let branch: string | undefined
  for (const entry of head) {
    const payload = record(entry.payload)
    if (!branch && typeof record(payload.git).branch === 'string') branch = record(payload.git).branch as string
    if (!prompt && entry.type === 'event_msg' && payload.type === 'user_message') prompt = typedPrompt(text(payload.message))
    if (!prompt && entry.type === 'response_item' && payload.type === 'message' && payload.role === 'user') prompt = typedPrompt(text(payload.content))
    if (prompt && branch) break
  }
  const title = threadNames.get(sessionId) ?? prompt
  if (!title) return null
  return { provider: 'codex', sessionId, cwd: meta.cwd, title: shortTitle(title), ...(branch ? { branch } : {}) }
}

/** `codex exec` jobs and subagent threads, which aren't conversations to carry on. */
function codexJob(meta: Record<string, unknown>): boolean {
  return meta.originator === 'codex_exec' || meta.source === 'exec' || typeof meta.source === 'object' || meta.thread_source === 'subagent'
}

async function entries(directory: string): Promise<{ name: string; directory: boolean; file: boolean }[]> {
  const list = await readdir(directory, { withFileTypes: true }).catch(() => [])
  return list.map((entry) => ({ name: entry.name, directory: entry.isDirectory(), file: entry.isFile() }))
}

async function withStats(files: TranscriptFile[]): Promise<Candidate[]> {
  const stats = await Promise.all(files.map(async (entry) => {
    const info = await stat(entry.file).catch(() => null)
    return info ? { ...entry, mtimeMs: info.mtimeMs, size: info.size } : null
  }))
  return stats.filter((entry): entry is Candidate => entry !== null && entry.size > 0)
}

function cursorProjectName(path: string): string {
  return path.replace(/[^a-zA-Z0-9]/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '')
}

/** Resolve the lossy project name against real directory names, never by guessing slashes. */
async function cursorProjectPaths(encoded: string): Promise<string[]> {
  const found: string[] = []
  let budget = 1000
  const walk = async (path: string): Promise<void> => {
    if (--budget < 0) return
    const name = cursorProjectName(path)
    if (name === encoded) found.push(path)
    if (name && !encoded.startsWith(`${name}-`)) return
    for (const entry of await readdir(path, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
      const child = join(path, entry.name)
      const prefix = cursorProjectName(child)
      if (prefix && prefix !== name && (prefix === encoded || encoded.startsWith(`${prefix}-`))) await walk(child)
    }
  }
  await walk('/')
  return budget < 0 ? [] : found
}

async function parseCursorTranscript(file: string, size: number, cwd?: string): Promise<Parsed> {
  if (!cwd) return null
  const sessionId = basename(file, '.jsonl')
  const stream = createReadStream(file, { end: Math.min(size, MAX_HEAD_BYTES) - 1 })
  const reader = createInterface({ input: stream, crlfDelay: Infinity })
  try {
    for await (const line of reader) {
      for (const entry of jsonLines(line, { dropFirst: false, dropLast: false })) {
        if (entry.role !== 'user') continue
        const prompt = text(record(entry.message).content).match(/<user_query>([\s\S]*?)<\/user_query>/)?.[1]?.trim()
        if (prompt) return { provider: 'cursor', sessionId, cwd, title: shortTitle(prompt) }
      }
    }
  } finally {
    reader.close()
    stream.destroy()
  }
  return null
}

/**
 * Lists saved agent conversations, newest first. Transcripts are
 * parsed once per change (cached by size and time) and only as far as the newest
 * `limit` conversations need.
 */
export class ChatConversationIndex {
  private readonly home: string
  private readonly codexHome: string
  private readonly opencodeDb: string
  private readonly limit: number
  private readonly parsed = new Map<string, { mtimeMs: number; size: number; cwd?: string; value: Parsed }>()
  private threadNames: { mtimeMs: number; names: Map<string, string> } | undefined
  private last: ChatConversation[] = []

  constructor(private readonly options: ChatConversationIndexOptions) {
    this.home = options.home ?? homedir()
    this.codexHome = options.codexHome ?? process.env.CODEX_HOME ?? join(this.home, '.codex')
    this.opencodeDb = join(options.xdgDataHome ?? process.env.XDG_DATA_HOME ?? join(this.home, '.local', 'share'), 'opencode', 'opencode.db')
    this.limit = options.limit ?? DEFAULT_LIMIT
  }

  private async claudeFiles(): Promise<{ file: string; provider: ChatConversationProvider; configDir: string }[]> {
    const configDirs = this.options.claudeConfigDirs
      ? await this.options.claudeConfigDirs()
      : (await listClaudeProfiles(this.home)).map((profile) => profile.configDir)
    const files: { file: string; provider: ChatConversationProvider; configDir: string }[] = []
    for (const configDir of configDirs) {
      const projects = join(configDir, 'projects')
      for (const project of await entries(projects)) {
        if (!project.directory) continue
        for (const entry of await entries(join(projects, project.name))) {
          if (entry.file && entry.name.endsWith('.jsonl')) files.push({ file: join(projects, project.name, entry.name), provider: 'claude', configDir })
        }
      }
    }
    return files
  }

  private async codexFiles(): Promise<{ file: string; provider: ChatConversationProvider }[]> {
    const files: { file: string; provider: ChatConversationProvider }[] = []
    const walk = async (directory: string, depth: number): Promise<void> => {
      for (const entry of await entries(directory)) {
        const path = join(directory, entry.name)
        if (entry.directory && depth < 3) await walk(path, depth + 1)
        else if (entry.file && depth === 3 && entry.name.startsWith('rollout-') && entry.name.endsWith('.jsonl')) files.push({ file: path, provider: 'codex' })
      }
    }
    await walk(join(this.codexHome, 'sessions'), 0)
    return files
  }

  private async cursorFiles(): Promise<TranscriptFile[]> {
    const root = join(this.home, '.cursor')
    const stores = new Map<string, { hash: string; cwd?: string }[]>()
    for (const workspace of await entries(join(root, 'chats'))) {
      if (!workspace.directory || !/^[a-f0-9]{32}$/.test(workspace.name)) continue
      for (const chat of await entries(join(root, 'chats', workspace.name))) {
        // SDK/ACP `agent-…` ids have separate stores, not CLI-resumable conversations.
        if (!chat.directory || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(chat.name)) continue
        const directory = join(root, 'chats', workspace.name, chat.name)
        if (!(await stat(join(directory, 'store.db')).then((info) => info.isFile(), () => false))) continue
        let cwd: string | undefined
        try {
          const meta = record(JSON.parse(await readFile(join(directory, 'meta.json'), 'utf8')))
          if (meta.isSubagent === true) continue
          if (typeof meta.cwd === 'string' && isAbsolute(meta.cwd)) cwd = resolve(meta.cwd)
        } catch { /* Older stores have no sidecar; resolve their project folder below. */ }
        const list = stores.get(chat.name) ?? []
        list.push({ hash: workspace.name, cwd })
        stores.set(chat.name, list)
      }
    }
    const files: TranscriptFile[] = []
    for (const project of await entries(join(root, 'projects'))) {
      if (!project.directory) continue
      const transcripts = join(root, 'projects', project.name, 'agent-transcripts')
      let fallback: string[] | undefined
      for (const entry of await entries(transcripts)) {
        const sessionId = entry.file && entry.name.endsWith('.jsonl') ? basename(entry.name, '.jsonl') : entry.directory ? entry.name : ''
        const chats = stores.get(sessionId)
        if (!chats) continue
        const matches = (cwd: string, hash: string) => cursorProjectName(cwd) === project.name && createHash('md5').update(cwd).digest('hex') === hash
        const paths = chats.flatMap((chat) => chat.cwd && matches(chat.cwd, chat.hash) ? [chat.cwd] : [])
        if (!paths.length) {
          fallback ??= await cursorProjectPaths(project.name)
          paths.push(...fallback.filter((path) => chats.some((chat) => matches(path, chat.hash))))
        }
        const unique = [...new Set(paths)]
        if (unique.length !== 1) continue
        files.push({ provider: 'cursor', file: entry.file ? join(transcripts, entry.name) : join(transcripts, sessionId, `${sessionId}.jsonl`), cwd: unique[0]! })
      }
    }
    return files
  }

  /** One read-only snapshot per list; missing, locked or migrating stores are retried next time. */
  private opencodeConversations(): Omit<ChatConversation, 'repoRoot' | 'checkoutRoot'>[] {
    let db: DatabaseSync | undefined
    try {
      db = new DatabaseSync(this.opencodeDb, { readOnly: true })
      return db.prepare('SELECT id, directory, title, time_updated FROM session WHERE parent_id IS NULL AND time_archived IS NULL').all().flatMap((row) => {
        if (!isChatConversationSessionId(row.id) || typeof row.directory !== 'string' || !isAbsolute(row.directory) || typeof row.title !== 'string' || !row.title.trim() || typeof row.time_updated !== 'number' || !Number.isFinite(row.time_updated)) return []
        return [{ provider: 'opencode' as const, sessionId: row.id, cwd: row.directory, title: row.title, updatedAt: row.time_updated }]
      })
    } catch {
      return []
    } finally {
      db?.close()
    }
  }

  /** Names given to Codex threads, from Codex's own index. */
  private async codexThreadNames(): Promise<Map<string, string>> {
    const file = join(this.codexHome, 'session_index.jsonl')
    const info = await stat(file).catch(() => null)
    if (!info) return new Map()
    if (this.threadNames?.mtimeMs === info.mtimeMs) return this.threadNames.names
    const names = new Map<string, string>()
    for (const entry of jsonLines(await readFile(file, 'utf8').catch(() => ''), { dropFirst: false, dropLast: false })) {
      if (typeof entry.id === 'string' && typeof entry.thread_name === 'string' && entry.thread_name.trim()) names.set(entry.id, entry.thread_name)
    }
    this.threadNames = { mtimeMs: info.mtimeMs, names }
    return names
  }

  private async parse(candidate: Candidate, threadNames: ReadonlyMap<string, string>): Promise<Parsed> {
    const cached = this.parsed.get(candidate.file)
    if (cached && cached.mtimeMs === candidate.mtimeMs && cached.size === candidate.size && cached.cwd === candidate.cwd) return cached.value
    try {
      const value = await (candidate.provider === 'claude'
        ? parseClaudeTranscript(candidate.file, candidate.size, candidate.configDir)
        : candidate.provider === 'cursor' ? parseCursorTranscript(candidate.file, candidate.size, candidate.cwd)
        : parseCodexRollout(candidate.file, candidate.size, threadNames))
      this.parsed.set(candidate.file, { mtimeMs: candidate.mtimeMs, size: candidate.size, cwd: candidate.cwd, value })
      return value
    } catch {
      // Unreadable just now (deleted, mid-write): tried again next time.
      return null
    }
  }

  async list(): Promise<ChatConversation[]> {
    const [claude, codex, cursor, threadNames] = await Promise.all([this.claudeFiles(), this.codexFiles(), this.cursorFiles(), this.codexThreadNames()])
    const opencode = this.opencodeConversations()
    const candidates = (await withStats([...claude, ...codex, ...cursor])).sort((a, b) => b.mtimeMs - a.mtimeMs)
    const found: (Omit<ChatConversation, 'repoRoot' | 'checkoutRoot'>)[] = []
    const seen = new Set<string>()
    for (let index = 0; index < candidates.length && found.length < this.limit; index += 8) {
      const batch = candidates.slice(index, index + 8)
      const values = await Promise.all(batch.map((candidate) => this.parse(candidate, threadNames)))
      values.forEach((value, offset) => {
        if (!value || found.length >= this.limit) return
        // Codex can keep a resumed thread in more than one rollout; the newest wins.
        const key = `${value.provider}:${value.sessionId}`
        if (seen.has(key)) return
        seen.add(key)
        found.push({ ...value, updatedAt: Math.round(batch[offset]!.mtimeMs) })
      })
    }
    const newest = [...found, ...opencode].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, this.limit)
    const repos = await this.options.resolveRepos([...new Set(newest.map((conversation) => conversation.cwd))])
    this.last = newest.map((conversation) => {
      const repo = repos.get(conversation.cwd)
      return repo ? { ...conversation, repoRoot: repo.root, checkoutRoot: repo.worktreeRoot ?? repo.root } : conversation
    })
    return this.last
  }

  /** A listed conversation, from the last list or a fresh one. */
  async find(provider: ChatConversationProvider, sessionId: string): Promise<ChatConversation | undefined> {
    const match = (list: readonly ChatConversation[]) => list.find((entry) => entry.provider === provider && entry.sessionId === sessionId)
    return match(this.last) ?? match(await this.list())
  }
}
