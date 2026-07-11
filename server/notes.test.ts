import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { handleNotesApi } from './notes-api.js'
import {
  MAX_NOTE_BODY_LENGTH,
  NoteNotFoundError,
  NoteStore,
  NoteValidationError,
  parseNoteDraft,
  parseNotesFile,
} from './notes.js'

const temporaryDirectories: string[] = []
const servers: Server[] = []

async function temporaryNotesPath(): Promise<{ directory: string; path: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'commando-notes-test-'))
  temporaryDirectories.push(directory)
  return { directory, path: join(directory, 'private', 'notes.json') }
}

async function startApi(store: NoteStore): Promise<string> {
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      if (!(await handleNotesApi(request, response, url, store))) {
        response.writeHead(404).end()
      }
    })()
  })
  servers.push(server)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address() as AddressInfo
  return `http://127.0.0.1:${address.port}`
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) => new Promise<void>((resolve) => server.close(() => resolve())),
    ),
  )
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  )
})

describe('note validation', () => {
  it('accepts bounded text and rejects malformed persisted notes', () => {
    expect(parseNoteDraft({ title: 'Plan', body: 'Ship it' })).toEqual({
      title: 'Plan',
      body: 'Ship it',
    })
    expect(parseNoteDraft({ title: 'bad\u0000title', body: '' })).toBeNull()
    expect(parseNoteDraft({ title: '', body: 'x'.repeat(MAX_NOTE_BODY_LENGTH + 1) })).toBeNull()
    expect(() => parseNotesFile({ version: 2, notes: [] })).toThrow('invalid structure')
    expect(() =>
      parseNotesFile({
        version: 1,
        notes: [{ id: 'not-an-id', title: '', body: '', createdAt: 1, updatedAt: 1 }],
      }),
    ).toThrow('invalid note')
  })
})

describe('NoteStore', () => {
  it('persists CRUD operations with deterministic ordering and private modes', async () => {
    const { path } = await temporaryNotesPath()
    const store = new NoteStore(path)
    const first = await store.create({ title: 'First', body: 'one' })
    const second = await store.create({ title: 'Second', body: 'two' })

    await expect(store.list()).resolves.toEqual([second, first])
    const updated = await store.update(first.id, { title: 'First revised', body: 'three' })
    await expect(store.list()).resolves.toEqual([updated, second])
    await expect(new NoteStore(path).get(first.id)).resolves.toEqual(updated)

    const file = JSON.parse(await readFile(path, 'utf8')) as { notes: Array<{ id: string }> }
    expect(file.notes.map((note) => note.id)).toEqual([updated.id, second.id])
    expect((await stat(join(path, '..'))).mode & 0o777).toBe(0o700)
    expect((await stat(path)).mode & 0o777).toBe(0o600)

    await store.delete(first.id)
    await expect(store.list()).resolves.toEqual([second])
  })

  it('serializes concurrent mutations without losing notes or temp files', async () => {
    const { path } = await temporaryNotesPath()
    const store = new NoteStore(path)
    const created = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        store.create({ title: `Note ${index}`, body: `${index}` }),
      ),
    )
    await Promise.all(
      created.map((note, index) =>
        store.update(note.id, { title: note.title, body: `updated ${index}` }),
      ),
    )

    const notes = await store.list()
    expect(notes).toHaveLength(12)
    expect(notes.every((note) => note.body.startsWith('updated '))).toBe(true)
    await expect(readdir(join(path, '..'))).resolves.toEqual(['notes.json'])
  })

  it('reports validation and not-found errors without altering persistence', async () => {
    const { path } = await temporaryNotesPath()
    const store = new NoteStore(path)
    const note = await store.create({ title: 'Keep', body: 'safe' })

    await expect(store.update(note.id, { title: 4, body: '' })).rejects.toBeInstanceOf(
      NoteValidationError,
    )
    await expect(store.get('invalid')).rejects.toBeInstanceOf(NoteValidationError)
    await store.delete(note.id)
    await expect(store.get(note.id)).rejects.toBeInstanceOf(NoteNotFoundError)
    await expect(store.delete(note.id)).rejects.toBeInstanceOf(NoteNotFoundError)
    await expect(store.list()).resolves.toEqual([])
  })

  it('does not overwrite corrupt JSON', async () => {
    const { path } = await temporaryNotesPath()
    const store = new NoteStore(path)
    await store.create({ title: 'One', body: '' })
    await writeFile(path, '{not-json', 'utf8')

    await expect(store.create({ title: 'Two', body: '' })).rejects.toThrow('invalid JSON')
    await expect(readFile(path, 'utf8')).resolves.toBe('{not-json')
  })
})

describe('handleNotesApi', () => {
  it('serves CRUD, validation, method, and not-found responses after auth dispatch', async () => {
    const { path } = await temporaryNotesPath()
    const baseUrl = await startApi(new NoteStore(path))

    const createdResponse = await fetch(`${baseUrl}/api/notes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'API note', body: 'body' }),
    })
    expect(createdResponse.status).toBe(201)
    const created = (await createdResponse.json()) as { note: { id: string } }

    const listResponse = await fetch(`${baseUrl}/api/notes`)
    expect(listResponse.status).toBe(200)
    expect((await listResponse.json()) as unknown).toMatchObject({
      notes: [{ id: created.note.id, title: 'API note' }],
    })

    const updatedResponse = await fetch(`${baseUrl}/api/notes/${created.note.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Updated', body: 'new body' }),
    })
    expect(updatedResponse.status).toBe(200)

    const invalidResponse = await fetch(`${baseUrl}/api/notes/${created.note.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'text/plain' },
      body: '{}',
    })
    expect(invalidResponse.status).toBe(400)

    const methodResponse = await fetch(`${baseUrl}/api/notes`, { method: 'PATCH' })
    expect(methodResponse.status).toBe(405)
    expect(methodResponse.headers.get('allow')).toBe('GET, POST')

    expect((await fetch(`${baseUrl}/api/notes/${created.note.id}`, { method: 'DELETE' })).status).toBe(204)
    expect((await fetch(`${baseUrl}/api/notes/${created.note.id}`)).status).toBe(404)
  })
})
