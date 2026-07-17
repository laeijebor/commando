import type { Note } from './notesApi'

export type PinnedNote = {
  vaultId: string
  id: string
  title: string
  body: string
  folder: string
  updatedAt: number
}

export type NoteRequest = {
  vaultId: string
  noteId: string
  requestId: number
}

export const PINNED_NOTE_STORAGE_KEY = 'commando.hud.pinned-note'

export function pinnedNoteFrom(vaultId: string, note: Pick<Note, 'id' | 'title' | 'body' | 'folder' | 'updatedAt'>): PinnedNote {
  return {
    vaultId,
    id: note.id,
    title: note.title,
    body: note.body,
    folder: note.folder,
    updatedAt: note.updatedAt,
  }
}

function isPinnedNote(value: unknown): value is PinnedNote {
  if (!value || typeof value !== 'object') return false
  const note = value as Record<string, unknown>
  return (
    typeof note.vaultId === 'string' &&
    typeof note.id === 'string' &&
    typeof note.title === 'string' &&
    typeof note.body === 'string' &&
    typeof note.folder === 'string' &&
    typeof note.updatedAt === 'number' &&
    Number.isFinite(note.updatedAt)
  )
}

export function storedPinnedNote(): PinnedNote | null {
  try {
    const stored = window.localStorage.getItem(PINNED_NOTE_STORAGE_KEY)
    if (!stored) return null
    const parsed: unknown = JSON.parse(stored)
    return isPinnedNote(parsed) ? parsed : null
  } catch {
    return null
  }
}

export function storePinnedNote(note: PinnedNote | null): void {
  try {
    if (note) window.localStorage.setItem(PINNED_NOTE_STORAGE_KEY, JSON.stringify(note))
    else window.localStorage.removeItem(PINNED_NOTE_STORAGE_KEY)
  } catch {
    // Pinning still works in memory when browser storage is unavailable.
  }
}
