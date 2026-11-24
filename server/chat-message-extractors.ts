import { createReadStream } from 'node:fs'
import { open } from 'node:fs/promises'
import { basename, isAbsolute } from 'node:path'
import { createInterface } from 'node:readline'
import { DatabaseSync } from 'node:sqlite'
import { stripAttachmentNotes } from '../shared/agent-chat.js'
import { isChatConversationSessionId, type ChatConversationProvider } from '../shared/chat-conversations.js'
import { isDaemonInjectedMessage } from '../shared/chat-messages.js'
import { parseRelayPrompt } from './agent-host/claude-items.js'

const CODEX_META_BYTES = 64 * 1024
const MAX_INDEXED_MESSAGE_CHARS = 16_000
const MAX_TITLE_CHARS = 200
const BARE_NOISE_COMMANDS = /^\/(clear|compact|resume|help|status|context|cost|exit|quit)$/
const HARNESS_NOISE = /^\s*(?:<(?:local-command-|command-|system-reminder|task-notification|bash-|user-memory-input|environment_context|INSTRUCTIONS|turn_aborted|permissions\b)|\[Request interrupted|This session is being continued from a previous conversation|Caveat: The messages below)/i

export interface ExtractedSentMessage {
  messageId: string
  text: string
  sentAt: number
}

export interface ExtractedConversationMessages {
  provider: ChatConversationProvider
  sessionId: string
  cwd?: string
  branch?: string
  configDir?: string
  title?: string
  messages: ExtractedSentMessage[]
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function shortTitle(value: string): string {
  const line = value.replace(/\s+/g, ' ').trim()
  return line.length > MAX_TITLE_CHARS ? `${line.slice(0, MAX_TITLE_CHARS - 1)}…` : line
}

function capMessageText(value: string): string {
  return value.length > MAX_INDEXED_MESSAGE_CHARS ? value.slice(0, MAX_INDEXED_MESSAGE_CHARS) : value
}

export function extractTextContent(value: unknown): string {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return ''
  return value.map((part) => {
    const entry = record(part)
    const type = entry.type ?? entry.kind
    return (type === 'text' || type === 'input_text') && typeof entry.text === 'string' ? entry.text : ''
  }).filter(Boolean).join('\n')
}

/** Cleans a raw user prompt, dropping harness-injected context and empty/noise messages. */
export function cleanUserMessageText(raw: string): string | undefined {
  const relayed = parseRelayPrompt(raw)
  const base = relayed ? relayed.text : raw
  const stripped = stripAttachmentNotes(base.replace(/<\/?image\b[^>]*>/g, ' ')).trim()
  if (!stripped) return undefined
  const command = stripped.match(/<command-name>\s*(\/[^\s<]+)\s*<\/command-name>/)?.[1]
  if (command) {
    const args = stripped.match(/<command-args>([\s\S]*?)<\/command-args>/)?.[1]?.trim()
    if (!args && BARE_NOISE_COMMANDS.test(command)) return undefined
    return capMessageText(args ? `${command} ${args}` : command)
  }
  if (HARNESS_NOISE.test(stripped) || isDaemonInjectedMessage(stripped)) return undefined
  if (stripped.startsWith('# AGENTS.md') || stripped.startsWith('Base directory for this skill')) return undefined
  if (stripped.startsWith('<') && !stripped.includes('\n') && stripped.endsWith('>')) return undefined
  return capMessageText(stripped)
}

function parseTimestampMs(value: unknown, fallbackMs: number): number {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    // Muse records microseconds (> 1e14); seconds are < 1e11.
    if (value > 1e14) return Math.round(value / 1000)
    if (value < 1e11) return Math.round(value * 1000)
    return Math.round(value)
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed) && parsed > 0) return parsed
  }
  return fallbackMs
}

async function forEachJsonLine(file: string, visitor: (entry: Record<string, unknown>) => boolean | void): Promise<void> {
  const stream = createReadStream(file, { encoding: 'utf8' })
  const reader = createInterface({ input: stream, crlfDelay: Infinity })
  try {
    for await (const line of reader) {
      if (!line.trim()) continue
      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch {
        continue
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) continue
      if (visitor(parsed as Record<string, unknown>) === false) break
    }
  } finally {
    reader.close()
    stream.destroy()
  }
}

async function readFirstLine(file: string, maxBytes: number): Promise<Record<string, unknown> | undefined> {
  const handle = await open(file, 'r')
  try {
    const buffer = Buffer.alloc(maxBytes)
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0)
    const text = buffer.subarray(0, bytesRead).toString('utf8')
    const newline = text.indexOf('\n')
    const line = (newline >= 0 ? text.slice(0, newline) : text).trim()
    if (!line) return undefined
    try {
      const parsed = JSON.parse(line) as unknown
      return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : undefined
    } catch {
      return undefined
    }
  } finally {
    await handle.close()
  }
}

function isCodexJob(meta: Record<string, unknown>): boolean {
  return meta.originator === 'codex_exec'
    || meta.source === 'exec'
    || typeof meta.source === 'object'
    || meta.thread_source === 'subagent'
}

/** Streams a Claude or DeepSeek JSONL transcript and extracts all user-sent messages. */
export async function extractClaudeTranscriptMessages(
  file: string,
  provider: 'claude' | 'deepseek',
  fallbackTimeMs: number,
  configDir?: string,
): Promise<ExtractedConversationMessages | null> {
  const sessionId = basename(file, '.jsonl')
  if (!isChatConversationSessionId(sessionId)) return null

  let cwd: string | undefined
  let branch: string | undefined
  let customTitle: string | undefined
  let aiTitle: string | undefined
  let summary: string | undefined
  let aborted = false
  const messages: ExtractedSentMessage[] = []
  const seenIds = new Set<string>()

  await forEachJsonLine(file, (entry) => {
    if (entry.entrypoint === 'sdk-cli') {
      aborted = true
      return false
    }
    if (!cwd && typeof entry.cwd === 'string') cwd = entry.cwd
    if (typeof entry.gitBranch === 'string' && entry.gitBranch && entry.gitBranch !== 'HEAD') branch = entry.gitBranch
    if (typeof entry.customTitle === 'string' && entry.customTitle.trim()) customTitle = entry.customTitle
    if (typeof entry.aiTitle === 'string' && entry.aiTitle.trim()) aiTitle = entry.aiTitle
    if (typeof entry.summary === 'string' && entry.summary.trim()) summary = entry.summary

    if (entry.type === 'user' && !entry.isMeta && !entry.isSidechain) {
      const text = cleanUserMessageText(extractTextContent(record(entry.message).content))
      if (!text) return
      const messageId = typeof entry.uuid === 'string' && entry.uuid ? entry.uuid : `claude-${messages.length}`
      if (seenIds.has(messageId)) return
      seenIds.add(messageId)
      messages.push({
        messageId,
        text,
        sentAt: parseTimestampMs(entry.timestamp, fallbackTimeMs),
      })
    }
  })

  if (aborted) return null
  const titleSource = customTitle ?? aiTitle ?? summary ?? messages[0]?.text
  return {
    provider,
    sessionId,
    ...(cwd ? { cwd } : {}),
    ...(branch ? { branch } : {}),
    ...(configDir ? { configDir } : {}),
    ...(titleSource ? { title: shortTitle(titleSource) } : {}),
    messages,
  }
}

/** Streams a Codex rollout JSONL and extracts user-sent messages, skipping `codex exec` and subagent jobs fast. */
export async function extractCodexRolloutMessages(
  file: string,
  fallbackTimeMs: number,
  threadNames: ReadonlyMap<string, string> = new Map(),
): Promise<ExtractedConversationMessages | null> {
  const firstLine = await readFirstLine(file, CODEX_META_BYTES)
  if (!firstLine || firstLine.type !== 'session_meta') return null
  const meta = record(firstLine.payload)
  if (isCodexJob(meta)) return null
  const sessionId = meta.id ?? meta.session_id
  if (!isChatConversationSessionId(sessionId) || typeof meta.cwd !== 'string') return null

  const cwd = meta.cwd
  let branch: string | undefined
  const primaryMessages: ExtractedSentMessage[] = []
  const fallbackMessages: ExtractedSentMessage[] = []

  const pushUnique = (target: ExtractedSentMessage[], text: string, sentAt: number, prefix: string) => {
    const previous = target[target.length - 1]
    if (previous && previous.text === text && Math.abs(previous.sentAt - sentAt) <= 5_000) return
    target.push({ messageId: `${prefix}-${target.length}`, text, sentAt })
  }

  await forEachJsonLine(file, (entry) => {
    const payload = record(entry.payload)
    if (!branch && typeof record(payload.git).branch === 'string' && (record(payload.git).branch as string)) {
      branch = record(payload.git).branch as string
    }
    const sentAt = parseTimestampMs(entry.timestamp, fallbackTimeMs)
    if (entry.type === 'event_msg' && payload.type === 'user_message') {
      const text = cleanUserMessageText(extractTextContent(payload.message))
      if (text) pushUnique(primaryMessages, text, sentAt, 'codex-ev')
    } else if (entry.type === 'event_msg' && payload.type === 'item_completed') {
      const item = record(payload.item)
      if (item.type === 'UserMessage') {
        const text = cleanUserMessageText(extractTextContent(item.content))
        if (text) pushUnique(primaryMessages, text, sentAt, 'codex-item')
      }
    } else if (entry.type === 'response_item' && payload.type === 'message' && payload.role === 'user') {
      const text = cleanUserMessageText(extractTextContent(payload.content))
      if (text) pushUnique(fallbackMessages, text, sentAt, 'codex-resp')
    }
  })

  const messages = primaryMessages.length ? primaryMessages : fallbackMessages
  const titleSource = threadNames.get(sessionId) ?? messages[0]?.text
  return {
    provider: 'codex',
    sessionId,
    cwd,
    ...(branch ? { branch } : {}),
    ...(titleSource ? { title: shortTitle(titleSource) } : {}),
    messages,
  }
}

/** Streams a Cursor CLI transcript JSONL and extracts user-sent prompts. */
export async function extractCursorTranscriptMessages(
  file: string,
  cwd: string,
  fallbackTimeMs: number,
): Promise<ExtractedConversationMessages | null> {
  const sessionId = basename(file, '.jsonl')
  if (!isChatConversationSessionId(sessionId) || !cwd) return null

  const rawMessages: { text: string; sentAt?: number }[] = []
  await forEachJsonLine(file, (entry) => {
    if (entry.role !== 'user') return
    const rawContent = extractTextContent(record(entry.message).content)
    const tagged = rawContent.match(/<user_query>([\s\S]*?)<\/user_query>/)?.[1]
    const text = cleanUserMessageText(tagged ?? rawContent)
    if (!text) return
    const explicitTs = entry.timestamp ?? entry.createdAt ?? entry.sentAt
    const sentAt = explicitTs !== undefined ? parseTimestampMs(explicitTs, 0) : 0
    rawMessages.push({ text, ...(sentAt > 0 ? { sentAt } : {}) })
  })

  const total = rawMessages.length
  const messages: ExtractedSentMessage[] = rawMessages.map((entry, index) => ({
    messageId: `cursor-${index}`,
    text: entry.text,
    sentAt: entry.sentAt ?? Math.max(1, fallbackTimeMs - (total - 1 - index)),
  }))

  const titleSource = messages[0]?.text
  return {
    provider: 'cursor',
    sessionId,
    cwd,
    ...(titleSource ? { title: shortTitle(titleSource) } : {}),
    messages,
  }
}

export interface MuseSessionMeta {
  sessionId: string
  logPath: string
  cwd: string
  title: string
  branch?: string
  firstUserPrompt?: string
  updatedAt: number
}

/** Streams a Muse session JSONL log and extracts accepted user prompts. */
export async function extractMuseLogMessages(meta: MuseSessionMeta): Promise<ExtractedConversationMessages | null> {
  if (!isChatConversationSessionId(meta.sessionId)) return null
  const messages: ExtractedSentMessage[] = []
  const seenIds = new Set<string>()

  try {
    await forEachJsonLine(meta.logPath, (entry) => {
      if (entry.payload_type !== 'runtime.user_intent.accepted') return
      const payload = record(entry.payload)
      const semantic = record(payload.semantic_kind)
      if (semantic.kind === 'reminder' || semantic.kind === 'system') return
      const text = cleanUserMessageText(extractTextContent(payload.refill_blocks))
      if (!text) return
      const messageId = typeof entry.id === 'string' && entry.id ? entry.id : `muse-${messages.length}`
      if (seenIds.has(messageId)) return
      seenIds.add(messageId)
      messages.push({
        messageId,
        text,
        sentAt: parseTimestampMs(entry.recorded_at, meta.updatedAt),
      })
    })
  } catch {
    // Fall back to the first prompt recorded in Muse's index DB if the log is unreadable.
  }

  if (!messages.length && meta.firstUserPrompt) {
    const cleaned = cleanUserMessageText(meta.firstUserPrompt)
    if (cleaned) messages.push({ messageId: 'muse-first', text: cleaned, sentAt: meta.updatedAt })
  }

  return {
    provider: 'muse',
    sessionId: meta.sessionId,
    cwd: meta.cwd,
    ...(meta.branch ? { branch: meta.branch } : {}),
    title: shortTitle(meta.title),
    messages,
  }
}

/** Reads user-sent messages from OpenCode's SQLite database. */
export function extractOpencodeMessages(opencodeDbPath: string): ExtractedConversationMessages[] {
  let db: DatabaseSync | undefined
  try {
    db = new DatabaseSync(opencodeDbPath, { readOnly: true })
    const rows = db.prepare(`
      SELECT s.id AS session_id, s.directory, s.title, s.time_updated,
             m.id AS message_id, m.time_created, p.data AS part_data
      FROM session s
      JOIN message m ON m.session_id = s.id
      JOIN part p ON p.message_id = m.id
      WHERE s.parent_id IS NULL
        AND s.time_archived IS NULL
        AND json_extract(m.data, '$.role') = 'user'
        AND json_extract(p.data, '$.type') = 'text'
      ORDER BY s.time_updated DESC, m.time_created ASC, p.time_created ASC
    `).all()

    const bySession = new Map<string, {
      sessionId: string
      cwd: string
      title: string
      byMessage: Map<string, { sentAt: number; parts: string[] }>
    }>()

    for (const row of rows) {
      if (!isChatConversationSessionId(row.session_id) || typeof row.directory !== 'string' || !isAbsolute(row.directory)) continue
      if (typeof row.message_id !== 'string' || typeof row.part_data !== 'string') continue
      let part: Record<string, unknown>
      try {
        part = record(JSON.parse(row.part_data))
      } catch {
        continue
      }
      if (typeof part.text !== 'string' || !part.text) continue

      let session = bySession.get(row.session_id)
      if (!session) {
        session = {
          sessionId: row.session_id,
          cwd: row.directory,
          title: typeof row.title === 'string' && row.title.trim() ? shortTitle(row.title) : row.session_id,
          byMessage: new Map(),
        }
        bySession.set(row.session_id, session)
      }
      let message = session.byMessage.get(row.message_id)
      if (!message) {
        const created = typeof row.time_created === 'number' && Number.isFinite(row.time_created)
          ? row.time_created
          : typeof row.time_updated === 'number' && Number.isFinite(row.time_updated)
            ? row.time_updated
            : 0
        message = { sentAt: created, parts: [] }
        session.byMessage.set(row.message_id, message)
      }
      message.parts.push(part.text)
    }

    const conversations: ExtractedConversationMessages[] = []
    for (const session of bySession.values()) {
      const messages: ExtractedSentMessage[] = []
      for (const [messageId, entry] of session.byMessage) {
        const text = cleanUserMessageText(entry.parts.join('\n'))
        if (!text) continue
        messages.push({ messageId, text, sentAt: entry.sentAt })
      }
      if (messages.length) {
        conversations.push({
          provider: 'opencode',
          sessionId: session.sessionId,
          cwd: session.cwd,
          title: session.title,
          messages,
        })
      }
    }
    return conversations
  } catch {
    return []
  } finally {
    db?.close()
  }
}
