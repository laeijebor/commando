import type { IncomingMessage, ServerResponse } from 'node:http'
import { NoteValidationError } from './notes.js'
import { NoteVaultManager } from './note-vaults.js'

const VAULTS_PATH = '/api/note-vaults'
const MAX_REQUEST_BYTES = 16 * 1024

function writeJson(response: ServerResponse, status: number, value: unknown): void {
  const body = `${JSON.stringify(value)}\n`
  response.writeHead(status, {
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
    'Content-Type': 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
  })
  response.end(body)
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  if (request.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
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
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  } catch {
    throw new NoteValidationError('Request body contains invalid JSON')
  }
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new NoteValidationError()
  return value as Record<string, unknown>
}

export async function handleNoteVaultsApi(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  manager: NoteVaultManager,
): Promise<boolean> {
  if (url.pathname !== VAULTS_PATH && !url.pathname.startsWith(`${VAULTS_PATH}/`)) return false
  const action = url.pathname === VAULTS_PATH ? '' : url.pathname.slice(VAULTS_PATH.length + 1)

  try {
    if (!action && request.method === 'GET') {
      writeJson(response, 200, await manager.snapshot())
      return true
    }
    if (action === 'open' && request.method === 'POST') {
      writeJson(response, 200, await manager.open(record(await readJson(request)).path))
      return true
    }
    if (action === 'create' && request.method === 'POST') {
      writeJson(response, 201, await manager.create(record(await readJson(request)).path))
      return true
    }
    if (action === 'active' && request.method === 'PUT') {
      writeJson(response, 200, await manager.select(record(await readJson(request)).id))
      return true
    }
    if (action === 'history' && request.method === 'DELETE') {
      writeJson(response, 200, await manager.clearHistory(url.searchParams.get('active')))
      return true
    }
    response.setHeader('Allow', action === 'history' ? 'DELETE' : action ? action === 'active' ? 'PUT' : 'POST' : 'GET')
    writeJson(response, 405, { error: 'Method not allowed' })
    return true
  } catch (error) {
    if (error instanceof NoteValidationError) {
      writeJson(response, 400, { error: error.message })
      return true
    }
    throw error
  }
}
