import { createHash } from 'node:crypto'
import { chmodSync, closeSync, lstatSync, mkdirSync, openSync } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { isChatConversationSessionId, type ChatConversationProvider } from '../shared/chat-conversations.js'
import {
  DEFAULT_CHAT_MESSAGE_SEARCH_LIMIT,
  MAX_CHAT_MESSAGE_SEARCH_LIMIT,
  MIN_CHAT_MESSAGE_SEARCH_LENGTH,
} from '../shared/chat-messages.js'
import { deepseekConfigDir } from './agent-host/deepseek.js'
import {
  extractClaudeTranscriptMessages,
  extractCodexRolloutMessages,
  extractCursorTranscriptMessages,
  extractMuseLogMessages,
  extractOpencodeMessages,
  type ExtractedConversationMessages,
  type MuseSessionMeta,
} from './chat-message-extractors.js'
import { listClaudeProfiles } from './tmux-create.js'

const APPLICATION_ID = 0x434d5347 // 'CMSG'
const SCHEMA_VERSION = 1
const BATCH_SIZE = 8
const DEFAULT_MIN_REFRESH_MS = 10_000
const OPENCODE_META_KEY = '__opencode_db__'

export interface IndexedSentMessage {
  id: number
  provider: ChatConversationProvider
  sessionId: string
  messageId: string
  text: string
  sentAt: number
  cwd?: string
  branch?: string
  configDir?: string
  title?: string
}

export interface ChatMessageIndexOptions {
  /** SQLite path, or `:memory:` for tests. */
  dbPath: string
  home?: string
  codexHome?: string
  xdgDataHome?: string
  claudeConfigDirs?: () => Promise<string[]>
  minRefreshMs?: number
  now?: () => number
}

type FileCandidate =
  | { sourceKey: string; provider: 'claude' | 'deepseek'; file: string; configDir: string; mtimeMs: number; size: number }
  | { sourceKey: string; provider: 'codex'; file: string; mtimeMs: number; size: number }
  | { sourceKey: string; provider: 'cursor'; file: string; cwd: string; mtimeMs: number; size: number }
  | { sourceKey: string; provider: 'muse'; file: string; meta: MuseSessionMeta; mtimeMs: number; size: number }

type CachedSource = { mtimeMs: number; size: number; skipped: number }

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

async function dirEntries(directory: string): Promise<{ name: string; directory: boolean; file: boolean }[]> {
  const list = await readdir(directory, { withFileTypes: true }).catch(() => [])
  return list.map((entry) => ({ name: entry.name, directory: entry.isDirectory(), file: entry.isFile() }))
}

function cursorProjectName(path: string): string {
  return path.replace(/[^a-zA-Z0-9]/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '')
}

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

function quoteFtsToken(token: string): string {
  return `"${token.replace(/"/g, '""')}"`
}

/**
 * Incremental SQLite FTS5 (trigram) index of user-sent messages across all agent transcripts.
 * Each source file is keyed by `(source_key, mtime_ms, size)` so unchanged transcripts and
 * skipped non-conversation jobs (`codex_exec`, subagents) are never re-parsed.
 */
export class ChatMessageIndex {
  private readonly db: DatabaseSync
  private readonly home: string
  private readonly codexHome: string
  private readonly opencodeDb: string
  private readonly museDb: string
  private readonly minRefreshMs: number
  private readonly now: () => number
  private readonly claudeConfigDirs?: () => Promise<string[]>
  private threadNames: { mtimeMs: number; names: Map<string, string> } | undefined
  private inFlightSync: Promise<void> | null = null
  private lastSyncCompletedAt = 0
  private closed = false

  constructor(options: ChatMessageIndexOptions) {
    this.home = options.home ?? homedir()
    this.codexHome = options.codexHome ?? process.env.CODEX_HOME ?? join(this.home, '.codex')
    const dataHome = options.xdgDataHome ?? process.env.XDG_DATA_HOME ?? join(this.home, '.local', 'share')
    this.opencodeDb = join(dataHome, 'opencode', 'opencode.db')
    this.museDb = join(dataHome, 'muse', 'session-index.db')
    this.minRefreshMs = options.minRefreshMs ?? DEFAULT_MIN_REFRESH_MS
    this.now = options.now ?? Date.now
    this.claudeConfigDirs = options.claudeConfigDirs

    const dbPath = options.dbPath
    if (dbPath !== ':memory:') {
      mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 })
      try { closeSync(openSync(dbPath, 'wx', 0o600)) } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      }
      if (!lstatSync(dbPath).isFile()) throw new Error('Chat message index database path must be a regular file')
      chmodSync(dbPath, 0o600)
    }

    this.db = new DatabaseSync(dbPath)
    try {
      this.db.exec('PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON; PRAGMA synchronous = NORMAL;')
      this.ensureSchema()
      this.db.exec('PRAGMA journal_mode = WAL;')
      if (dbPath !== ':memory:') {
        for (const suffix of ['-wal', '-shm']) {
          try { chmodSync(dbPath + suffix, 0o600) } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          }
        }
      }
    } catch (error) {
      this.db.close()
      throw error
    }
  }

  private ensureSchema(): void {
    const appId = Number(this.db.prepare('PRAGMA application_id').get()?.application_id)
    const version = Number(this.db.prepare('PRAGMA user_version').get()?.user_version)
    if (appId === APPLICATION_ID && version === SCHEMA_VERSION) return

    this.transaction(() => {
      this.db.exec(`
        DROP TRIGGER IF EXISTS sent_messages_ai;
        DROP TRIGGER IF EXISTS sent_messages_ad;
        DROP TRIGGER IF EXISTS sent_messages_au;
        DROP TABLE IF EXISTS sent_messages_fts;
        DROP TABLE IF EXISTS sent_messages;
        DROP TABLE IF EXISTS indexed_sources;

        CREATE TABLE indexed_sources (
          source_key TEXT PRIMARY KEY NOT NULL,
          provider TEXT NOT NULL,
          session_id TEXT,
          mtime_ms INTEGER NOT NULL,
          size INTEGER NOT NULL,
          cwd TEXT,
          branch TEXT,
          config_dir TEXT,
          title TEXT,
          skipped INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE sent_messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          source_key TEXT NOT NULL REFERENCES indexed_sources(source_key) ON DELETE CASCADE,
          provider TEXT NOT NULL,
          session_id TEXT NOT NULL,
          message_id TEXT NOT NULL,
          text TEXT NOT NULL,
          sent_at INTEGER NOT NULL
        );

        CREATE INDEX idx_sent_messages_sent_at ON sent_messages(sent_at DESC);
        CREATE INDEX idx_sent_messages_source ON sent_messages(source_key);
        CREATE INDEX idx_sent_messages_conversation ON sent_messages(provider, session_id);

        CREATE VIRTUAL TABLE sent_messages_fts USING fts5(
          text,
          content='sent_messages',
          content_rowid='id',
          tokenize='trigram'
        );

        CREATE TRIGGER sent_messages_ai AFTER INSERT ON sent_messages BEGIN
          INSERT INTO sent_messages_fts(rowid, text) VALUES (new.id, new.text);
        END;

        CREATE TRIGGER sent_messages_ad AFTER DELETE ON sent_messages BEGIN
          INSERT INTO sent_messages_fts(sent_messages_fts, rowid, text) VALUES ('delete', old.id, old.text);
        END;

        CREATE TRIGGER sent_messages_au AFTER UPDATE ON sent_messages BEGIN
          INSERT INTO sent_messages_fts(sent_messages_fts, rowid, text) VALUES ('delete', old.id, old.text);
          INSERT INTO sent_messages_fts(rowid, text) VALUES (new.id, new.text);
        END;

        PRAGMA application_id = ${APPLICATION_ID};
        PRAGMA user_version = ${SCHEMA_VERSION};
      `)
    })
  }

  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN')
    try {
      const result = fn()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      try { this.db.exec('ROLLBACK') } catch { /* ignore rollback failure */ }
      throw error
    }
  }

  isSyncing(): boolean {
    return this.inFlightSync !== null
  }

  hasSynced(): boolean {
    return this.lastSyncCompletedAt > 0
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.db.close()
  }

  /** Kicks off an incremental sync if one is not already running or freshly completed. */
  triggerSync(force = false): Promise<void> {
    if (this.closed) return Promise.resolve()
    if (this.inFlightSync) return this.inFlightSync
    if (!force && this.lastSyncCompletedAt > 0 && this.now() - this.lastSyncCompletedAt < this.minRefreshMs) {
      return Promise.resolve()
    }
    this.inFlightSync = this.runSync()
      .catch((error: unknown) => {
        if (!this.closed) console.warn('[commando] Could not sync sent-messages index', error)
      })
      .finally(() => {
        this.inFlightSync = null
        if (!this.closed) this.lastSyncCompletedAt = this.now()
      })
    return this.inFlightSync
  }

  /** Searches indexed user-sent messages, ordered newest first. */
  search(query: string, limit = DEFAULT_CHAT_MESSAGE_SEARCH_LIMIT): IndexedSentMessage[] {
    if (this.closed) return []
    const trimmed = query.trim()
    if (trimmed.length < MIN_CHAT_MESSAGE_SEARCH_LENGTH) return []
    const cappedLimit = Math.max(1, Math.min(MAX_CHAT_MESSAGE_SEARCH_LIMIT, Math.floor(limit)))
    const terms = [...new Set(trimmed.toLowerCase().split(/\s+/).filter(Boolean))]
    if (!terms.length) return []

    const ftsTerms = terms.filter((term) => term.length >= MIN_CHAT_MESSAGE_SEARCH_LENGTH)
    const shortTerms = terms.filter((term) => term.length < MIN_CHAT_MESSAGE_SEARCH_LENGTH)

    let sql: string
    const params: (string | number)[] = []

    if (ftsTerms.length > 0) {
      const extraFilters = shortTerms.map(() => 'AND instr(lower(m.text), ?) > 0').join(' ')
      sql = `
        SELECT m.id, m.provider, m.session_id, m.message_id, m.text, m.sent_at,
               s.cwd, s.branch, s.config_dir, s.title
        FROM sent_messages_fts f
        JOIN sent_messages m ON m.id = f.rowid
        JOIN indexed_sources s ON s.source_key = m.source_key
        WHERE sent_messages_fts MATCH ?
        ${extraFilters}
        ORDER BY m.sent_at DESC
        LIMIT ?
      `
      params.push(ftsTerms.map(quoteFtsToken).join(' AND '), ...shortTerms, cappedLimit)
    } else {
      const filters = terms.map(() => 'instr(lower(m.text), ?) > 0').join(' AND ')
      sql = `
        SELECT m.id, m.provider, m.session_id, m.message_id, m.text, m.sent_at,
               s.cwd, s.branch, s.config_dir, s.title
        FROM sent_messages m
        JOIN indexed_sources s ON s.source_key = m.source_key
        WHERE ${filters}
        ORDER BY m.sent_at DESC
        LIMIT ?
      `
      params.push(...terms, cappedLimit)
    }

    const rows = this.db.prepare(sql).all(...params)
    return rows.map((row) => ({
      id: Number(row.id),
      provider: row.provider as ChatConversationProvider,
      sessionId: String(row.session_id),
      messageId: String(row.message_id),
      text: String(row.text),
      sentAt: Number(row.sent_at),
      ...(typeof row.cwd === 'string' && row.cwd ? { cwd: row.cwd } : {}),
      ...(typeof row.branch === 'string' && row.branch ? { branch: row.branch } : {}),
      ...(typeof row.config_dir === 'string' && row.config_dir ? { configDir: row.config_dir } : {}),
      ...(typeof row.title === 'string' && row.title ? { title: row.title } : {}),
    }))
  }

  private cachedSources(): Map<string, CachedSource> {
    const rows = this.db.prepare('SELECT source_key, mtime_ms, size, skipped FROM indexed_sources').all()
    const map = new Map<string, CachedSource>()
    for (const row of rows) {
      map.set(String(row.source_key), {
        mtimeMs: Number(row.mtime_ms),
        size: Number(row.size),
        skipped: Number(row.skipped),
      })
    }
    return map
  }

  private async runSync(): Promise<void> {
    const [claude, codex, cursor, muse, threadNames] = await Promise.all([
      this.discoverClaudeFiles(),
      this.discoverCodexFiles(),
      this.discoverCursorFiles(),
      this.discoverMuseFiles(),
      this.codexThreadNames(),
    ])
    if (this.closed) return

    const candidates = [...claude, ...codex, ...cursor, ...muse].sort((a, b) => b.mtimeMs - a.mtimeMs)
    const cached = this.cachedSources()
    const liveFileKeys = new Set(candidates.map((candidate) => candidate.sourceKey))

    const staleKeys = [...cached.keys()].filter((key) => !key.startsWith('opencode:') && key !== OPENCODE_META_KEY && !liveFileKeys.has(key))
    if (staleKeys.length) {
      this.deleteSources(staleKeys)
    }

    const dirty = candidates.filter((candidate) => {
      const existing = cached.get(candidate.sourceKey)
      return !existing || existing.mtimeMs !== candidate.mtimeMs || existing.size !== candidate.size
    })

    for (let index = 0; index < dirty.length; index += BATCH_SIZE) {
      if (this.closed) return
      const batch = dirty.slice(index, index + BATCH_SIZE)
      const parsed = await Promise.all(batch.map(async (candidate) => ({
        candidate,
        extracted: await this.extractCandidate(candidate, threadNames),
      })))
      if (this.closed) return
      this.writeBatch(parsed)
    }

    await this.syncOpencode(cached.get(OPENCODE_META_KEY))
  }

  private async extractCandidate(
    candidate: FileCandidate,
    threadNames: ReadonlyMap<string, string>,
  ): Promise<ExtractedConversationMessages | null> {
    try {
      switch (candidate.provider) {
        case 'claude':
        case 'deepseek':
          return await extractClaudeTranscriptMessages(candidate.file, candidate.provider, candidate.mtimeMs, candidate.configDir)
        case 'codex':
          return await extractCodexRolloutMessages(candidate.file, candidate.mtimeMs, threadNames)
        case 'cursor':
          return await extractCursorTranscriptMessages(candidate.file, candidate.cwd, candidate.mtimeMs)
        case 'muse':
          return await extractMuseLogMessages(candidate.meta)
      }
    } catch {
      return null
    }
  }

  private writeBatch(items: readonly { candidate: FileCandidate; extracted: ExtractedConversationMessages | null }[]): void {
    const deleteMessages = this.db.prepare('DELETE FROM sent_messages WHERE source_key = ?')
    const upsertSource = this.db.prepare(`
      INSERT INTO indexed_sources (source_key, provider, session_id, mtime_ms, size, cwd, branch, config_dir, title, skipped)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source_key) DO UPDATE SET
        provider = excluded.provider,
        session_id = excluded.session_id,
        mtime_ms = excluded.mtime_ms,
        size = excluded.size,
        cwd = excluded.cwd,
        branch = excluded.branch,
        config_dir = excluded.config_dir,
        title = excluded.title,
        skipped = excluded.skipped
    `)
    const insertMessage = this.db.prepare(`
      INSERT INTO sent_messages (source_key, provider, session_id, message_id, text, sent_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `)

    this.transaction(() => {
      for (const { candidate, extracted } of items) {
        deleteMessages.run(candidate.sourceKey)
        if (!extracted) {
          upsertSource.run(
            candidate.sourceKey,
            candidate.provider,
            null,
            candidate.mtimeMs,
            candidate.size,
            null,
            null,
            null,
            null,
            1,
          )
          continue
        }
        upsertSource.run(
          candidate.sourceKey,
          extracted.provider,
          extracted.sessionId,
          candidate.mtimeMs,
          candidate.size,
          extracted.cwd ?? null,
          extracted.branch ?? null,
          extracted.configDir ?? null,
          extracted.title ?? null,
          0,
        )
        for (const message of extracted.messages) {
          insertMessage.run(
            candidate.sourceKey,
            extracted.provider,
            extracted.sessionId,
            message.messageId,
            message.text,
            message.sentAt,
          )
        }
      }
    })
  }

  private deleteSources(sourceKeys: readonly string[]): void {
    const deleteMessages = this.db.prepare('DELETE FROM sent_messages WHERE source_key = ?')
    const deleteSource = this.db.prepare('DELETE FROM indexed_sources WHERE source_key = ?')
    this.transaction(() => {
      for (const key of sourceKeys) {
        deleteMessages.run(key)
        deleteSource.run(key)
      }
    })
  }

  private async syncOpencode(cachedMeta: CachedSource | undefined): Promise<void> {
    const mainStat = await stat(this.opencodeDb).catch(() => null)
    if (!mainStat) {
      if (cachedMeta) {
        const keys = this.db.prepare("SELECT source_key FROM indexed_sources WHERE source_key LIKE 'opencode:%' OR source_key = ?")
          .all(OPENCODE_META_KEY)
          .map((row) => String(row.source_key))
        if (keys.length) this.deleteSources(keys)
      }
      return
    }
    const walStat = await stat(`${this.opencodeDb}-wal`).catch(() => null)
    const mtimeMs = Math.round(Math.max(mainStat.mtimeMs, walStat?.mtimeMs ?? 0))
    const size = mainStat.size + (walStat?.size ?? 0)
    if (cachedMeta && cachedMeta.mtimeMs === mtimeMs && cachedMeta.size === size) return

    const conversations = extractOpencodeMessages(this.opencodeDb)
    if (this.closed) return

    const existingKeys = this.db.prepare("SELECT source_key FROM indexed_sources WHERE source_key LIKE 'opencode:%'")
      .all()
      .map((row) => String(row.source_key))

    const deleteMessages = this.db.prepare('DELETE FROM sent_messages WHERE source_key = ?')
    const deleteSource = this.db.prepare('DELETE FROM indexed_sources WHERE source_key = ?')
    const upsertSource = this.db.prepare(`
      INSERT INTO indexed_sources (source_key, provider, session_id, mtime_ms, size, cwd, branch, config_dir, title, skipped)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source_key) DO UPDATE SET
        provider = excluded.provider,
        session_id = excluded.session_id,
        mtime_ms = excluded.mtime_ms,
        size = excluded.size,
        cwd = excluded.cwd,
        branch = excluded.branch,
        config_dir = excluded.config_dir,
        title = excluded.title,
        skipped = excluded.skipped
    `)
    const insertMessage = this.db.prepare(`
      INSERT INTO sent_messages (source_key, provider, session_id, message_id, text, sent_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `)

    this.transaction(() => {
      for (const key of existingKeys) {
        deleteMessages.run(key)
        deleteSource.run(key)
      }
      upsertSource.run(OPENCODE_META_KEY, 'opencode', null, mtimeMs, size, null, null, null, null, 1)
      for (const conv of conversations) {
        const sourceKey = `opencode:${conv.sessionId}`
        upsertSource.run(sourceKey, 'opencode', conv.sessionId, mtimeMs, size, conv.cwd ?? null, null, null, conv.title ?? null, 0)
        for (const msg of conv.messages) {
          insertMessage.run(sourceKey, 'opencode', conv.sessionId, msg.messageId, msg.text, msg.sentAt)
        }
      }
    })
  }

  private async discoverClaudeFiles(): Promise<FileCandidate[]> {
    const configDirs = this.claudeConfigDirs
      ? await this.claudeConfigDirs()
      : (await listClaudeProfiles(this.home)).map((profile) => profile.configDir)
    const deepseekDir = deepseekConfigDir(this.home)
    const raw: { file: string; provider: 'claude' | 'deepseek'; configDir: string }[] = []
    for (const configDir of [...new Set([...configDirs, deepseekDir])]) {
      const projects = join(configDir, 'projects')
      for (const project of await dirEntries(projects)) {
        if (!project.directory) continue
        for (const entry of await dirEntries(join(projects, project.name))) {
          if (entry.file && entry.name.endsWith('.jsonl')) {
            raw.push({
              file: join(projects, project.name, entry.name),
              provider: configDir === deepseekDir ? 'deepseek' : 'claude',
              configDir,
            })
          }
        }
      }
    }
    const candidates = await Promise.all(raw.map(async (entry) => {
      const info = await stat(entry.file).catch(() => null)
      if (!info || info.size <= 0) return null
      return {
        sourceKey: `${entry.provider}:${entry.file}`,
        provider: entry.provider,
        file: entry.file,
        configDir: entry.configDir,
        mtimeMs: Math.round(info.mtimeMs),
        size: info.size,
      } satisfies FileCandidate
    }))
    return candidates.filter((entry): entry is NonNullable<typeof entry> => entry !== null)
  }

  private async discoverCodexFiles(): Promise<FileCandidate[]> {
    const files: string[] = []
    const walk = async (directory: string, depth: number): Promise<void> => {
      for (const entry of await dirEntries(directory)) {
        const path = join(directory, entry.name)
        if (entry.directory && depth < 3) await walk(path, depth + 1)
        else if (entry.file && depth === 3 && entry.name.startsWith('rollout-') && entry.name.endsWith('.jsonl')) {
          files.push(path)
        }
      }
    }
    await walk(join(this.codexHome, 'sessions'), 0)
    const candidates = await Promise.all(files.map(async (file) => {
      const info = await stat(file).catch(() => null)
      if (!info || info.size <= 0) return null
      return {
        sourceKey: `codex:${file}`,
        provider: 'codex' as const,
        file,
        mtimeMs: Math.round(info.mtimeMs),
        size: info.size,
      } satisfies FileCandidate
    }))
    return candidates.filter((entry): entry is NonNullable<typeof entry> => entry !== null)
  }

  private async discoverCursorFiles(): Promise<FileCandidate[]> {
    const root = join(this.home, '.cursor')
    const stores = new Map<string, { hash: string; cwd?: string }[]>()
    for (const workspace of await dirEntries(join(root, 'chats'))) {
      if (!workspace.directory || !/^[a-f0-9]{32}$/.test(workspace.name)) continue
      for (const chat of await dirEntries(join(root, 'chats', workspace.name))) {
        if (!chat.directory || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(chat.name)) continue
        const directory = join(root, 'chats', workspace.name, chat.name)
        if (!(await stat(join(directory, 'store.db')).then((info) => info.isFile(), () => false))) continue
        let cwd: string | undefined
        try {
          const meta = record(JSON.parse(await readFile(join(directory, 'meta.json'), 'utf8')))
          if (meta.isSubagent === true) continue
          if (typeof meta.cwd === 'string' && isAbsolute(meta.cwd)) cwd = resolve(meta.cwd)
        } catch { /* older stores have no sidecar */ }
        const list = stores.get(chat.name) ?? []
        list.push({ hash: workspace.name, cwd })
        stores.set(chat.name, list)
      }
    }
    const raw: { file: string; cwd: string }[] = []
    for (const project of await dirEntries(join(root, 'projects'))) {
      if (!project.directory) continue
      const transcripts = join(root, 'projects', project.name, 'agent-transcripts')
      let fallback: string[] | undefined
      for (const entry of await dirEntries(transcripts)) {
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
        const file = entry.file ? join(transcripts, entry.name) : join(transcripts, sessionId, `${sessionId}.jsonl`)
        raw.push({ file, cwd: unique[0]! })
      }
    }
    const candidates = await Promise.all(raw.map(async (entry) => {
      const info = await stat(entry.file).catch(() => null)
      if (!info || info.size <= 0) return null
      return {
        sourceKey: `cursor:${entry.file}`,
        provider: 'cursor' as const,
        file: entry.file,
        cwd: entry.cwd,
        mtimeMs: Math.round(info.mtimeMs),
        size: info.size,
      } satisfies FileCandidate
    }))
    return candidates.filter((entry): entry is NonNullable<typeof entry> => entry !== null)
  }

  private async discoverMuseFiles(): Promise<FileCandidate[]> {
    let db: DatabaseSync | undefined
    const rows: MuseSessionMeta[] = []
    try {
      db = new DatabaseSync(this.museDb, { readOnly: true })
      const records = db.prepare(`
        SELECT session_id, session_log_path, workspace_root, title, git_branch, first_user_prompt, updated_at_us
        FROM sessions
        WHERE status = 'valid' AND prompt_count > 0 AND msp_parent_session_id IS NULL
      `).all()
      for (const row of records) {
        if (!isChatConversationSessionId(row.session_id) || typeof row.workspace_root !== 'string' || !isAbsolute(row.workspace_root)
          || typeof row.title !== 'string' || !row.title.trim() || typeof row.updated_at_us !== 'number' || !Number.isFinite(row.updated_at_us)) continue
        if (typeof row.session_log_path !== 'string' || !row.session_log_path) continue
        rows.push({
          sessionId: row.session_id,
          logPath: row.session_log_path,
          cwd: row.workspace_root,
          title: row.title,
          ...(typeof row.git_branch === 'string' && row.git_branch ? { branch: row.git_branch } : {}),
          ...(typeof row.first_user_prompt === 'string' && row.first_user_prompt ? { firstUserPrompt: row.first_user_prompt } : {}),
          updatedAt: Math.round(row.updated_at_us / 1000),
        })
      }
    } catch {
      return []
    } finally {
      db?.close()
    }

    const candidates = await Promise.all(rows.map(async (meta) => {
      const info = await stat(meta.logPath).catch(() => null)
      return {
        sourceKey: `muse:${meta.sessionId}`,
        provider: 'muse' as const,
        file: meta.logPath,
        meta,
        mtimeMs: info ? Math.round(info.mtimeMs) : meta.updatedAt,
        size: info ? info.size : 0,
      } satisfies FileCandidate
    }))
    return candidates
  }

  private async codexThreadNames(): Promise<Map<string, string>> {
    const file = join(this.codexHome, 'session_index.jsonl')
    const info = await stat(file).catch(() => null)
    if (!info) return new Map()
    if (this.threadNames?.mtimeMs === info.mtimeMs) return this.threadNames.names
    const names = new Map<string, string>()
    const text = await readFile(file, 'utf8').catch(() => '')
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      try {
        const entry = record(JSON.parse(line))
        if (typeof entry.id === 'string' && typeof entry.thread_name === 'string' && entry.thread_name.trim()) {
          names.set(entry.id, entry.thread_name)
        }
      } catch { /* ignore malformed lines */ }
    }
    this.threadNames = { mtimeMs: info.mtimeMs, names }
    return names
  }
}
