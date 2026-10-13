import { open, readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { stripAttachmentNotes } from '../shared/agent-chat.js'
import { isChatConversationSessionId, type ChatConversation, type ChatConversationProvider } from '../shared/chat-conversations.js'
import type { PaneRepo } from '../shared/protocol.js'
import { listClaudeProfiles } from './tmux-create.js'

/** Enough of a transcript's start for its folder and first prompt, and of its end for its latest title. */
const HEAD_BYTES = 256 * 1024
const TAIL_BYTES = 256 * 1024
/** The picker lists this many of the newest conversations. */
const DEFAULT_LIMIT = 300
const MAX_TITLE = 200

type Candidate = { provider: ChatConversationProvider; file: string; mtimeMs: number; size: number; configDir?: string }
type Parsed = Omit<ChatConversation, 'updatedAt' | 'repoRoot' | 'checkoutRoot'> | null

export type ChatConversationIndexOptions = {
  home?: string
  codexHome?: string
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

async function headAndTail(file: string, size: number): Promise<{ head: Record<string, unknown>[]; tail: Record<string, unknown>[] }> {
  const head = jsonLines(await readSlice(file, 0, Math.min(size, HEAD_BYTES)), { dropFirst: false, dropLast: size > HEAD_BYTES })
  if (size <= HEAD_BYTES) return { head, tail: head }
  const start = Math.max(HEAD_BYTES, size - TAIL_BYTES)
  return { head, tail: jsonLines(await readSlice(file, start, size - start), { dropFirst: true, dropLast: false }) }
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
  const { head, tail } = await headAndTail(file, size)
  let cwd: string | undefined
  let branch: string | undefined
  let prompt: string | undefined
  for (const entry of head) {
    // `claude -p` runs are one-off jobs, not conversations to carry on.
    if (entry.entrypoint === 'sdk-cli') return null
    if (!cwd && typeof entry.cwd === 'string') cwd = entry.cwd
    if (!branch && typeof entry.gitBranch === 'string' && entry.gitBranch !== 'HEAD') branch = entry.gitBranch
    if (!prompt && entry.type === 'user' && !entry.isMeta && !entry.isSidechain) prompt = typedPrompt(text(record(entry.message).content))
    if (cwd && branch && prompt) break
  }
  if (!cwd || !prompt) return null
  let title: string | undefined
  // The newest title wins: a name the person gave it, else Claude's own.
  for (const key of ['customTitle', 'aiTitle', 'summary'] as const) {
    for (let index = tail.length - 1; index >= 0 && !title; index -= 1) {
      const value = tail[index]![key]
      if (typeof value === 'string' && value.trim()) title = value
    }
    if (title) break
  }
  return { provider: 'claude', sessionId, cwd, title: shortTitle(title ?? prompt), ...(branch ? { branch } : {}), ...(configDir ? { configDir } : {}) }
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

async function withStats(files: { file: string; provider: ChatConversationProvider; configDir?: string }[]): Promise<Candidate[]> {
  const stats = await Promise.all(files.map(async (entry) => {
    const info = await stat(entry.file).catch(() => null)
    return info ? { ...entry, mtimeMs: info.mtimeMs, size: info.size } : null
  }))
  return stats.filter((entry): entry is Candidate => entry !== null && entry.size > 0)
}

/**
 * Lists the conversations Claude and Codex saved, newest first. Transcripts are
 * parsed once per change (cached by size and time) and only as far as the newest
 * `limit` conversations need.
 */
export class ChatConversationIndex {
  private readonly home: string
  private readonly codexHome: string
  private readonly limit: number
  private readonly parsed = new Map<string, { mtimeMs: number; size: number; value: Parsed }>()
  private threadNames: { mtimeMs: number; names: Map<string, string> } | undefined
  private last: ChatConversation[] = []

  constructor(private readonly options: ChatConversationIndexOptions) {
    this.home = options.home ?? homedir()
    this.codexHome = options.codexHome ?? process.env.CODEX_HOME ?? join(this.home, '.codex')
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
    if (cached && cached.mtimeMs === candidate.mtimeMs && cached.size === candidate.size) return cached.value
    const value = await (candidate.provider === 'claude'
      ? parseClaudeTranscript(candidate.file, candidate.size, candidate.configDir)
      : parseCodexRollout(candidate.file, candidate.size, threadNames)
    ).catch(() => null)
    this.parsed.set(candidate.file, { mtimeMs: candidate.mtimeMs, size: candidate.size, value })
    return value
  }

  async list(): Promise<ChatConversation[]> {
    const [claude, codex, threadNames] = await Promise.all([this.claudeFiles(), this.codexFiles(), this.codexThreadNames()])
    const candidates = (await withStats([...claude, ...codex])).sort((a, b) => b.mtimeMs - a.mtimeMs)
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
    const repos = await this.options.resolveRepos([...new Set(found.map((conversation) => conversation.cwd))])
    this.last = found.map((conversation) => {
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
