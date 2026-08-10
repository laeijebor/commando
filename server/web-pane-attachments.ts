import { randomUUID } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { basename, join } from 'node:path'
import { defaultFeedbackJournalDir } from './web-pane-feedback-journal.js'

export const MAX_WEB_PANE_ATTACHMENT_SIZE = 10 * 1024 * 1024

export type WebPaneAttachmentMetadata = {
  id: string
  name: string
  contentType: string
  size: number
}

export type WebPaneAttachmentInput = {
  name?: string
  contentType: string
  data: Uint8Array
}

export type StoredWebPaneAttachment = {
  metadata: WebPaneAttachmentMetadata
  data: Buffer
}

export type WebPaneAttachmentStoreOptions = {
  dir?: string
}

/** Error statuses intentionally match the WebPaneError HTTP status convention. */
export class WebPaneAttachmentError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
    this.name = 'WebPaneAttachmentError'
  }
}

type ImageFormat = {
  contentType: string
  extension: 'png' | 'jpg' | 'gif' | 'webp'
  matches: (data: Uint8Array) => boolean
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const FORMATS: readonly ImageFormat[] = [
  {
    contentType: 'image/png',
    extension: 'png',
    matches: (data) => startsWith(data, PNG_SIGNATURE),
  },
  {
    contentType: 'image/jpeg',
    extension: 'jpg',
    matches: (data) => startsWith(data, [0xff, 0xd8, 0xff]),
  },
  {
    contentType: 'image/gif',
    extension: 'gif',
    matches: (data) => startsWithAscii(data, 'GIF87a') || startsWithAscii(data, 'GIF89a'),
  },
  {
    contentType: 'image/webp',
    extension: 'webp',
    matches: (data) => startsWithAscii(data, 'RIFF') && asciiAt(data, 8, 'WEBP'),
  },
]

const ATTACHMENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(png|jpg|gif|webp)$/
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/g
const METADATA_FILE = 'metadata.json'
const CONTENT_FILE = 'content'
const MAX_METADATA_SIZE = 4 * 1024

/**
 * Private, durable storage for images attached to queued redline feedback.
 * A complete attachment appears with one atomic directory rename.
 */
export class WebPaneAttachmentStore {
  readonly dir: string

  constructor(options: WebPaneAttachmentStoreOptions = {}) {
    this.dir = options.dir ?? join(defaultFeedbackJournalDir(), 'attachments')
  }

  save(input: WebPaneAttachmentInput): WebPaneAttachmentMetadata {
    if (typeof input !== 'object' || input === null || !(input.data instanceof Uint8Array)) {
      throw new WebPaneAttachmentError(400, 'Attachment data must be binary')
    }
    if (input.data.byteLength === 0) {
      throw new WebPaneAttachmentError(400, 'Attachment data cannot be empty')
    }
    if (input.data.byteLength > MAX_WEB_PANE_ATTACHMENT_SIZE) {
      throw new WebPaneAttachmentError(413, `Attachment exceeds the ${MAX_WEB_PANE_ATTACHMENT_SIZE} byte limit`)
    }

    const contentType = typeof input.contentType === 'string' ? input.contentType.trim().toLowerCase() : ''
    const format = FORMATS.find((candidate) => candidate.contentType === contentType)
    if (!format) {
      throw new WebPaneAttachmentError(415, 'Attachment must be a PNG, JPEG, GIF, or WebP image')
    }
    if (!format.matches(input.data)) {
      throw new WebPaneAttachmentError(415, `Attachment bytes do not match ${format.contentType}`)
    }

    this.ensureDirectory()
    const id = `${randomUUID()}.${format.extension}`
    const metadata: WebPaneAttachmentMetadata = {
      id,
      name: sanitizeDisplayName(input.name, format.extension),
      contentType: format.contentType,
      size: input.data.byteLength,
    }
    const temporaryPath = join(this.dir, `.tmp-${randomUUID()}`)
    const finalPath = join(this.dir, id)

    try {
      mkdirSync(temporaryPath, { mode: 0o700 })
      writeFileSync(join(temporaryPath, CONTENT_FILE), input.data, { flag: 'wx', mode: 0o600 })
      writeFileSync(join(temporaryPath, METADATA_FILE), `${JSON.stringify(metadata)}\n`, { flag: 'wx', mode: 0o600 })
      renameSync(temporaryPath, finalPath)
      return metadata
    } catch (error) {
      rmSync(temporaryPath, { recursive: true, force: true })
      throw storageFailure('Unable to save attachment', error)
    }
  }

  read(id: string): StoredWebPaneAttachment {
    const format = formatForId(id)
    this.ensureDirectory()
    const attachmentPath = join(this.dir, id)

    let entry
    try {
      entry = lstatSync(attachmentPath)
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) throw new WebPaneAttachmentError(404, 'Attachment does not exist')
      throw storageFailure('Unable to read attachment', error)
    }
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new WebPaneAttachmentError(500, 'Stored attachment is corrupt')
    }

    try {
      const metadata = parseMetadata(readRegularFile(join(attachmentPath, METADATA_FILE), MAX_METADATA_SIZE), id, format)
      const data = readRegularFile(join(attachmentPath, CONTENT_FILE), MAX_WEB_PANE_ATTACHMENT_SIZE)
      if (data.byteLength !== metadata.size || !format.matches(data)) {
        throw new WebPaneAttachmentError(500, 'Stored attachment is corrupt')
      }
      return { metadata, data }
    } catch (error) {
      if (error instanceof WebPaneAttachmentError) throw error
      throw storageFailure('Stored attachment is corrupt', error)
    }
  }

  remove(id: string): boolean {
    assertSafeId(id)
    this.ensureDirectory()
    const path = join(this.dir, id)
    try {
      lstatSync(path)
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) return false
      throw storageFailure('Unable to remove attachment', error)
    }
    try {
      rmSync(path, { recursive: true, force: true })
      return true
    } catch (error) {
      throw storageFailure('Unable to remove attachment', error)
    }
  }

  removeMany(ids: Iterable<string>): number {
    const uniqueIds = [...new Set(ids)]
    for (const id of uniqueIds) assertSafeId(id)
    let removed = 0
    for (const id of uniqueIds) {
      if (this.remove(id)) removed++
    }
    return removed
  }

  listIds(): string[] {
    this.ensureDirectory()
    try {
      return readdirSync(this.dir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && ATTACHMENT_ID.test(entry.name))
        .map((entry) => entry.name)
        .sort()
    } catch (error) {
      throw storageFailure('Unable to list attachments', error)
    }
  }

  /** Removes every store entry not named by the supplied attachment IDs. */
  cleanup(referencedIds: Iterable<string>): number {
    const referenced = new Set(referencedIds)
    for (const id of referenced) assertSafeId(id)
    this.ensureDirectory()

    let removed = 0
    try {
      for (const entry of readdirSync(this.dir, { withFileTypes: true })) {
        if (referenced.has(entry.name)) continue
        rmSync(join(this.dir, entry.name), { recursive: true, force: true })
        removed++
      }
      return removed
    } catch (error) {
      throw storageFailure('Unable to clean up attachments', error)
    }
  }

  private ensureDirectory(): void {
    try {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 })
      const entry = lstatSync(this.dir)
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        throw new WebPaneAttachmentError(500, 'Attachment store path is not a private directory')
      }
      chmodSync(this.dir, 0o700)
    } catch (error) {
      if (error instanceof WebPaneAttachmentError) throw error
      throw storageFailure('Unable to initialize attachment store', error)
    }
  }
}

function sanitizeDisplayName(name: unknown, extension: ImageFormat['extension']): string {
  const candidate = typeof name === 'string' ? basename(name.replaceAll('\\', '/')).replace(CONTROL_CHARACTERS, '').trim() : ''
  if (candidate === '' || candidate === '.' || candidate === '..') return `image.${extension}`
  return [...candidate].slice(0, 255).join('') || `image.${extension}`
}

function assertSafeId(id: unknown): asserts id is string {
  if (typeof id !== 'string' || !ATTACHMENT_ID.test(id)) {
    throw new WebPaneAttachmentError(400, 'Malformed attachment id')
  }
}

function formatForId(id: unknown): ImageFormat {
  assertSafeId(id)
  const extension = id.slice(id.lastIndexOf('.') + 1)
  const format = FORMATS.find((candidate) => candidate.extension === extension)
  if (!format) throw new WebPaneAttachmentError(400, 'Malformed attachment id')
  return format
}

function parseMetadata(raw: Buffer, id: string, format: ImageFormat): WebPaneAttachmentMetadata {
  let value: unknown
  try {
    value = JSON.parse(raw.toString('utf8'))
  } catch {
    throw new WebPaneAttachmentError(500, 'Stored attachment is corrupt')
  }
  if (typeof value !== 'object' || value === null) throw new WebPaneAttachmentError(500, 'Stored attachment is corrupt')
  const metadata = value as Partial<WebPaneAttachmentMetadata>
  if (
    metadata.id !== id ||
    metadata.contentType !== format.contentType ||
    typeof metadata.name !== 'string' ||
    sanitizeDisplayName(metadata.name, format.extension) !== metadata.name ||
    !Number.isSafeInteger(metadata.size) ||
    (metadata.size ?? 0) <= 0 ||
    (metadata.size ?? 0) > MAX_WEB_PANE_ATTACHMENT_SIZE
  ) {
    throw new WebPaneAttachmentError(500, 'Stored attachment is corrupt')
  }
  return metadata as WebPaneAttachmentMetadata
}

function readRegularFile(path: string, maxSize: number): Buffer {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stats = fstatSync(descriptor)
    if (!stats.isFile() || stats.size <= 0 || stats.size > maxSize) {
      throw new WebPaneAttachmentError(500, 'Stored attachment is corrupt')
    }
    return readFileSync(descriptor)
  } finally {
    closeSync(descriptor)
  }
}

function startsWith(data: Uint8Array, signature: readonly number[]): boolean {
  return signature.length <= data.byteLength && signature.every((byte, index) => data[index] === byte)
}

function startsWithAscii(data: Uint8Array, value: string): boolean {
  return asciiAt(data, 0, value)
}

function asciiAt(data: Uint8Array, offset: number, value: string): boolean {
  if (offset + value.length > data.byteLength) return false
  for (let index = 0; index < value.length; index++) {
    if (data[offset + index] !== value.charCodeAt(index)) return false
  }
  return true
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code
}

function storageFailure(message: string, error: unknown): WebPaneAttachmentError {
  if (error instanceof WebPaneAttachmentError) return error
  return new WebPaneAttachmentError(500, message)
}
