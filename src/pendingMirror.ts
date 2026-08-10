import {
  MAX_PENDING_NOTES,
  type WebPaneImageAttachment,
  type WebPanePendingNote,
} from '../shared/protocol'

const KEY_PREFIX = 'commando.redline.pending.'

function storageKey(webPaneId: string): string {
  return `${KEY_PREFIX}${webPaneId}`
}

function defaultStorage(): Storage | null {
  try {
    return window.localStorage
  } catch {
    return null
  }
}

function isFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function isAttachment(value: unknown): value is WebPaneImageAttachment {
  if (typeof value !== 'object' || value === null) return false
  const attachment = value as Record<string, unknown>
  return nonEmptyString(attachment.id) &&
    nonEmptyString(attachment.name) &&
    nonEmptyString(attachment.contentType) &&
    isFinite(attachment.size) && Number.isSafeInteger(attachment.size) && attachment.size > 0
}

function parseNote(value: unknown): WebPanePendingNote | null {
  if (typeof value !== 'object' || value === null) return null
  const note = value as Record<string, unknown>
  const rect = note.rect as Record<string, unknown> | undefined
  if (
    !isFinite(note.id) ||
    (note.revision !== undefined && (!isFinite(note.revision) || !Number.isSafeInteger(note.revision) || note.revision <= 0)) ||
    !nonEmptyString(note.selector) ||
    !nonEmptyString(note.tag) ||
    !nonEmptyString(note.comment) ||
    (note.text !== undefined && typeof note.text !== 'string') ||
    (note.queueKey !== undefined && typeof note.queueKey !== 'string') ||
    (note.attachments !== undefined && (!Array.isArray(note.attachments) || !note.attachments.every(isAttachment))) ||
    typeof rect !== 'object' || rect === null ||
    !isFinite(rect.x) || !isFinite(rect.y) || !isFinite(rect.width) || !isFinite(rect.height)
  ) {
    return null
  }
  let response: WebPanePendingNote['response']
  if (note.response !== undefined) {
    const raw = note.response as Record<string, unknown> | null
    if (typeof raw !== 'object' || raw === null) return null
    if (!nonEmptyString(raw.question) || !nonEmptyString(raw.answer)) return null
    response = { question: raw.question, answer: raw.answer }
    if (raw.note !== undefined) {
      if (typeof raw.note !== 'string') return null
      response.note = raw.note
    }
    if (raw.data !== undefined) response.data = raw.data
  }
  return {
    id: note.id,
    revision: note.revision === undefined ? 1 : note.revision as number,
    selector: note.selector,
    tag: note.tag,
    ...(note.text !== undefined ? { text: note.text as string } : {}),
    rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    comment: note.comment,
    ...(note.queueKey !== undefined ? { queueKey: note.queueKey as string } : {}),
    ...(response !== undefined ? { response } : {}),
    // Attachment URLs are daemon capabilities. A localStorage draft may
    // preserve the pill, but it must never be able to recreate file access.
    attachments: [],
  }
}

/**
 * localStorage mirror of a tile's queued-but-unsent review pills — belt and
 * braces behind the daemon's pending store. The daemon is the source of
 * truth; the mirror only matters when the daemon definitively reports an
 * empty queue that the browser knows should not be (e.g. a lost journal).
 */
export function loadPendingMirror(
  webPaneId: string,
  storage: Storage | null = defaultStorage(),
): WebPanePendingNote[] {
  if (!storage) return []
  let raw: string | null
  try {
    raw = storage.getItem(storageKey(webPaneId))
  } catch {
    return []
  }
  if (raw === null) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  return parsed
    .map(parseNote)
    .filter((note): note is WebPanePendingNote => note !== null)
    .slice(0, MAX_PENDING_NOTES)
}

/** Mirrors the queue; an empty queue clears the entry so it cannot resurrect. */
export function savePendingMirror(
  webPaneId: string,
  notes: readonly WebPanePendingNote[],
  storage: Storage | null = defaultStorage(),
): void {
  if (!storage) return
  try {
    if (notes.length === 0) {
      storage.removeItem(storageKey(webPaneId))
    } else {
      storage.setItem(storageKey(webPaneId), JSON.stringify(notes.map((note) => ({ ...note, attachments: [] }))))
    }
  } catch {
    // Quota or privacy-mode failure — the daemon still has the notes.
  }
}
