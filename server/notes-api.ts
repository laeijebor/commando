import type { IncomingMessage, ServerResponse } from 'node:http'
import { NoteNotFoundError, NoteStore, NoteValidationError } from './notes.js'

const MAX_REQUEST_BYTES = 600 * 1024
const NOTES_PATH = '/api/notes'

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

function noteIdFromPath(pathname: string): string | null | undefined {
  if (pathname === NOTES_PATH || pathname === `${NOTES_PATH}/`) return null
  if (!pathname.startsWith(`${NOTES_PATH}/`)) return undefined
  const segment = pathname.slice(NOTES_PATH.length + 1)
  if (segment.length === 0 || segment.includes('/')) return undefined
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}

function methodNotAllowed(response: ServerResponse, allowed: string): void {
  response.setHeader('Allow', allowed)
  writeJson(response, 405, { error: 'Method not allowed' })
}

/**
 * Handles authenticated note routes. The parent server must perform its existing
 * host, origin, and bearer-token checks before invoking this dispatcher.
 */
export async function handleNotesApi(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  store: NoteStore,
): Promise<boolean> {
  const id = noteIdFromPath(url.pathname)
  if (id === undefined) return false

  try {
    if (id === null) {
      if (request.method === 'GET') {
        writeJson(response, 200, { notes: await store.list() })
        return true
      }
      if (request.method === 'POST') {
        writeJson(response, 201, { note: await store.create(await readJson(request)) })
        return true
      }
      methodNotAllowed(response, 'GET, POST')
      return true
    }

    if (request.method === 'GET') {
      writeJson(response, 200, { note: await store.get(id) })
      return true
    }
    if (request.method === 'PUT') {
      writeJson(response, 200, { note: await store.update(id, await readJson(request)) })
      return true
    }
    if (request.method === 'DELETE') {
      await store.delete(id)
      response.writeHead(204, { 'Cache-Control': 'no-store' })
      response.end()
      return true
    }
    methodNotAllowed(response, 'GET, PUT, DELETE')
    return true
  } catch (error) {
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
