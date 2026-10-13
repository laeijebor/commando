import { parseChatImageRefs, type ChatImageRef } from '../../shared/agent-chat'

const PREFIX = 'commando:chat-draft:'
const MAX_BYTES = 100 * 1024
const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000

/** The unsent text and uploaded images of a chat's composer. */
export type SavedDraftContent = { text: string; images: ChatImageRef[] }
type SavedDraft = { text: string; images?: ChatImageRef[]; updatedAt: number }

const EMPTY: SavedDraftContent = { text: '', images: [] }

const sameImages = (a: ChatImageRef[], b: ChatImageRef[]) =>
  a.length === b.length && a.every((ref, index) => ref.id === b[index]!.id && ref.name === b[index]!.name)

function parseDraft(raw: string | null, now: number): SavedDraft | null {
  if (!raw || raw.length * 2 > MAX_BYTES) return null
  try {
    const value: unknown = JSON.parse(raw)
    if (!value || typeof value !== 'object') return null
    const draft = value as Partial<SavedDraft>
    if (typeof draft.text !== 'string' || typeof draft.updatedAt !== 'number'
      || !Number.isFinite(draft.updatedAt) || now - draft.updatedAt > MAX_AGE_MS) return null
    const images = parseChatImageRefs(draft.images) ?? []
    return { text: draft.text, images, updatedAt: draft.updatedAt }
  } catch {
    return null
  }
}

export function loadDraft(sessionId: string | undefined): SavedDraftContent {
  if (!sessionId) return EMPTY
  try {
    const saved = parseDraft(localStorage.getItem(`${PREFIX}${sessionId}`), Date.now())
    return saved ? { text: saved.text, images: saved.images ?? [] } : EMPTY
  } catch {
    return EMPTY
  }
}

export function readDraft(sessionId: string | undefined): string {
  return loadDraft(sessionId).text
}

/**
 * Images are saved as refs to the daemon's uploads, which it prunes after 30 days
 * unused. One pruned anyway comes back as a broken thumbnail, and a send with it is
 * refused with "attach it again".
 */
export function saveDraft(sessionId: string | undefined, text: string, images: ChatImageRef[] = []): void {
  if (!sessionId) return
  try {
    const storage = localStorage
    const now = Date.now()
    for (let index = storage.length - 1; index >= 0; index--) {
      const key = storage.key(index)
      if (key?.startsWith(PREFIX) && !parseDraft(storage.getItem(key), now)) storage.removeItem(key)
    }
    const key = `${PREFIX}${sessionId}`
    // Only a change restarts the expiry: a draft just reopened keeps its age, so it
    // expires before its images are pruned.
    const previous = parseDraft(storage.getItem(key), now)
    if (previous && previous.text === text && sameImages(previous.images ?? [], images)) return
    const raw = JSON.stringify({ text, ...(images.length ? { images } : {}), updatedAt: now } satisfies SavedDraft)
    // localStorage counts UTF-16; skip oversized drafts instead of restoring a truncated message.
    if ((!text && !images.length) || raw.length * 2 > MAX_BYTES) storage.removeItem(key)
    else storage.setItem(key, raw)
  } catch {
    // Draft persistence is best effort when storage is unavailable or full.
  }
}
