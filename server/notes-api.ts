import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  NoteConflictError,
  MAX_NOTE_IMAGE_BYTES,
  NoteNotFoundError,
  NoteStore,
  NoteValidationError,
} from './notes.js'
import { NoteVaultManager } from './note-vaults.js'

const MAX_REQUEST_BYTES = 600 * 1024
const NOTES_PATH = '/api/notes'

type NotesRoute =
  | { kind: 'collection' }
  | { kind: 'batch' }
  | { kind: 'folders' }
  | { kind: 'note'; id: string }
  | { kind: 'images'; id: string; name: string | null }

function writeJson(response: ServerResponse, status: number, value: unknown): void {
  const body = `${JSON.stringify(value)}\n`
  response.writeHead(status, {
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
    'Content-Type': 'application/json; charset=utf-8',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
  })
  response.end(body)
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const contentType = request.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase()
  if (contentType !== 'application/json') {
    throw new NoteValidationError('Content-Type must be application/json')
  }

  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
    size += buffer.byteLength
    if (size > MAX_REQUEST_BYTES) throw new NoteValidationError('Request body is too large')
    chunks.push(buffer)
  }
  if (size === 0) throw new NoteValidationError('Request body is required')

  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  } catch {
    throw new NoteValidationError('Request body contains invalid JSON')
  }
}

async function readImage(request: IncomingMessage): Promise<{ contentType: string; data: Buffer }> {
  const contentType = request.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase()
  if (!contentType?.startsWith('image/')) throw new NoteValidationError('Content-Type must be an image')

  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
    size += buffer.byteLength
    if (size > MAX_NOTE_IMAGE_BYTES) throw new NoteValidationError('Image is too large')
    chunks.push(buffer)
  }
  if (size === 0) throw new NoteValidationError('Image body is required')
  return { contentType, data: Buffer.concat(chunks) }
}

function notesRouteFromPath(pathname: string): NotesRoute | undefined {
  if (pathname === NOTES_PATH || pathname === `${NOTES_PATH}/`) return { kind: 'collection' }
  if (!pathname.startsWith(`${NOTES_PATH}/`)) return undefined
  const segments = pathname.slice(NOTES_PATH.length + 1).split('/')
  if (segments.some((segment) => segment.length === 0)) return undefined
  try {
    const decoded = segments.map((segment) => decodeURIComponent(segment))
    if (decoded.length === 1 && decoded[0] === 'batch') return { kind: 'batch' }
    if (decoded.length === 1 && decoded[0] === 'folders') return { kind: 'folders' }
    if (decoded.length === 1) return { kind: 'note', id: decoded[0] }
    if (decoded.length === 2 && decoded[1] === 'images') {
      return { kind: 'images', id: decoded[0], name: null }
    }
    if (decoded.length === 3 && decoded[1] === 'images') {
      return { kind: 'images', id: decoded[0], name: decoded[2] }
    }
    return undefined
  } catch {
    return undefined
  }
}

function methodNotAllowed(response: ServerResponse, allowed: string): void {
  response.setHeader('Allow', allowed)
  writeJson(response, 405, { error: 'Method not allowed' })
}

function expectedUpdatedAt(request: IncomingMessage): number | undefined {
  const value = request.headers['if-match']
  if (value === undefined) return undefined
  if (Array.isArray(value)) throw new NoteValidationError('If-Match must contain one timestamp')
  const match = /^"(\d+)"$/.exec(value)
  if (!match) throw new NoteValidationError('If-Match must be a quoted update timestamp')
  const parsed = Number(match[1])
  if (!Number.isSafeInteger(parsed)) throw new NoteValidationError('If-Match timestamp is invalid')
  return parsed
}

/**
 * Handles authenticated note routes. The parent server must perform its existing
 * host, origin, and bearer-token checks before invoking this dispatcher.
 */
export async function handleNotesApi(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  source: NoteStore | NoteVaultManager,
): Promise<boolean> {
  const route = notesRouteFromPath(url.pathname)
  if (!route) return false

  try {
    const vaultId = url.searchParams.get('vault')
    if (source instanceof NoteVaultManager && !vaultId) throw new NoteValidationError('Note vault is required')
    const store = source instanceof NoteVaultManager ? await source.store(vaultId) : source
    if (route.kind === 'collection') {
      if (request.method === 'GET') {
        writeJson(response, 200, await store.snapshot())
        return true
      }
      if (request.method === 'POST') {
        writeJson(response, 201, { note: await store.create(await readJson(request)) })
        return true
      }
      methodNotAllowed(response, 'GET, POST')
      return true
    }

    if (route.kind === 'folders') {
      if (request.method === 'POST') {
        const value = await readJson(request)
        const folder = typeof value === 'object' && value !== null && !Array.isArray(value)
          ? (value as Record<string, unknown>).folder
          : undefined
        writeJson(response, 201, { folders: await store.createFolder(folder) })
        return true
      }
      if (request.method === 'PATCH') {
        const value = await readJson(request)
        const record = typeof value === 'object' && value !== null && !Array.isArray(value)
          ? value as Record<string, unknown>
          : {}
        writeJson(response, 200, await store.renameFolder(record.folder, record.name))
        return true
      }
      if (request.method === 'DELETE') {
        const value = await readJson(request)
        const folder = typeof value === 'object' && value !== null && !Array.isArray(value)
          ? (value as Record<string, unknown>).folder
          : undefined
        writeJson(response, 200, await store.deleteFolder(folder))
        return true
      }
      methodNotAllowed(response, 'POST, PATCH, DELETE')
      return true
    }

    if (route.kind === 'batch') {
      if (request.method === 'PATCH') {
        writeJson(response, 200, await store.moveMany(await readJson(request)))
        return true
      }
      if (request.method === 'DELETE') {
        writeJson(response, 200, await store.deleteMany(await readJson(request)))
        return true
      }
      methodNotAllowed(response, 'PATCH, DELETE')
      return true
    }

    if (route.kind === 'images') {
      if (route.name === null && request.method === 'POST') {
        const image = await readImage(request)
        writeJson(response, 201, { path: await store.saveImage(route.id, image.contentType, image.data) })
        return true
      }
      if (route.name !== null && request.method === 'GET') {
        const image = await store.getImage(route.id, route.name)
        response.writeHead(200, {
          'Cache-Control': 'private, max-age=31536000, immutable',
          'Content-Length': image.data.byteLength,
          'Content-Security-Policy': "default-src 'none'; sandbox",
          'Content-Type': image.contentType,
          'X-Content-Type-Options': 'nosniff',
        })
        response.end(image.data)
        return true
      }
      methodNotAllowed(response, route.name === null ? 'POST' : 'GET')
      return true
    }

    const { id } = route

    if (request.method === 'GET') {
      writeJson(response, 200, { note: await store.get(id) })
      return true
    }
    if (request.method === 'PUT') {
      writeJson(response, 200, { note: await store.update(id, await readJson(request)) })
      return true
    }
    if (request.method === 'DELETE') {
      await store.delete(id, expectedUpdatedAt(request))
      response.writeHead(204, { 'Cache-Control': 'no-store' })
      response.end()
      return true
    }
    methodNotAllowed(response, 'GET, PUT, DELETE')
    return true
  } catch (error) {
    if (error instanceof NoteConflictError) {
      writeJson(response, 409, { error: error.message })
      return true
    }
    if (error instanceof NoteNotFoundError) {
      writeJson(response, 404, { error: 'Note not found' })
      return true
    }
    if (error instanceof NoteValidationError) {
      writeJson(response, 400, { error: error.message })
      return true
    }
    throw error
  }
}
