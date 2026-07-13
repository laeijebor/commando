import { mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { NoteValidationError } from './notes.js'
import { handleNoteVaultsApi } from './note-vaults-api.js'
import { NoteVaultManager } from './note-vaults.js'
import { handleNotesApi } from './notes-api.js'

const temporaryDirectories: string[] = []
const servers: Server[] = []

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'commando-vaults-test-')))
  temporaryDirectories.push(root)
  const home = join(root, 'home')
  const parent = join(home, 'notes-vaults')
  await mkdir(parent, { recursive: true })
  return {
    root,
    parent,
    statePath: join(home, 'note-vaults.json'),
    defaultDirectory: join(parent, 'default'),
    legacyDirectory: join(home, 'notes'),
    legacyNotesPath: join(home, 'notes.json'),
  }
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function startApi(manager: NoteVaultManager): Promise<string> {
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      if (await handleNoteVaultsApi(request, response, url, manager)) return
      if (await handleNotesApi(request, response, url, manager)) return
      response.writeHead(404).end()
    })()
  })
  servers.push(server)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

describe('NoteVaultManager', () => {
  it('migrates the old default directory into notes-vaults/default', async () => {
    const paths = await fixture()
    await mkdir(paths.legacyDirectory)
    await writeFile(join(paths.legacyDirectory, 'existing.md'), '# Existing\n')
    const manager = new NoteVaultManager({ ...paths, environment: {} })

    const snapshot = await manager.snapshot()

    expect(snapshot.vaults).toHaveLength(1)
    expect(snapshot.vaults[0]).toMatchObject({ path: paths.defaultDirectory, name: 'default', available: true })
    await expect(readFile(join(paths.defaultDirectory, 'existing.md'), 'utf8')).resolves.toBe('# Existing\n')
    await expect(stat(paths.legacyDirectory)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('keeps the old directory in history when both old and new defaults exist', async () => {
    const paths = await fixture()
    await mkdir(paths.defaultDirectory)
    await mkdir(paths.legacyDirectory)
    await writeFile(join(paths.defaultDirectory, 'new.md'), '# New\n')
    await writeFile(join(paths.legacyDirectory, 'old.md'), '# Old\n')

    const snapshot = await new NoteVaultManager({ ...paths, environment: {} }).snapshot()

    expect(snapshot.vaults.map((vault) => vault.path)).toEqual([paths.defaultDirectory, paths.legacyDirectory])
    expect(snapshot.activeVaultId).toBe(snapshot.vaults[0].id)
  })

  it('persists MRU vaults, reopens the latest one, and clears only history', async () => {
    const paths = await fixture()
    const manager = new NoteVaultManager({ ...paths, environment: {} })
    const initial = await manager.snapshot()
    const createdPath = join(paths.parent, 'projects')
    const created = await manager.create(createdPath)
    const initialId = initial.activeVaultId
    const createdId = created.activeVaultId

    expect(created.vaults.map((vault) => vault.path)).toEqual([createdPath, paths.defaultDirectory])
    await manager.select(initialId)
    const reopened = new NoteVaultManager({ ...paths, environment: {} })
    expect((await reopened.snapshot()).activeVaultId).toBe(initialId)

    await reopened.select(createdId)
    const cleared = await reopened.clearHistory(createdId)
    expect(cleared.vaults).toEqual([expect.objectContaining({ id: createdId, path: createdPath })])
    expect((await stat(paths.defaultDirectory)).isDirectory()).toBe(true)
    expect((await stat(createdPath)).isDirectory()).toBe(true)
  })

  it('opens existing directories, deduplicates canonical paths, and scopes stores', async () => {
    const paths = await fixture()
    const manager = new NoteVaultManager({ ...paths, environment: {} })
    const existing = join(paths.parent, 'existing')
    await mkdir(existing)

    const firstOpen = await manager.open(existing)
    const secondOpen = await manager.open(`${existing}/`)
    expect(secondOpen.vaults).toHaveLength(2)
    expect(secondOpen.activeVaultId).toBe(firstOpen.activeVaultId)

    const defaultId = secondOpen.vaults.find((vault) => vault.path === paths.defaultDirectory)!.id
    const existingStore = await manager.store(firstOpen.activeVaultId)
    const defaultStore = await manager.store(defaultId)
    await existingStore.create({ title: 'Existing vault note', body: '' })
    await defaultStore.create({ title: 'Default vault note', body: '' })
    await expect(existingStore.list()).resolves.toEqual([expect.objectContaining({ title: 'Existing vault note' })])
    await expect(defaultStore.list()).resolves.toEqual([expect.objectContaining({ title: 'Default vault note' })])

    await manager.select(defaultId)
    await manager.clearHistory(defaultId)
    const reopened = await manager.open(existing)
    expect(await manager.store(reopened.activeVaultId)).toBe(existingStore)
  })

  it('honors the environment override and rejects unsafe or ambiguous paths', async () => {
    const paths = await fixture()
    const override = join(paths.parent, 'configured')
    const manager = new NoteVaultManager({
      ...paths,
      environment: { COMMANDO_NOTES_DIR: override },
    })
    expect((await manager.snapshot()).vaults[0].path).toBe(override)

    await expect(manager.open('relative')).rejects.toBeInstanceOf(NoteValidationError)
    await expect(manager.open('/')).rejects.toThrow('root')
    await expect(manager.create(join(paths.root, 'missing', 'vault'))).rejects.toThrow('parent')
    await expect(manager.create(override)).rejects.toThrow('already exists')
  })

  it('serves vault history, create, select, and clear endpoints', async () => {
    const paths = await fixture()
    const manager = new NoteVaultManager({ ...paths, environment: {} })
    const baseUrl = await startApi(manager)
    const initial = await fetch(`${baseUrl}/api/note-vaults`).then((response) => response.json()) as { activeVaultId: string }
    expect((await fetch(`${baseUrl}/api/notes`)).status).toBe(400)
    expect((await fetch(`${baseUrl}/api/notes?vault=${initial.activeVaultId}`)).status).toBe(200)
    const createdPath = join(paths.parent, 'api-created')

    const createdResponse = await fetch(`${baseUrl}/api/note-vaults/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: createdPath }),
    })
    expect(createdResponse.status).toBe(201)
    const created = await createdResponse.json() as { activeVaultId: string; vaults: unknown[] }
    expect(created.activeVaultId).not.toBe(initial.activeVaultId)
    expect(created.vaults).toHaveLength(2)

    expect((await fetch(`${baseUrl}/api/note-vaults/active`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: initial.activeVaultId }),
    })).status).toBe(200)
    const cleared = await fetch(`${baseUrl}/api/note-vaults/history?active=${initial.activeVaultId}`, { method: 'DELETE' }).then((response) => response.json()) as { vaults: unknown[] }
    expect(cleared.vaults).toHaveLength(1)

    const invalid = await fetch(`${baseUrl}/api/note-vaults/open`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'relative' }),
    })
    expect(invalid.status).toBe(400)
  })
})
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
