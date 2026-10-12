import { MAX_CHAT_IMAGES, isPaneId, parseChatImageRefs, type ChatImageRef } from './agent-chat.js'

/**
 * The composer's stash: drafts put aside with Ctrl+S, as in the Claude Code
 * TUI. One list for every chat pane, kept by the daemon so it outlives page
 * reloads and restarts and every client sees the same entries.
 */

/** Oldest entries are dropped past this. */
export const MAX_CHAT_STASH_ENTRIES = 50
/** One stashed draft's text; the same limit a sent message has. */
export const MAX_CHAT_STASH_TEXT = 256 * 1024
/** All stashed text together; oldest entries are dropped past this. */
export const MAX_CHAT_STASH_BYTES = 1024 * 1024

/** The chat a draft was stashed from. */
export interface ChatStashSource {
  paneId: string
  /** Claude's session id, when the chat had started one. */
  sessionId?: string
  /** The conversation's title. */
  title?: string
  cwd?: string
}

export interface ChatStashInput {
  text: string
  images: ChatImageRef[]
  source: ChatStashSource
}

export interface ChatStashEntry extends ChatStashInput {
  id: string
  createdAt: number
}

const STASH_ID = /^[0-9a-f]{32}$/

export function isChatStashId(value: unknown): value is string {
  return typeof value === 'string' && STASH_ID.test(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function optionalText(value: unknown, max: number): string | undefined | null {
  if (value === undefined) return undefined
  if (typeof value !== 'string') return null
  return value.slice(0, max) || undefined
}

function parseSource(value: unknown): ChatStashSource | null {
  if (!isRecord(value) || !isPaneId(value.paneId)) return null
  const sessionId = optionalText(value.sessionId, 128)
  const title = optionalText(value.title, 200)
  const cwd = optionalText(value.cwd, 4096)
  if (sessionId === null || title === null || cwd === null) return null
  return {
    paneId: value.paneId,
    ...(sessionId ? { sessionId } : {}),
    ...(title ? { title } : {}),
    ...(cwd ? { cwd } : {}),
  }
}

/** A draft to stash: text or images (or both), and the chat it came from. */
export function parseChatStashInput(value: unknown): ChatStashInput | null {
  if (!isRecord(value) || typeof value.text !== 'string' || value.text.length > MAX_CHAT_STASH_TEXT) return null
  const images = parseChatImageRefs(value.images ?? [], MAX_CHAT_IMAGES)
  const source = parseSource(value.source)
  if (!images || !source || (!value.text.trim() && !images.length)) return null
  return { text: value.text, images, source }
}

export function parseChatStashEntry(value: unknown): ChatStashEntry | null {
  if (!isRecord(value) || !isChatStashId(value.id) || typeof value.createdAt !== 'number' || !Number.isSafeInteger(value.createdAt) || value.createdAt < 0) return null
  const input = parseChatStashInput(value)
  return input ? { id: value.id, createdAt: value.createdAt, ...input } : null
}
