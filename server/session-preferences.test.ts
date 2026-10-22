import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseSessionTreePreferences, reconcileSessionTreePreferences, SessionPreferenceStore, visibleSessionTreePreferences } from './session-preferences.js'

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

describe('repository sub-groups', () => {
  const group = { id: 'landing', name: 'Landing', repoRoot: '/workspace/vivifit', sessionIds: ['$1'], collapsed: true }
  const base = { version: 1 as const, groups: [], ungroupedSessionIds: ['$1'] }

  it('accepts repository groups independently of manual membership and mixed order tokens', () => {
    const preferences = { ...base, repositoryGroups: [group], repositorySessionIds: ['$2', 'group:landing'] }
    expect(parseSessionTreePreferences(preferences)).toEqual(preferences)
    expect(parseSessionTreePreferences({ ...base, repositoryGroups: [] })?.repositoryGroups).toEqual([])
    expect(parseSessionTreePreferences({ ...base, repositoryGroups: [{ ...group, sessionIds: [], collapsed: false }] })?.repositoryGroups?.[0].collapsed).toBe(false)
  })

  it.each([
    null,
    [{}],
    [{ ...group, id: 'bad:id' }],
    [group, group],
    [{ ...group, name: '' }],
    [{ ...group, name: ' Landing' }],
    [{ ...group, name: 'x'.repeat(129) }],
    [{ ...group, name: 'bad\nname' }],
    [{ ...group, repoRoot: 'relative/repo' }],
    [{ ...group, repoRoot: '/' + 'x'.repeat(4096) }],
    [{ ...group, repoRoot: '/bad\u007froot' }],
    [{ ...group, repoRoot: null }],
    [{ ...group, sessionIds: ['$1', '$1'] }],
    [{ ...group, sessionIds: ['%1'] }],
    [{ ...group, sessionIds: null }],
    [group, { ...group, id: 'other', repoRoot: '/elsewhere' }],
    [{ ...group, collapsed: 'yes' }],
    Array.from({ length: 129 }, (_, index) => ({ ...group, id: 'g' + index, sessionIds: [] })),
    [{ ...group, sessionIds: Array.from({ length: 4097 }, (_, index) => '$' + index) }],
  ].map((repositoryGroups) => ({ repositoryGroups })))('rejects invalid groups', ({ repositoryGroups }) => {
    expect(parseSessionTreePreferences({ ...base, repositoryGroups })).toBeNull()
  })

  it.each([['group:'], ['group:bad:id'], ['group:landing', 'group:landing'], ['$1', '$1'], ['%1'], ['group:' + 'x'.repeat(65)], Array.from({ length: 4097 }, (_, index) => '$' + index)].map((repositorySessionIds) => ({ repositorySessionIds })))('rejects invalid repository order', ({ repositorySessionIds }) => {
    expect(parseSessionTreePreferences({ ...base, repositorySessionIds })).toBeNull()
  })

  it('remaps member ids on reuse with separate claims and preserves group tokens and names of absent members', () => {
    const preferences = { ...base, repositoryGroups: [group, { ...group, id: 'later', sessionIds: ['$9'] }], repositorySessionIds: ['group:landing', '$1'], sessionNamesById: { $1: 'work', $9: 'returning' } }
    const reconciled = reconcileSessionTreePreferences(preferences, [{ id: '$8', name: 'work' }, { id: '$1', name: 'scratch' }])
    expect(reconciled.repositorySessionIds).toEqual(['group:landing', '$8'])
    expect(reconciled.repositoryGroups).toEqual([{ ...group, sessionIds: ['$8'] }, { ...group, id: 'later', sessionIds: ['$9'] }])
    expect(reconciled.ungroupedSessionIds).toEqual(['$8', '$1'])
    expect(reconciled.sessionNamesById).toEqual({ $8: 'work', $1: 'scratch', $9: 'returning' })
  })

  it('keeps empty groups and order tokens in visible preferences', () => {
    const preferences = { ...base, repositoryGroups: [group], repositorySessionIds: ['group:landing', '$1', '$2'] }
    expect(visibleSessionTreePreferences(preferences, [{ id: '$2', name: 'live' }])).toMatchObject({
      repositoryGroups: [{ ...group, sessionIds: [] }], repositorySessionIds: ['group:landing', '$2'],
    })
  })

  it.each([['$5', '$6', '$7', '$9'], ['$5']].map((sessionIds) => ({ sessionIds })))('drops a deleted repository member when its id is reused, keeping other members and empty groups ($sessionIds)', ({ sessionIds }) => {
    const manualGroup = { id: 'manual', name: 'Manual', sessionIds: ['$5'] }
    const preferences = {
      ...base,
      groups: [manualGroup],
      repositoryGroups: [{ ...group, sessionIds }],
      repositorySessionIds: ['group:landing'],
      sessionNamesById: { $5: 'foo', $6: 'kept', $9: 'absent' },
    }
    const reconciled = reconcileSessionTreePreferences(preferences, [
      { id: '$5', name: 'bar' }, { id: '$6', name: 'kept' }, { id: '$7', name: 'no stored name' },
    ])
    expect(reconciled.repositoryGroups).toEqual([{ ...group, sessionIds: sessionIds.filter((id) => id !== '$5') }])
    expect(reconciled.repositorySessionIds).toEqual(['group:landing'])
    expect(reconciled.groups).toEqual([manualGroup])
  })

  it('uses the member name after remapping even when the destination id has a different stored name', () => {
    const reconciled = reconcileSessionTreePreferences({
      ...base,
      repositoryGroups: [group],
      sessionNamesById: { $1: 'work', $8: 'deleted' },
    }, [{ id: '$8', name: 'work' }, { id: '$1', name: 'scratch' }])
    expect(reconciled.repositoryGroups).toEqual([{ ...group, sessionIds: ['$8'] }])
  })

  it('round-trips groups through replace, load and read-only loads without changing manual groups', async () => {
    const store = new SessionPreferenceStore(join(folder, 'session-tree.json'))
    const preferences = { ...base, groups: [{ id: 'manual', name: 'Manual', sessionIds: ['$1'] }], ungroupedSessionIds: [], repositoryGroups: [group, { ...group, id: 'empty', sessionIds: [] }], repositorySessionIds: ['group:landing', 'group:empty'] }
    await store.replace(preferences, [{ id: '$1', name: 'work' }])
    const sessions = [{ id: '$8', name: 'work' }]
    const restored = await store.loadReadOnly(sessions)
    expect(restored.repositoryGroups?.[0]).toEqual({ ...group, sessionIds: ['$8'] })
    expect(restored.groups).toEqual([{ id: 'manual', name: 'Manual', sessionIds: ['$8'] }])
    expect(await store.load(sessions)).toEqual(restored)
    expect(await new SessionPreferenceStore(store.statePath).loadReadOnly(sessions)).toEqual(restored)
  })
})
