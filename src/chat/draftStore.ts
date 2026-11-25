import { parseChatImageRefs, type AsideReport, type ChatImageRef } from '../../shared/agent-chat'

const PREFIX = 'commando:chat-draft:'
const MAX_BYTES = 100 * 1024
const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000

/** A reference waits with Main’s draft until the next message is sent. */
export type PendingAsideReference = AsideReport & { close?: boolean }
export type ReportSend = { requestId: string; text: string; at: number }
/** Composer content and report sends waiting for a possible refusal. */
export type SavedDraftContent = { text: string; images: ChatImageRef[]; references?: PendingAsideReference[]; reportSends?: ReportSend[] }
type SavedDraft = Omit<SavedDraftContent, 'images'> & { images?: ChatImageRef[]; updatedAt: number }

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
    const references = Array.isArray(draft.references) ? draft.references.filter((ref): ref is PendingAsideReference =>
      !!ref && typeof ref === 'object' && typeof ref.asideId === 'string' && typeof ref.title === 'string' && typeof ref.body === 'string' && (ref.close === undefined || typeof ref.close === 'boolean')) : []
    const reportSends = Array.isArray(draft.reportSends) ? draft.reportSends.filter((send): send is ReportSend =>
      !!send && typeof send === 'object' && typeof send.requestId === 'string' && typeof send.text === 'string' && typeof send.at === 'number' && Number.isFinite(send.at)) : []
    return { text: draft.text, images, ...(references.length ? { references } : {}), ...(reportSends.length ? { reportSends } : {}), updatedAt: draft.updatedAt }
  } catch {
    return null
  }
}

export function loadDraft(sessionId: string | undefined): SavedDraftContent {
  if (!sessionId) return EMPTY
  try {
    const saved = parseDraft(localStorage.getItem(`${PREFIX}${sessionId}`), Date.now())
    if (!saved) return EMPTY
    const { updatedAt: _updatedAt, ...content } = saved
    return { ...content, images: saved.images ?? [] }
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
export function saveDraft(sessionId: string | undefined, text: string, images: ChatImageRef[] = [], reports?: Pick<SavedDraftContent, 'references' | 'reportSends'>): void {
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
    const references = reports?.references ?? previous?.references ?? []
    const reportSends = reports?.reportSends ?? previous?.reportSends ?? []
    if (previous && previous.text === text && sameImages(previous.images ?? [], images)
      && JSON.stringify(previous.references ?? []) === JSON.stringify(references)
      && JSON.stringify(previous.reportSends ?? []) === JSON.stringify(reportSends)) return
    const raw = JSON.stringify({ text, ...(images.length ? { images } : {}), ...(references.length ? { references } : {}), ...(reportSends.length ? { reportSends } : {}), updatedAt: now } satisfies SavedDraft)
    // localStorage counts UTF-16; skip oversized drafts instead of restoring a truncated message.
    if ((!text && !images.length && !references.length && !reportSends.length) || raw.length * 2 > MAX_BYTES) storage.removeItem(key)
    else storage.setItem(key, raw)
  } catch {
    // Draft persistence is best effort when storage is unavailable or full.
  }
}

/** Update report metadata without overwriting the composer's text or attachments. */
export function updateDraftReports(sessionId: string | undefined, reports: Pick<SavedDraftContent, 'references' | 'reportSends'>): void {
  const draft = loadDraft(sessionId)
  saveDraft(sessionId, draft.text, draft.images, reports)
}

export function appendDraftText(sessionId: string | undefined, text: string): string {
  const draft = loadDraft(sessionId)
  const combined = [draft.text, text].filter(Boolean).join('\n\n')
  saveDraft(sessionId, combined, draft.images)
  return combined
}
