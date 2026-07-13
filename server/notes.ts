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
export const MAX_NOTE_IMAGE_BYTES = 10 * 1024 * 1024

const NOTE_IMAGE_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(png|jpg|gif|webp)$/i
const NOTE_IMAGE_FORMATS = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
} as const

type NoteImageContentType = keyof typeof NOTE_IMAGE_FORMATS

export type NoteImage = {
  data: Buffer
  contentType: NoteImageContentType
}

export type Note = {
  id: string
  title: string
  body: string
  folder: string
  createdAt: number
  updatedAt: number
}

export type NoteDraft = {
  title: string
  body: string
  folder: string
}

export type NoteUpdate = Pick<NoteDraft, 'title' | 'body'> & {
  folder?: string
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

export function parseNoteFolder(value: unknown): string | null {
  if (value === undefined || value === '') return ''
  if (typeof value !== 'string' || value.length > 512 || value.startsWith('/') || value.includes('\\')) return null
  const segments = value.split('/')
  if (segments.length > 8 || segments.some((segment) => (
    segment.length === 0 ||
    segment.length > 128 ||
    segment === '.' ||
    segment === '..' ||
    segment === 'images' ||
    segment.startsWith('.') ||
    /[\u0000-\u001f\u007f]/.test(segment)
  ))) return null
  return segments.join('/')
}

function validImageData(data: Buffer, contentType: NoteImageContentType): boolean {
  if (data.length === 0 || data.length > MAX_NOTE_IMAGE_BYTES) return false
  if (contentType === 'image/png') {
    return data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  }
  if (contentType === 'image/jpeg') {
    return data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff
  }
  if (contentType === 'image/gif') {
    const signature = data.subarray(0, 6).toString('ascii')
    return signature === 'GIF87a' || signature === 'GIF89a'
  }
  return data.length >= 12 && data.subarray(0, 4).toString('ascii') === 'RIFF' && data.subarray(8, 12).toString('ascii') === 'WEBP'
}

function imageContentType(name: string): NoteImageContentType | null {
  const extension = NOTE_IMAGE_NAME.exec(name)?.[1]?.toLowerCase()
  const match = Object.entries(NOTE_IMAGE_FORMATS).find(([, candidate]) => candidate === extension)
  return match ? match[0] as NoteImageContentType : null
}

export function parseNoteDraft(value: unknown): NoteDraft | null {
  if (!isRecord(value)) return null
  if (!validText(value.title, MAX_NOTE_TITLE_LENGTH)) return null
  if (!validText(value.body, MAX_NOTE_BODY_LENGTH)) return null
  const folder = parseNoteFolder(value.folder)
  if (folder === null) return null
  return { title: value.title, body: value.body, folder }
}

function parseNoteUpdate(value: unknown): NoteUpdate | null {
  const draft = parseNoteDraft(value)
  if (!draft || !isRecord(value)) return null
  if (value.expectedUpdatedAt !== undefined && !validTimestamp(value.expectedUpdatedAt)) return null
  return {
    title: draft.title,
    body: draft.body,
    ...(value.folder === undefined ? {} : { folder: draft.folder }),
    expectedUpdatedAt: value.expectedUpdatedAt as number | undefined,
  }
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
  if (configured !== undefined && !isAbsolute(configured)) {
    throw new Error('COMMANDO_NOTES_DIR must be an absolute path')
  }
  return configured ?? join(homedir(), '.commando', 'notes-vaults', 'default')
}

export function defaultLegacyNotesPath(environment: NodeJS.ProcessEnv = process.env): string {
  const configured = environment.COMMANDO_NOTES_PATH
  if (configured !== undefined && !isAbsolute(configured)) {
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
    return (await this.snapshot()).notes
  }

  async snapshot(): Promise<{ notes: Note[]; folders: string[] }> {
    await this.writes
    await this.ensureInitialized()
    const scanned = await this.scanVault()
    return { notes: ordered(scanned.notes.map(({ note }) => note)), folders: scanned.folders }
  }

  createFolder(value: unknown): Promise<string[]> {
    const folder = parseNoteFolder(value)
    if (folder === null || !folder) return Promise.reject(new NoteValidationError('Invalid note folder'))
    return this.enqueue(async () => {
      await this.ensureInitialized()
      const path = join(this.directory, folder)
      await mkdir(path, { recursive: true, mode: 0o700 })
      await chmod(path, 0o700)
      await this.syncDirectory(path)
      return (await this.scanVault()).folders
    })
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
        folder: update.folder ?? stored.note.folder,
        updatedAt: Math.max(Date.now(), stored.note.updatedAt + 1),
      }
      const rollbackImages = note.folder === stored.note.folder
        ? null
        : await this.moveImageDirectory(note.id, stored.note.folder, note.folder)
      try {
        await this.writeNote(note, stored.path, stored.fingerprint)
      } catch (error) {
        await rollbackImages?.()
        throw error
      }
      return { ...note }
    })
  }

  saveImage(id: string, contentType: string, data: Buffer): Promise<string> {
    try {
      this.validateId(id)
    } catch (error) {
      return Promise.reject(error)
    }
    if (!(contentType in NOTE_IMAGE_FORMATS)) {
      return Promise.reject(new NoteValidationError('Unsupported image type'))
    }
    const supportedContentType = contentType as NoteImageContentType
    if (!validImageData(data, supportedContentType)) {
      return Promise.reject(new NoteValidationError('Image data is invalid or too large'))
    }

    return this.enqueue(async () => {
      await this.ensureInitialized()
      const stored = (await this.readStoredNotes()).find(({ note }) => note.id === id)
      if (!stored) throw new NoteNotFoundError(id)

      const imageDirectory = this.imageDirectory(stored.note.folder, id)
      await mkdir(imageDirectory, { recursive: true, mode: 0o700 })
      await chmod(imageDirectory, 0o700)
      const name = `${randomUUID()}.${NOTE_IMAGE_FORMATS[supportedContentType]}`
      const path = join(imageDirectory, name)
      const temporaryPath = join(imageDirectory, `.${name}.${process.pid}.tmp`)
      let handle: Awaited<ReturnType<typeof open>> | null = null

      try {
        handle = await open(temporaryPath, 'wx', 0o600)
        await handle.writeFile(data)
        await handle.sync()
        await handle.close()
        handle = null
        await rename(temporaryPath, path)
        await chmod(path, 0o600)
        await this.syncDirectory(imageDirectory)
        await this.syncDirectory()
      } catch (error) {
        await handle?.close().catch(() => undefined)
        await rm(temporaryPath, { force: true }).catch(() => undefined)
        throw error
      }

      return `images/${id}/${name}`
    })
  }

  async getImage(id: string, name: string): Promise<NoteImage> {
    this.validateId(id)
    const contentType = imageContentType(name)
    if (!contentType) throw new NoteValidationError('Invalid image name')
    await this.writes
    await this.ensureInitialized()
    const stored = (await this.readStoredNotes()).find(({ note }) => note.id === id)
    if (!stored) throw new NoteNotFoundError(id)
    try {
      return {
        data: await readFile(join(this.imageDirectory(stored.note.folder, id), name)),
        contentType,
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new NoteNotFoundError(id)
      throw error
    }
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
      await rm(this.imageDirectory(stored.note.folder, id), { recursive: true, force: true })
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
    return (await this.scanVault()).notes
  }

  private async scanVault(): Promise<{ notes: StoredNote[]; folders: string[] }> {
    const notes: StoredNote[] = []
    const folders: string[] = []
    let visitedEntries = 0

    const visit = async (directory: string, folder: string): Promise<void> => {
      const entries = await readdir(directory, { withFileTypes: true })
      visitedEntries += entries.length
      if (visitedEntries > 10_000) throw new Error('Note vault contains too many entries')

      for (const entry of entries) {
        if (entry.isDirectory()) {
          if (entry.name === 'images' || entry.name.startsWith('.')) continue
          const childFolder = folder ? `${folder}/${entry.name}` : entry.name
          if (parseNoteFolder(childFolder) === null) continue
          folders.push(childFolder)
          await visit(join(directory, entry.name), childFolder)
          continue
        }
        if (!entry.isFile() || !isMarkdownNoteFile(entry.name)) continue
        const path = join(directory, entry.name)
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
        const parsed = parseNote({ ...(value as Record<string, unknown>), folder })
        if (!parsed) throw new Error(`Markdown note has invalid Commando metadata: ${entry.name}`)
        parsed.updatedAt = Math.max(parsed.updatedAt, Math.round(fingerprint.modifiedAt))
        notes.push({ note: parsed, path, fingerprint })
      }
    }

    await visit(this.directory, '')

    const ids = notes.map(({ note }) => note.id)
    if (new Set(ids).size !== ids.length) throw new Error('Markdown notes contain duplicate note ids')
    return { notes, folders: folders.sort((left, right) => left.localeCompare(right)) }
  }

  private async writeNote(
    note: Note,
    previousPath?: string,
    expectedFingerprint?: FileFingerprint,
  ): Promise<void> {
    const folderDirectory = join(this.directory, note.folder)
    await mkdir(folderDirectory, { recursive: true, mode: 0o700 })
    const path = join(folderDirectory, noteFileName(note))
    const temporaryPath = join(folderDirectory, `.${note.id}.${process.pid}.${randomUUID()}.tmp`)
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
      await this.syncDirectory(folderDirectory)
    } catch (error) {
      await handle?.close().catch(() => undefined)
      await rm(temporaryPath, { force: true }).catch(() => undefined)
      throw error
    }
  }

  private imageDirectory(folder: string, id: string): string {
    return join(this.directory, folder, 'images', id)
  }

  private async moveImageDirectory(
    id: string,
    fromFolder: string,
    toFolder: string,
  ): Promise<(() => Promise<void>) | null> {
    const source = this.imageDirectory(fromFolder, id)
    const target = this.imageDirectory(toFolder, id)
    try {
      await stat(source)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
    await mkdir(join(this.directory, toFolder, 'images'), { recursive: true, mode: 0o700 })
    try {
      await stat(target)
      throw new NoteConflictError()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    await rename(source, target)
    return async () => {
      await mkdir(join(this.directory, fromFolder, 'images'), { recursive: true, mode: 0o700 })
      await rename(target, source)
    }
  }

  private async syncDirectory(directory = this.directory): Promise<void> {
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
