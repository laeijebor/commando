import { randomUUID } from 'node:crypto'
import { chmod, mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

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

type NotesFile = {
  version: 1
  notes: Note[]
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

export function defaultNotesPath(): string {
  return process.env.COMMANDO_NOTES_PATH ?? join(homedir(), '.commando', 'notes.json')
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

export class NoteStore {
  readonly notesPath: string
  private writes: Promise<void> = Promise.resolve()

  constructor(notesPath = defaultNotesPath()) {
    this.notesPath = notesPath
  }

  async list(): Promise<Note[]> {
    await this.writes
    return ordered((await this.readNotes()).notes)
  }

  async get(id: string): Promise<Note> {
    this.validateId(id)
    await this.writes
    const note = (await this.readNotes()).notes.find((candidate) => candidate.id === id)
    if (!note) throw new NoteNotFoundError(id)
    return { ...note }
  }

  create(value: unknown): Promise<Note> {
    const draft = parseNoteDraft(value)
    if (!draft) return Promise.reject(new NoteValidationError())

    return this.enqueue(async () => {
      const file = await this.readNotes()
      const now = Date.now()
      const note: Note = {
        id: randomUUID(),
        ...draft,
        createdAt: now,
        updatedAt: now,
      }
      file.notes.push(note)
      file.notes = ordered(file.notes)
      await this.writeNotes(file)
      return { ...note }
    })
  }

  update(id: string, value: unknown): Promise<Note> {
    try {
      this.validateId(id)
    } catch (error) {
      return Promise.reject(error)
    }
    const draft = parseNoteDraft(value)
    if (!draft) return Promise.reject(new NoteValidationError())

    return this.enqueue(async () => {
      const file = await this.readNotes()
      const index = file.notes.findIndex((note) => note.id === id)
      if (index < 0) throw new NoteNotFoundError(id)
      const existing = file.notes[index]
      const note: Note = {
        ...existing,
        ...draft,
        updatedAt: Math.max(Date.now(), existing.updatedAt + 1),
      }
      file.notes[index] = note
      file.notes = ordered(file.notes)
      await this.writeNotes(file)
      return { ...note }
    })
  }

  delete(id: string): Promise<void> {
    try {
      this.validateId(id)
    } catch (error) {
      return Promise.reject(error)
    }

    return this.enqueue(async () => {
      const file = await this.readNotes()
      const index = file.notes.findIndex((note) => note.id === id)
      if (index < 0) throw new NoteNotFoundError(id)
      file.notes.splice(index, 1)
      await this.writeNotes(file)
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

  private async readNotes(): Promise<NotesFile> {
    try {
      const content = await readFile(this.notesPath, 'utf8')
      return parseNotesFile(JSON.parse(content) as unknown)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { version: 1, notes: [] }
      }
      if (error instanceof SyntaxError) {
        throw new Error('Notes file contains invalid JSON', { cause: error })
      }
      throw error
    }
  }

  private async writeNotes(file: NotesFile): Promise<void> {
    const directory = dirname(this.notesPath)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    await chmod(directory, 0o700)
    const temporaryPath = `${this.notesPath}.${process.pid}.${randomUUID()}.tmp`
    let handle: Awaited<ReturnType<typeof open>> | null = null

    try {
      handle = await open(temporaryPath, 'wx', 0o600)
      await handle.writeFile(`${JSON.stringify({ ...file, notes: ordered(file.notes) }, null, 2)}\n`, 'utf8')
      await handle.sync()
      await handle.close()
      handle = null
      await rename(temporaryPath, this.notesPath)
      await chmod(this.notesPath, 0o600)

      try {
        const directoryHandle = await open(directory, 'r')
        try {
          await directoryHandle.sync()
        } finally {
          await directoryHandle.close()
        }
      } catch {
        // Directory fsync is not supported by every filesystem.
      }
    } catch (error) {
      await handle?.close().catch(() => undefined)
      await rm(temporaryPath, { force: true }).catch(() => undefined)
      throw error
    }
  }
}
