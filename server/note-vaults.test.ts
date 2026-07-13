import { mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { NoteValidationError } from './notes.js'
import { NoteVaultManager } from './note-vaults.js'

const temporaryDirectories: string[] = []

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
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

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
    const cleared = await reopened.clearHistory()
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
})
