import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SessionPreferenceStore } from './session-preferences.js'

let folder: string
beforeEach(async () => { folder = await mkdtemp(join(tmpdir(), 'commando-preferences-')) })
afterEach(async () => { await rm(folder, { recursive: true, force: true }) })

describe('SessionPreferenceStore.loadReadOnly', () => {
  it.each([undefined, 'manual', 'repository'] as const)('reconciles renumbered sessions in memory without changing the file (mode: %s)', async (groupingMode) => {
    const path = join(folder, 'session-tree.json')
    await new SessionPreferenceStore(path).replace({
      version: 1,
      groupingMode,
      groups: [{ id: 'g1', name: 'Work', sessionIds: ['$1'] }],
      ungroupedSessionIds: [],
      repositorySessionIds: ['$1'],
    }, [{ id: '$1', name: 'project' }])
    const stored = await readFile(path, 'utf8')
    const before = await stat(path)

    const preferences = await new SessionPreferenceStore(path).loadReadOnly([
      { id: '$8', name: 'project' }, { id: '$1', name: 'scratch' },
    ])

    expect(preferences).toEqual({
      version: 1,
      ...(groupingMode ? { groupingMode } : {}),
      groups: [{ id: 'g1', name: 'Work', sessionIds: ['$8'] }],
      ungroupedSessionIds: ['$1'],
      repositorySessionIds: ['$8'],
      sessionNamesById: { $8: 'project', $1: 'scratch' },
    })
    expect(await readFile(path, 'utf8')).toBe(stored)
    expect(await stat(path)).toMatchObject({ mtimeMs: before.mtimeMs, ino: before.ino })
  })

  it('returns current sessions without creating a missing preferences file', async () => {
    const path = join(folder, 'missing', 'session-tree.json')
    await expect(new SessionPreferenceStore(path).loadReadOnly([{ id: '$1', name: 'work' }])).resolves.toEqual({
      version: 1, groups: [], ungroupedSessionIds: ['$1'], sessionNamesById: { $1: 'work' },
    })
    await expect(stat(join(folder, 'missing'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('reads the latest preferences written through another store instance', async () => {
    const path = join(folder, 'session-tree.json')
    const reader = new SessionPreferenceStore(path)
    const writer = new SessionPreferenceStore(path)
    const sessions = [{ id: '$1', name: 'work' }]
    await reader.loadReadOnly(sessions)
    await writer.replace({
      version: 1, groupingMode: 'manual',
      groups: [{ id: 'g1', name: 'Updated', sessionIds: ['$1'] }], ungroupedSessionIds: [],
    }, sessions)

    await expect(reader.loadReadOnly(sessions)).resolves.toMatchObject({
      groupingMode: 'manual', groups: [{ id: 'g1', name: 'Updated', sessionIds: ['$1'] }],
    })
  })
})
