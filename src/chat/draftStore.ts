const PREFIX = 'commando:chat-draft:'
const MAX_BYTES = 100 * 1024
const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000

type SavedDraft = { text: string; updatedAt: number }

function parseDraft(raw: string | null, now: number): SavedDraft | null {
  if (!raw || raw.length * 2 > MAX_BYTES) return null
  try {
    const value: unknown = JSON.parse(raw)
    if (!value || typeof value !== 'object') return null
    const draft = value as Partial<SavedDraft>
    return typeof draft.text === 'string' && typeof draft.updatedAt === 'number'
      && Number.isFinite(draft.updatedAt) && now - draft.updatedAt <= MAX_AGE_MS
      ? { text: draft.text, updatedAt: draft.updatedAt } : null
  } catch {
    return null
  }
}

export function readDraft(sessionId: string | undefined): string {
  if (!sessionId) return ''
  try {
    return parseDraft(localStorage.getItem(`${PREFIX}${sessionId}`), Date.now())?.text ?? ''
  } catch {
    return ''
  }
}

export function saveDraft(sessionId: string | undefined, text: string): void {
  if (!sessionId) return
  try {
    const storage = localStorage
    const now = Date.now()
    for (let index = storage.length - 1; index >= 0; index--) {
      const key = storage.key(index)
      if (key?.startsWith(PREFIX) && !parseDraft(storage.getItem(key), now)) storage.removeItem(key)
    }
    const key = `${PREFIX}${sessionId}`
    const raw = JSON.stringify({ text, updatedAt: now } satisfies SavedDraft)
    // localStorage counts UTF-16; skip oversized drafts instead of restoring a truncated message.
    if (!text || raw.length * 2 > MAX_BYTES) storage.removeItem(key)
    else storage.setItem(key, raw)
  } catch {
    // Draft persistence is best effort when storage is unavailable or full.
  }
}
