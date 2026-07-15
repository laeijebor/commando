import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { handleNotesApi } from './notes-api.js'
import { noteFileName, parseNoteMarkdown, serializeNoteMarkdown } from './note-markdown.js'
import {
  defaultLegacyNotesPath,
  defaultNotesDirectory,
  MAX_NOTE_BODY_LENGTH,
  MAX_NOTE_IMAGE_BYTES,
  NoteConflictError,
  NoteNotFoundError,
  NoteStore,
  NoteValidationError,
  parseNoteDraft,
  parseNoteFolder,
  parseNotesFile,
  type Note,
} from './notes.js'

const temporaryDirectories: string[] = []
const servers: Server[] = []

async function temporaryNotesStore(): Promise<{
  root: string
  directory: string
  legacyPath: string
  store: NoteStore
}> {
  const root = await mkdtemp(join(tmpdir(), 'commando-notes-test-'))
  temporaryDirectories.push(root)
  const directory = join(root, 'vault', 'Commando')
  const legacyPath = join(root, 'private', 'notes.json')
  return {
    root,
    directory,
    legacyPath,
    store: new NoteStore({ directory, legacyPath }),
  }
}

async function markdownFiles(directory: string): Promise<string[]> {
  return (await readdir(directory)).filter((name) => name.endsWith('.md')).sort()
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

describe('note validation and Markdown codec', () => {
  it('validates bounded drafts and configuration paths', () => {
    expect(parseNoteDraft({ title: 'Plan', body: 'Ship it' })).toEqual({
      title: 'Plan',
      body: 'Ship it',
      folder: '',
    })
    expect(parseNoteDraft({ title: 'bad\u0000title', body: '' })).toBeNull()
    expect(parseNoteFolder('Projects/Images')).toBeNull()
    expect(parseNoteDraft({ title: '', body: 'x'.repeat(MAX_NOTE_BODY_LENGTH + 1) })).toBeNull()
    expect(() => parseNotesFile({ version: 2, notes: [] })).toThrow('invalid structure')
    expect(() => defaultNotesDirectory({ COMMANDO_NOTES_DIR: 'relative' })).toThrow('absolute')
    expect(() => defaultLegacyNotesPath({ COMMANDO_NOTES_PATH: 'relative' })).toThrow('absolute')
  })

  it('round-trips Commando frontmatter without claiming unrelated Markdown', () => {
    const note = {
      id: 'a30fa1a4-6f1c-41d9-890f-c93cb9c218ba',
      title: 'Plan: ship safely',
      body: '# Heading\n\n- [ ] Verify **Markdown**',
      createdAt: Date.parse('2026-07-11T10:00:00.000Z'),
      updatedAt: Date.parse('2026-07-11T11:00:00.000Z'),
    }

    expect(parseNoteMarkdown(serializeNoteMarkdown(note))).toEqual(note)
    expect(parseNoteMarkdown('# Existing Obsidian note')).toBeNull()
  })
})

describe('NoteStore', () => {
  it('persists one Markdown file per note with deterministic ordering and private modes', async () => {
    const { directory, legacyPath, store } = await temporaryNotesStore()
    const first = await store.create({ title: 'First plan', body: 'one' })
    const second = await store.create({ title: 'Second', body: 'two' })

    await expect(store.list()).resolves.toEqual([second, first])
    const updated = await store.update(first.id, {
      title: 'First revised',
      body: '## Three',
      expectedUpdatedAt: first.updatedAt,
    })
    await expect(store.list()).resolves.toEqual([updated, second])
    await expect(new NoteStore({ directory, legacyPath }).get(first.id)).resolves.toEqual(updated)

    const files = await markdownFiles(directory)
    expect(files).toHaveLength(2)
    expect(files.some((name) => name.startsWith('first-revised--'))).toBe(true)
    expect(files.some((name) => name.startsWith('first-plan--'))).toBe(false)
    expect(await readFile(join(directory, files.find((name) => name.startsWith('first-revised--'))!), 'utf8'))
      .toContain('commando_id:')
    expect((await stat(directory)).mode & 0o777).toBe(0o700)
    expect((await stat(join(directory, files[0]))).mode & 0o777).toBe(0o600)

    await store.delete(first.id)
    await expect(store.list()).resolves.toEqual([second])
  })

  it('ignores unrelated vault files and observes external Markdown edits', async () => {
    const { directory, store } = await temporaryNotesStore()
    const note = await store.create({ title: 'Shared', body: 'Commando body' })
    await writeFile(join(directory, 'personal.md'), '# Personal Obsidian note\n', 'utf8')
    await writeFile(join(directory, 'broken-personal.md'), '---\nnot_yaml: [\n---\nStill unrelated\n', 'utf8')
    const path = (await markdownFiles(directory)).find((name) => name.includes(note.id))!
    const notePath = join(directory, path)
    const content = await readFile(notePath, 'utf8')
    await writeFile(notePath, content.replace('Commando body', 'Edited in Obsidian'), 'utf8')
    await utimes(notePath, new Date(), new Date(note.updatedAt + 5_000))

    const external = await store.get(note.id)
    expect(external.body).toBe('Edited in Obsidian')
    expect(external.updatedAt).toBe(note.updatedAt + 5_000)
    await expect(store.update(note.id, {
      title: note.title,
      body: 'Stale browser edit',
      expectedUpdatedAt: note.updatedAt,
    })).rejects.toBeInstanceOf(NoteConflictError)
    await expect(store.list()).resolves.toHaveLength(1)
  })

  it('creates folders, scans nested notes, and moves notes with their images', async () => {
    const { directory, store } = await temporaryNotesStore()
    await store.createFolder('Projects/Commando')
    await store.createFolder('Archive')
    const note = await store.create({ title: 'Nested', body: 'With image', folder: 'Projects/Commando' })
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01])
    const imagePath = await store.saveImage(note.id, 'image/png', png)
    const imageName = imagePath.split('/').at(-1)!

    expect(await store.snapshot()).toMatchObject({
      notes: [{ id: note.id, folder: 'Projects/Commando' }],
      folders: ['Archive', 'Projects', 'Projects/Commando'],
    })
    expect((await stat(join(directory, 'Projects', 'Commando', imagePath))).isFile()).toBe(true)

    const moved = await store.update(note.id, {
      title: note.title,
      body: note.body,
      folder: 'Archive',
      expectedUpdatedAt: note.updatedAt,
    })
    expect(moved.folder).toBe('Archive')
    expect((await stat(join(directory, 'Archive', 'images', note.id, imageName))).isFile()).toBe(true)
    await expect(store.getImage(note.id, imageName)).resolves.toEqual({ data: png, contentType: 'image/png' })
    await expect(store.createFolder('../outside')).rejects.toBeInstanceOf(NoteValidationError)
  })

  it('batch moves and deletes notes while reporting per-note conflicts', async () => {
    const { store } = await temporaryNotesStore()
    await store.createFolder('Archive')
    const first = await store.create({ title: 'First', body: '', folder: '' })
    const second = await store.create({ title: 'Second', body: '', folder: '' })

    const moved = await store.moveMany({
      folder: 'Archive',
      notes: [
        { id: first.id, expectedUpdatedAt: first.updatedAt },
        { id: second.id, expectedUpdatedAt: second.updatedAt - 1 },
      ],
    })
    expect(moved.notes.find((note) => note.id === first.id)?.folder).toBe('Archive')
    expect(moved.notes.find((note) => note.id === second.id)?.folder).toBe('')
    expect(moved.failures).toEqual([{ id: second.id, error: 'Note changed outside Commando' }])

    const deleted = await store.deleteMany({
      notes: moved.notes.map((note) => ({ id: note.id, expectedUpdatedAt: note.updatedAt })),
    })
    expect(deleted).toMatchObject({ notes: [], failures: [] })
    await expect(store.moveMany({ folder: '', notes: [] })).rejects.toThrow('Invalid batch move')
  })

  it('renames folders and removes a folder by moving managed contents to its parent', async () => {
    const { directory, store } = await temporaryNotesStore()
    await store.createFolder('Projects/Commando')
    const note = await store.create({ title: 'Nested', body: 'Keep me', folder: 'Projects/Commando' })
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01])
    const imagePath = await store.saveImage(note.id, 'image/png', png)

    const renamed = await store.renameFolder('Projects', 'Work')
    expect(renamed.notes).toEqual([expect.objectContaining({ id: note.id, folder: 'Work/Commando' })])
    expect(renamed.folders).toEqual(['Work', 'Work/Commando'])
    expect((await stat(join(directory, 'Work', 'Commando', imagePath))).isFile()).toBe(true)

    const deleted = await store.deleteFolder('Work')
    expect(deleted.notes).toEqual([expect.objectContaining({ id: note.id, folder: 'Commando' })])
    expect(deleted.folders).toEqual(['Commando'])
    expect((await stat(join(directory, 'Commando', imagePath))).isFile()).toBe(true)
    await expect(stat(join(directory, 'Work'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('refuses folder deletion when unmanaged files or destination collisions would be affected', async () => {
    const { directory, store } = await temporaryNotesStore()
    await store.createFolder('Inbox')
    const note = await store.create({ title: 'Keep', body: '', folder: 'Inbox' })
    await writeFile(join(directory, 'Inbox', 'README.txt'), 'external file', 'utf8')

    await expect(store.deleteFolder('Inbox')).rejects.toThrow('does not manage')
    await expect(store.get(note.id)).resolves.toMatchObject({ folder: 'Inbox' })
    await rm(join(directory, 'Inbox', 'README.txt'))
    await writeFile(join(directory, noteFileName({ id: note.id, title: note.title })), 'collision', 'utf8')
    await expect(store.deleteFolder('Inbox')).rejects.toThrow('already exists')
    await expect(store.renameFolder('Inbox', '../outside')).rejects.toBeInstanceOf(NoteValidationError)
  })

  it('stores validated images privately beside the vault and removes them with their note', async () => {
    const { directory, store } = await temporaryNotesStore()
    const note = await store.create({ title: 'With image', body: '' })
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01])

    const imagePath = await store.saveImage(note.id, 'image/png', png)
    const imageName = imagePath.split('/').at(-1)!
    expect(imagePath).toMatch(new RegExp(`^images/${note.id}/[0-9a-f-]+\\.png$`))
    await expect(store.getImage(note.id, imageName)).resolves.toEqual({ data: png, contentType: 'image/png' })
    expect((await stat(join(directory, imagePath))).mode & 0o777).toBe(0o600)
    await expect(store.saveImage(note.id, 'image/svg+xml', Buffer.from('<svg/>'))).rejects.toThrow('Unsupported image type')
    await expect(store.saveImage(note.id, 'image/png', Buffer.alloc(MAX_NOTE_IMAGE_BYTES + 1))).rejects.toThrow('invalid or too large')

    await store.delete(note.id)
    await expect(store.getImage(note.id, imageName)).rejects.toBeInstanceOf(NoteNotFoundError)
  })

  it('migrates legacy JSON once while preserving metadata and the source backup', async () => {
    const { directory, legacyPath, store } = await temporaryNotesStore()
    const note: Omit<Note, 'folder'> = {
      id: 'c362643b-b6f8-447f-9f58-224cc0d4973b',
      title: 'Legacy note',
      body: 'Preserve me',
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_100_000,
    }
    await mkdir(join(legacyPath, '..'), { recursive: true })
    await writeFile(legacyPath, `${JSON.stringify({ version: 1, notes: [note] })}\n`, 'utf8')

    await expect(store.list()).resolves.toEqual([{ ...note, folder: '' }])
    await expect(readFile(`${legacyPath}.migrated`, 'utf8')).resolves.toContain('Legacy note')
    expect(await markdownFiles(directory)).toHaveLength(1)

    await store.delete(note.id)
    await expect(new NoteStore({ directory, legacyPath }).list()).resolves.toEqual([])
  })

  it('serializes concurrent mutations without losing notes or temporary files', async () => {
    const { directory, store } = await temporaryNotesStore()
    const created = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        store.create({ title: `Note ${index}`, body: `${index}` }),
      ),
    )
    await Promise.all(
      created.map((note, index) =>
        store.update(note.id, {
          title: note.title,
          body: `updated ${index}`,
          expectedUpdatedAt: note.updatedAt,
        }),
      ),
    )

    const notes = await store.list()
    expect(notes).toHaveLength(12)
    expect(notes.every((note) => note.body.startsWith('updated '))).toBe(true)
    expect((await readdir(directory)).every((name) => name.endsWith('.md'))).toBe(true)
  })

  it('reports validation, not-found, and corrupt managed-note errors without overwriting files', async () => {
    const { directory, store } = await temporaryNotesStore()
    const note = await store.create({ title: 'Keep', body: 'safe' })

    await expect(store.update(note.id, { title: 4, body: '' })).rejects.toBeInstanceOf(
      NoteValidationError,
    )
    await expect(store.get('invalid')).rejects.toBeInstanceOf(NoteValidationError)
    await store.delete(note.id)
    await expect(store.get(note.id)).rejects.toBeInstanceOf(NoteNotFoundError)

    const corrupt = join(directory, 'corrupt.md')
    await writeFile(corrupt, '---\ncommando_id: invalid\ntitle: Broken\ncreated: nope\nupdated: nope\n---\nbody', 'utf8')
    await expect(store.list()).rejects.toThrow('invalid Commando metadata')
    await expect(store.create({ title: 'Two', body: '' })).resolves.toMatchObject({ title: 'Two' })
    await expect(readFile(corrupt, 'utf8')).resolves.toContain('commando_id: invalid')
  })

  it('never overwrites an unrelated destination when moving a note', async () => {
    const { directory, store } = await temporaryNotesStore()
    const note = await store.create({ title: 'Source', body: 'managed' })
    await store.createFolder('Archive')
    const destination = join(directory, 'Archive', noteFileName({ id: note.id, title: 'Collision' }))
    await writeFile(destination, '# Unrelated\n', 'utf8')

    await expect(store.update(note.id, {
      title: 'Collision',
      body: note.body,
      folder: 'Archive',
      expectedUpdatedAt: note.updatedAt,
    })).rejects.toBeInstanceOf(NoteConflictError)
    await expect(readFile(destination, 'utf8')).resolves.toBe('# Unrelated\n')
    await expect(store.get(note.id)).resolves.toMatchObject({ title: 'Source', folder: '' })
  })
})

describe('handleNotesApi', () => {
  it('serves batch move and delete operations', async () => {
    const { store } = await temporaryNotesStore()
    const baseUrl = await startApi(store)
    const note = await store.create({ title: 'Batch note', body: '', folder: '' })
    const request = (method: string, body: object) => fetch(`${baseUrl}/api/notes/batch`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })

    const moved = await request('PATCH', {
      folder: 'Archive',
      notes: [{ id: note.id, expectedUpdatedAt: note.updatedAt }],
    })
    expect(moved.status).toBe(200)
    const moveResult = await moved.json() as { notes: Note[]; failures: unknown[] }
    expect(moveResult).toMatchObject({ notes: [{ id: note.id, folder: 'Archive' }], failures: [] })

    const deleted = await request('DELETE', {
      notes: [{ id: note.id, expectedUpdatedAt: moveResult.notes[0].updatedAt }],
    })
    expect(deleted.status).toBe(200)
    expect(await deleted.json()).toMatchObject({ notes: [], failures: [] })
    const method = await fetch(`${baseUrl}/api/notes/batch`, { method: 'POST' })
    expect(method.status).toBe(405)
    expect(method.headers.get('Allow')).toBe('PATCH, DELETE')
  })

  it('serves folder create, rename, and delete operations', async () => {
    const { store } = await temporaryNotesStore()
    const baseUrl = await startApi(store)
    const request = (method: string, body: object) => fetch(`${baseUrl}/api/notes/folders`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })

    expect((await request('POST', { folder: 'Inbox' })).status).toBe(201)
    const renamed = await request('PATCH', { folder: 'Inbox', name: 'Archive' })
    expect(renamed.status).toBe(200)
    expect(await renamed.json()).toMatchObject({ folders: ['Archive'] })
    const deleted = await request('DELETE', { folder: 'Archive' })
    expect(deleted.status).toBe(200)
    expect(await deleted.json()).toMatchObject({ notes: [], folders: [] })

    const method = await fetch(`${baseUrl}/api/notes/folders`, { method: 'PUT' })
    expect(method.status).toBe(405)
    expect(method.headers.get('Allow')).toBe('POST, PATCH, DELETE')
  })

  it('serves CRUD, conflict, validation, method, and not-found responses after auth dispatch', async () => {
    const { directory, store } = await temporaryNotesStore()
    const baseUrl = await startApi(store)

    const createdResponse = await fetch(`${baseUrl}/api/notes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'API note', body: 'body' }),
    })
    expect(createdResponse.status).toBe(201)
    const created = (await createdResponse.json()) as { note: Note }

    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01])
    const uploadResponse = await fetch(`${baseUrl}/api/notes/${created.note.id}/images`, {
      method: 'POST',
      headers: { 'Content-Type': 'image/png' },
      body: png,
    })
    expect(uploadResponse.status).toBe(201)
    const uploaded = (await uploadResponse.json()) as { path: string }
    const imageName = uploaded.path.split('/').at(-1)!
    const imageResponse = await fetch(`${baseUrl}/api/notes/${created.note.id}/images/${imageName}`)
    expect(imageResponse.status).toBe(200)
    expect(imageResponse.headers.get('content-type')).toBe('image/png')
    expect(Buffer.from(await imageResponse.arrayBuffer())).toEqual(png)

    const invalidImageResponse = await fetch(`${baseUrl}/api/notes/${created.note.id}/images`, {
      method: 'POST',
      headers: { 'Content-Type': 'image/svg+xml' },
      body: '<svg/>',
    })
    expect(invalidImageResponse.status).toBe(400)

    const listResponse = await fetch(`${baseUrl}/api/notes`)
    expect(listResponse.status).toBe(200)
    expect((await listResponse.json()) as unknown).toMatchObject({
      notes: [{ id: created.note.id, title: 'API note' }],
    })

    const updatedResponse = await fetch(`${baseUrl}/api/notes/${created.note.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Updated',
        body: 'new body',
        expectedUpdatedAt: created.note.updatedAt,
      }),
    })
    expect(updatedResponse.status).toBe(200)
    const updated = (await updatedResponse.json()) as { note: Note }

    const [path] = await markdownFiles(directory)
    await utimes(join(directory, path), new Date(), new Date(updated.note.updatedAt + 5_000))
    const conflictResponse = await fetch(`${baseUrl}/api/notes/${created.note.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Stale',
        body: 'stale',
        expectedUpdatedAt: updated.note.updatedAt,
      }),
    })
    expect(conflictResponse.status).toBe(409)

    const deleteConflict = await fetch(`${baseUrl}/api/notes/${created.note.id}`, {
      method: 'DELETE',
      headers: { 'If-Match': `"${updated.note.updatedAt}"` },
    })
    expect(deleteConflict.status).toBe(409)

    const invalidResponse = await fetch(`${baseUrl}/api/notes/${created.note.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'text/plain' },
      body: '{}',
    })
    expect(invalidResponse.status).toBe(400)

    const methodResponse = await fetch(`${baseUrl}/api/notes`, { method: 'PATCH' })
    expect(methodResponse.status).toBe(405)
    expect(methodResponse.headers.get('allow')).toBe('GET, POST')

    const latest = await store.get(created.note.id)
    expect((await fetch(`${baseUrl}/api/notes/${created.note.id}`, {
      method: 'DELETE',
      headers: { 'If-Match': `"${latest.updatedAt}"` },
    })).status).toBe(204)
    expect((await fetch(`${baseUrl}/api/notes/${created.note.id}`)).status).toBe(404)
    expect((await fetch(`${baseUrl}/api/notes/${created.note.id}/images/${imageName}`)).status).toBe(404)
  })
})
