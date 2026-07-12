import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import {
  access,
  chmod,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  utimes,
} from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import {
  isMarkdownNoteFile,
  noteFileName,
  parseNoteMarkdown,
  serializeNoteMarkdown,
} from './note-markdown.js'

export const MAX_NOTE_TITLE_LENGTH = 200
export const MAX_NOTE_BODY_LENGTH = 512 * 1024

export type Note = {
  id: string
  title: string
  body: string
  createdAt: number
  updatedAt: number
}

export type NoteDraft = {
  title: string
  body: string
}

export type NoteUpdate = NoteDraft & {
  expectedUpdatedAt?: number
}

type NotesFile = {
  version: 1
  notes: Note[]
}

type StoredNote = {
  note: Note
  path: string
  fingerprint: FileFingerprint
}

type FileFingerprint = {
  device: number
  inode: number
  modifiedAt: number
  size: number
}

export type NoteStoreOptions = {
  directory?: string
  legacyPath?: string | null
}

const NOTE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function validTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function validText(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length <= maximum && !value.includes('\u0000')
}

export function parseNoteDraft(value: unknown): NoteDraft | null {
  if (!isRecord(value)) return null
  if (!validText(value.title, MAX_NOTE_TITLE_LENGTH)) return null
  if (!validText(value.body, MAX_NOTE_BODY_LENGTH)) return null
  return { title: value.title, body: value.body }
}

function parseNoteUpdate(value: unknown): NoteUpdate | null {
  const draft = parseNoteDraft(value)
  if (!draft || !isRecord(value)) return null
  if (value.expectedUpdatedAt !== undefined && !validTimestamp(value.expectedUpdatedAt)) return null
  return { ...draft, expectedUpdatedAt: value.expectedUpdatedAt as number | undefined }
}

export function parseNote(value: unknown): Note | null {
  if (!isRecord(value)) return null
  const draft = parseNoteDraft(value)
  if (
    !draft ||
    typeof value.id !== 'string' ||
    !NOTE_ID.test(value.id) ||
    !validTimestamp(value.createdAt) ||
    !validTimestamp(value.updatedAt) ||
    value.updatedAt < value.createdAt
  ) {
    return null
  }

  return {
    id: value.id,
    ...draft,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  }
}

function compareNotes(left: Note, right: Note): number {
  return (
    right.updatedAt - left.updatedAt ||
    right.createdAt - left.createdAt ||
    left.id.localeCompare(right.id)
  )
}

function ordered(notes: Iterable<Note>): Note[] {
  return Array.from(notes, (note) => ({ ...note })).sort(compareNotes)
}

export function parseNotesFile(value: unknown): NotesFile {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.notes)) {
    throw new Error('Notes file has an invalid structure')
  }

  const notes = value.notes.map(parseNote)
  if (notes.some((note) => note === null)) {
    throw new Error('Notes file contains an invalid note')
  }
  const validNotes = notes as Note[]
  if (new Set(validNotes.map((note) => note.id)).size !== validNotes.length) {
    throw new Error('Notes file contains duplicate note ids')
  }
  return { version: 1, notes: ordered(validNotes) }
}

export function defaultNotesDirectory(environment: NodeJS.ProcessEnv = process.env): string {
  const configured = environment.COMMANDO_NOTES_DIR
  if (configured && !isAbsolute(configured)) {
    throw new Error('COMMANDO_NOTES_DIR must be an absolute path')
  }
  return configured ?? join(homedir(), '.commando', 'notes')
}

export function defaultLegacyNotesPath(environment: NodeJS.ProcessEnv = process.env): string {
  const configured = environment.COMMANDO_NOTES_PATH
  if (configured && !isAbsolute(configured)) {
    throw new Error('COMMANDO_NOTES_PATH must be an absolute path')
  }
  return configured ?? join(homedir(), '.commando', 'notes.json')
}

export class NoteNotFoundError extends Error {
  constructor(id: string) {
    super(`Note not found: ${id}`)
    this.name = 'NoteNotFoundError'
  }
}

export class NoteValidationError extends Error {
  constructor(message = 'Invalid note') {
    super(message)
    this.name = 'NoteValidationError'
  }
}

export class NoteConflictError extends Error {
  constructor() {
    super('Note changed outside Commando')
    this.name = 'NoteConflictError'
  }
}

export class NoteStore {
  readonly directory: string
  readonly legacyPath: string | null
  private initialization: Promise<void> | null = null
  private writes: Promise<void> = Promise.resolve()

  constructor(options: NoteStoreOptions = {}) {
    this.directory = options.directory ?? defaultNotesDirectory()
    this.legacyPath = options.legacyPath === undefined ? defaultLegacyNotesPath() : options.legacyPath
  }

  async list(): Promise<Note[]> {
    await this.writes
    await this.ensureInitialized()
    return ordered((await this.readStoredNotes()).map(({ note }) => note))
  }

  async get(id: string): Promise<Note> {
    this.validateId(id)
    await this.writes
    await this.ensureInitialized()
    const stored = (await this.readStoredNotes()).find(({ note }) => note.id === id)
    if (!stored) throw new NoteNotFoundError(id)
    return { ...stored.note }
  }

  create(value: unknown): Promise<Note> {
    const draft = parseNoteDraft(value)
    if (!draft) return Promise.reject(new NoteValidationError())

    return this.enqueue(async () => {
      await this.ensureInitialized()
      const now = Date.now()
      const note: Note = {
        id: randomUUID(),
        ...draft,
        createdAt: now,
        updatedAt: now,
      }
      await this.writeNote(note)
      return { ...note }
    })
  }

  update(id: string, value: unknown): Promise<Note> {
    try {
      this.validateId(id)
    } catch (error) {
      return Promise.reject(error)
    }
    const update = parseNoteUpdate(value)
    if (!update) return Promise.reject(new NoteValidationError())

    return this.enqueue(async () => {
      await this.ensureInitialized()
      const stored = (await this.readStoredNotes()).find(({ note }) => note.id === id)
      if (!stored) throw new NoteNotFoundError(id)
      if (
        update.expectedUpdatedAt !== undefined &&
        update.expectedUpdatedAt !== stored.note.updatedAt
      ) {
        throw new NoteConflictError()
      }

      const note: Note = {
        ...stored.note,
        title: update.title,
        body: update.body,
        updatedAt: Math.max(Date.now(), stored.note.updatedAt + 1),
      }
      await this.writeNote(note, stored.path, stored.fingerprint)
      return { ...note }
    })
  }

  delete(id: string, expectedUpdatedAt?: number): Promise<void> {
    try {
      this.validateId(id)
    } catch (error) {
      return Promise.reject(error)
    }

    return this.enqueue(async () => {
      await this.ensureInitialized()
      const stored = (await this.readStoredNotes()).find(({ note }) => note.id === id)
      if (!stored) throw new NoteNotFoundError(id)
      if (expectedUpdatedAt !== undefined && expectedUpdatedAt !== stored.note.updatedAt) {
        throw new NoteConflictError()
      }
      if (!this.sameFingerprint(stored.fingerprint, await this.fileFingerprint(stored.path))) {
        throw new NoteConflictError()
      }
      await rm(stored.path)
      await this.syncDirectory()
    })
  }

  private validateId(id: string): void {
    if (!NOTE_ID.test(id)) throw new NoteValidationError('Invalid note id')
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const operation = this.writes.then(task)
    this.writes = operation.then(
      () => undefined,
      () => undefined,
    )
    return operation
  }

  private ensureInitialized(): Promise<void> {
    this.initialization ??= this.initialize()
    return this.initialization
  }

  private async initialize(): Promise<void> {
    const created = await mkdir(this.directory, { recursive: true, mode: 0o700 })
    if (created) await chmod(this.directory, 0o700)
    await this.migrateLegacyNotes()
  }

  private async migrateLegacyNotes(): Promise<void> {
    if (!this.legacyPath) return

    let content: string
    try {
      content = await readFile(this.legacyPath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }

    let legacy: NotesFile
    try {
      legacy = parseNotesFile(JSON.parse(content) as unknown)
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new Error('Legacy notes file contains invalid JSON', { cause: error })
      }
      throw error
    }

    const existingIds = new Set((await this.readStoredNotes()).map(({ note }) => note.id))
    for (const note of legacy.notes) {
      if (!existingIds.has(note.id)) await this.writeNote(note)
    }

    let migratedPath = `${this.legacyPath}.migrated`
    try {
      await access(migratedPath, constants.F_OK)
      migratedPath = `${migratedPath}.${Date.now()}`
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    await rename(this.legacyPath, migratedPath)
  }

  private async readStoredNotes(): Promise<StoredNote[]> {
    const entries = await readdir(this.directory, { withFileTypes: true })
    const notes: StoredNote[] = []

    for (const entry of entries) {
      if (!entry.isFile() || !isMarkdownNoteFile(entry.name)) continue
      const path = join(this.directory, entry.name)
      let stable: { content: string; fingerprint: FileFingerprint }
      try {
        stable = await this.readStableFile(path)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
        throw error
      }
      const { content, fingerprint } = stable
      const value = parseNoteMarkdown(content)
      if (value === null) continue
      const parsed = parseNote(value)
      if (!parsed) throw new Error(`Markdown note has invalid Commando metadata: ${entry.name}`)
      parsed.updatedAt = Math.max(parsed.updatedAt, Math.round(fingerprint.modifiedAt))
      notes.push({ note: parsed, path, fingerprint })
    }

    const ids = notes.map(({ note }) => note.id)
    if (new Set(ids).size !== ids.length) throw new Error('Markdown notes contain duplicate note ids')
    return notes
  }

  private async writeNote(
    note: Note,
    previousPath?: string,
    expectedFingerprint?: FileFingerprint,
  ): Promise<void> {
    const path = join(this.directory, noteFileName(note))
    const temporaryPath = join(this.directory, `.${note.id}.${process.pid}.${randomUUID()}.tmp`)
    let handle: Awaited<ReturnType<typeof open>> | null = null

    try {
      handle = await open(temporaryPath, 'wx', 0o600)
      await handle.writeFile(serializeNoteMarkdown(note), 'utf8')
      await handle.sync()
      await handle.close()
      handle = null
      if (
        previousPath &&
        expectedFingerprint &&
        !this.sameFingerprint(expectedFingerprint, await this.fileFingerprint(previousPath))
      ) {
        throw new NoteConflictError()
      }
      await rename(temporaryPath, path)
      await chmod(path, 0o600)
      await utimes(path, new Date(), new Date(note.updatedAt))
      if (previousPath && previousPath !== path) await rm(previousPath)
      await this.syncDirectory()
    } catch (error) {
      await handle?.close().catch(() => undefined)
      await rm(temporaryPath, { force: true }).catch(() => undefined)
      throw error
    }
  }

  private async syncDirectory(): Promise<void> {
    try {
      const directoryHandle = await open(this.directory, 'r')
      try {
        await directoryHandle.sync()
      } finally {
        await directoryHandle.close()
      }
    } catch {
      // Directory fsync is not supported by every filesystem.
    }
  }

  private async readStableFile(path: string): Promise<{
    content: string
    fingerprint: FileFingerprint
  }> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const before = await this.fileFingerprint(path)
      const content = await readFile(path, 'utf8')
      const after = await this.fileFingerprint(path)
      if (this.sameFingerprint(before, after)) return { content, fingerprint: after }
    }
    throw new NoteConflictError()
  }

  private async fileFingerprint(path: string): Promise<FileFingerprint> {
    const fileStat = await stat(path)
    return {
      device: fileStat.dev,
      inode: fileStat.ino,
      modifiedAt: fileStat.mtimeMs,
      size: fileStat.size,
    }
  }

  private sameFingerprint(left: FileFingerprint, right: FileFingerprint): boolean {
    return (
      left.device === right.device &&
      left.inode === right.inode &&
      left.modifiedAt === right.modifiedAt &&
      left.size === right.size
    )
  }
}
