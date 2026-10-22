import type { ChatItem } from './agent-chat.js'
import type { WebPaneFeedbackNote } from './protocol.js'

/**
 * Chat cards for redline and canvas tiles: an agent opened one, or the user
 * sent answers from one. The daemon records them; the chat shows them on the
 * user's side of the timeline.
 */
export type ChatTileSource = 'redline' | 'canvas'

export type ChatTileEventItem =
  | { kind: 'answer'; question: string; answer: string; note?: string; skipped?: boolean; attachments?: number }
  | { kind: 'comment'; target: string; comment: string; attachments?: number }

export type ChatTileEvent = {
  id: string
  kind: 'opened' | 'sent'
  /** The chat pane the tile belonged to when this happened. */
  paneId: string
  /** That chat's conversation; tmux pane ids are reused, so cards only show in it. */
  sessionId?: string
  webPaneId: string
  source: ChatTileSource
  /** Page or canvas title, when known. */
  title?: string
  /** Last part of the tile's URL, shown when there is no title. */
  fileName: string
  at: number
  /** Sent only: what the user sent, in order. */
  items?: ChatTileEventItem[]
  /** Sent only: the user pressed Send all + Build. */
  build?: boolean
  /** Sent only. `waiting`: the agent was busy and not polling. `collected`: the agent read them. */
  status?: 'sent' | 'waiting' | 'collected'
  collectedAt?: number
}

export const MAX_TILE_EVENT_ITEMS = 50
const MAX_TEXT = 2_000

const MARKER = 'commando-tile-event:'
const MARKER_LINE = /^commando-tile-event:((?: [A-Za-z0-9_-]{1,64})+)$/

/** The last line of a pushed prompt: links the chat message to its cards. */
export function tileEventMarker(ids: readonly string[]): string {
  return `${MARKER} ${ids.join(' ')}`
}

/** Event ids from a pushed prompt's marker line, or none. */
export function parseTileEventIds(text: string): string[] {
  const last = text.trimEnd().split('\n').at(-1) ?? ''
  const match = MARKER_LINE.exec(last)
  return match ? match[1]!.trim().split(' ') : []
}

export function tileEventTitle(event: Pick<ChatTileEvent, 'title' | 'fileName'>): string {
  return event.title?.trim() || event.fileName || 'Untitled'
}

export function tileFileName(url: string): string {
  try {
    const segments = new URL(url).pathname.split('/').filter(Boolean)
    return decodeURIComponent(segments.at(-1) ?? '') || new URL(url).host
  } catch {
    return url.slice(0, 120)
  }
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`

/** "3 answers, 1 comment" */
export function tileEventSummary(items: readonly ChatTileEventItem[]): string {
  const answers = items.filter((item) => item.kind === 'answer' && !item.skipped).length
  const skipped = items.filter((item) => item.kind === 'answer' && item.skipped).length
  const comments = items.filter((item) => item.kind === 'comment').length
  const parts = [
    ...(answers ? [plural(answers, 'answer', 'answers')] : []),
    ...(comments ? [plural(comments, 'comment', 'comments')] : []),
    ...(skipped ? [`${skipped} skipped`] : []),
  ]
  return parts.join(', ') || 'nothing'
}

const clip = (text: string) => text.length <= MAX_TEXT ? text : `${text.slice(0, MAX_TEXT - 1)}…`

function commentTarget(note: WebPaneFeedbackNote): string {
  if (note.canvas) {
    const frame = note.canvas.frameTitle ?? note.canvas.frameId
    return [frame, note.canvas.label].filter(Boolean).join(' › ') || 'Canvas'
  }
  const text = note.text?.replace(/\s+/g, ' ').trim()
  return text ? `${note.tag} “${text.length > 60 ? `${text.slice(0, 59)}…` : text}”` : note.tag
}

export function tileEventItems(notes: readonly WebPaneFeedbackNote[]): ChatTileEventItem[] {
  return notes.slice(0, MAX_TILE_EVENT_ITEMS).map((note): ChatTileEventItem => {
    const attachments = note.attachments?.length ? { attachments: note.attachments.length } : {}
    if (note.response) {
      const skipped = (note.response.data as { skipped?: unknown } | undefined)?.skipped === true
      return {
        kind: 'answer',
        question: clip(note.response.question),
        answer: clip(note.response.answer),
        ...(note.response.note ? { note: clip(note.response.note) } : {}),
        ...(skipped ? { skipped: true } : {}),
        ...attachments,
      }
    }
    return { kind: 'comment', target: clip(commentTarget(note)), comment: clip(note.comment), ...attachments }
  })
}

type UserMessage = Extract<ChatItem, { kind: 'user_message' }>

/**
 * Puts tile events into a chat's items as user-side messages. A message the
 * daemon pushed for some events becomes their card; the rest are placed by
 * time among the main conversation's items.
 */
export function withTileEvents(items: readonly ChatItem[], events: readonly ChatTileEvent[], sessionId?: string): ChatItem[] {
  events = events.filter((event) => !event.sessionId || !sessionId || event.sessionId === sessionId)
  if (!events.length) return [...items]
  const byId = new Map(events.map((event) => [event.id, event]))
  const placed = new Set<string>()
  const merged: ChatItem[] = items.map((item) => {
    if (item.kind !== 'user_message' || item.parentToolUseId) return item
    const ids = parseTileEventIds(item.text)
    const attached = ids.flatMap((id) => byId.get(id) ?? [])
    if (!attached.length) return item
    for (const id of ids) placed.add(id)
    return { ...item, tileEvents: attached }
  })
  // Events from before the earliest item kept belong to history the chat no longer shows.
  const first = items.find((item) => !item.parentToolUseId)?.createdAt ?? -Infinity
  const rest = events.filter((event) => !placed.has(event.id) && event.at >= first).sort((a, b) => a.at - b.at)
  if (!rest.length) return merged
  const out: ChatItem[] = []
  let next = 0
  const synthetic = (event: ChatTileEvent, turnId: string): UserMessage => ({
    id: `tile-event-${event.id}`, kind: 'user_message', text: '', turnId,
    status: 'completed', createdAt: event.at, updatedAt: event.at, tileEvents: [event],
  })
  let turnId: string | undefined
  for (const item of merged) {
    if (!item.parentToolUseId) {
      while (next < rest.length && rest[next]!.at < item.createdAt) {
        out.push(synthetic(rest[next]!, turnId ?? `tile-turn-${rest[next]!.id}`))
        next += 1
      }
      turnId = item.turnId
    }
    out.push(item)
  }
  for (; next < rest.length; next += 1) out.push(synthetic(rest[next]!, turnId ?? `tile-turn-${rest[next]!.id}`))
  return out
}

/** Which card a tile's Send gets: canvas tiles are canvas, plain page tiles are redline. */
export function tileSource(pane: { content?: { kind: string } } | undefined): ChatTileSource | undefined {
  if (!pane) return undefined
  if (!pane.content) return 'redline'
  return pane.content.kind === 'canvas' ? 'canvas' : undefined
}

/** A redline artifact served by the daemon (`/redline/artifacts/<id>/…` on loopback). */
export function isRedlineArtifactUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    return ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname) && parsed.pathname.startsWith('/redline/artifacts/')
  } catch {
    return false
  }
}
