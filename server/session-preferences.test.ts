import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseSessionTreePreferences, SessionPreferenceStore } from './session-preferences.js'

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

describe('session identities', () => {
  it('migrates old preferences and persists identities across tmux id reuse', async () => {
    const path = join(folder, 'session-tree.json')
    const store = new SessionPreferenceStore(path)
    await store.replace({ version: 1, groups: [], ungroupedSessionIds: ['$1'] }, [{ id: '$1', name: 'Subscriptions' }])
    const old = JSON.parse(await readFile(path, 'utf8'))
    expect(old.sessionIdentities).toBeUndefined()
    const assigned = await store.ensureIdentities(['Chat'], [{ id: '$1', name: 'Subscriptions' }])
    expect(assigned.sessionIdentities?.Subscriptions.glyph).toBe('💷')
    const restored = await new SessionPreferenceStore(path).load([{ id: '$8', name: 'Subscriptions' }, { id: '$1', name: 'Chat' }])
    expect(restored.sessionIdentities).toEqual(assigned.sessionIdentities)
    expect(JSON.parse(await readFile(path, 'utf8')).sessionIdentities).toEqual(assigned.sessionIdentities)
  })

  it('preserves user glyphs on stale grouping saves, moves identities on rename, and resets', async () => {
    const path = join(folder, 'session-tree.json')
    const store = new SessionPreferenceStore(path)
    const sessions = [{ id: '$1', name: 'Chat' }]
    const stale = await store.ensureIdentities([], sessions)
    const custom = await store.changeIdentity('Chat', '👩🏽‍💻', sessions)
    expect(custom.sessionIdentities?.Chat).toMatchObject({ glyph: '👩🏽‍💻', glyphSource: 'user' })
    await store.replace(stale, sessions)
    expect((await store.load()).sessionIdentities).toEqual(custom.sessionIdentities)
    await store.renameIdentity('Chat', 'Billing', '$1')
    const renamed = await store.load([{ id: '$1', name: 'Billing' }])
    expect(renamed.sessionIdentities?.Billing).toEqual(custom.sessionIdentities?.Chat)
    expect(renamed.sessionIdentities?.Chat).toBeUndefined()
    expect(renamed.sessionNamesById).toEqual({ $1: 'Billing' })
    await store.replace(stale)
    expect((await store.load()).sessionIdentities).toEqual(renamed.sessionIdentities)
    const reset = await store.changeIdentity('Billing', null)
    expect(reset.sessionIdentities?.Billing).toMatchObject({ glyph: '💷', glyphSource: 'auto' })
    await expect(store.changeIdentity('Billing', 'not emoji')).rejects.toThrow('single emoji')
  })

  it('serializes simultaneous identity assignments without losing entries', async () => {
    const store = new SessionPreferenceStore(join(folder, 'session-tree.json'))
    await Promise.all([store.ensureIdentities(['Chat']), store.ensureIdentities(['Billing']), store.changeIdentity('Chat', '🐢')])
    const identities = (await store.load()).sessionIdentities
    expect(identities?.Chat).toMatchObject({ glyph: '🐢', glyphSource: 'user' })
    expect(identities?.Billing.glyph).toBe('💷')
  })
})


it('normalizes an optional identity map without rejecting legacy preferences', () => {
  const base = { version: 1, groups: [], ungroupedSessionIds: [] }
  expect(parseSessionTreePreferences(base)).toEqual(base)
  expect(parseSessionTreePreferences({ ...base, sessionIdentities: { unknown: { glyph: 'x' } } })).toEqual({ ...base, sessionIdentities: {} })
  expect(parseSessionTreePreferences({ ...base, sessionIdentities: null })).toEqual({ ...base, sessionIdentities: {} })
})
