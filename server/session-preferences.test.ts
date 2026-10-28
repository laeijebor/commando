import { mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
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
    }, [{ id: '$1', name: 'project' }], '1:1')
    const stored = await readFile(path, 'utf8')
    const before = await stat(path)

    const preferences = await new SessionPreferenceStore(path).loadReadOnly([
      { id: '$8', name: 'project' }, { id: '$1', name: 'scratch' },
    ], '2:2')

    expect(preferences).toEqual({
      version: 1,
      ...(groupingMode ? { groupingMode } : {}),
      groups: [{ id: 'g1', name: 'Work', sessionIds: ['$8'] }],
      ungroupedSessionIds: ['$1'],
      repositorySessionIds: ['$8'],
      sessionNamesById: { $8: 'project', $1: 'scratch' },
      serverId: '2:2',
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
    const stale = await store.ensureIdentities([], sessions, serverId)
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

  it('remaps member ids on reuse with separate claims and keeps absent members as placeholders', () => {
    const preferences = { ...base, repositoryGroups: [group, { ...group, id: 'later', sessionIds: ['$9'] }], repositorySessionIds: ['group:landing', '$1'], sessionNamesById: { $1: 'work', $9: 'returning' }, serverId: '1:1' }
    const reconciled = reconcileSessionTreePreferences(preferences, [{ id: '$8', name: 'work' }, { id: '$1', name: 'scratch' }], '2:2')
    expect(reconciled.repositorySessionIds).toEqual(['group:landing', '$8'])
    expect(reconciled.repositoryGroups).toEqual([{ ...group, sessionIds: ['$8'] }, { ...group, id: 'later', sessionIds: ['name:returning'] }])
    expect(reconciled.ungroupedSessionIds).toEqual(['$8', '$1'])
    expect(reconciled.sessionNamesById).toEqual({ $8: 'work', $1: 'scratch' })
  })

  it('keeps empty groups and order tokens in visible preferences', () => {
    const preferences = { ...base, repositoryGroups: [group], repositorySessionIds: ['group:landing', '$1', '$2'] }
    expect(visibleSessionTreePreferences(preferences, [{ id: '$2', name: 'live' }])).toMatchObject({
      repositoryGroups: [{ ...group, sessionIds: [] }], repositorySessionIds: ['group:landing', '$2'],
    })
  })

  it.each([
    { sessionIds: ['$5', '$6', '$7', '$9'], expected: ['name:foo', '$6', 'name:absent'] },
    { sessionIds: ['$5'], expected: ['name:foo'] },
  ])('after a tmux restart, holds a member\'s place by name instead of giving it to the session that reused its id ($sessionIds)', ({ sessionIds, expected }) => {
    const manualGroup = { id: 'manual', name: 'Manual', sessionIds: ['$5'] }
    const preferences = {
      ...base,
      groups: [manualGroup],
      repositoryGroups: [{ ...group, sessionIds }],
      repositorySessionIds: ['group:landing'],
      sessionNamesById: { $5: 'foo', $6: 'kept', $9: 'absent' },
      serverId: '1:1',
    }
    const reconciled = reconcileSessionTreePreferences(preferences, [
      { id: '$5', name: 'bar' }, { id: '$6', name: 'kept' }, { id: '$7', name: 'no stored name' },
    ], '2:2')
    expect(reconciled.repositoryGroups).toEqual([{ ...group, sessionIds: expected }])
    expect(reconciled.repositorySessionIds).toEqual(['group:landing'])
    expect(reconciled.groups).toEqual([{ ...manualGroup, sessionIds: ['name:foo'] }])
    expect(reconciled.ungroupedSessionIds).toEqual(['$5', '$6', '$7'])
  })

  it('keeps a member renamed in tmux once the rename is recorded, and ignores stale rename events', async () => {
    const store = new SessionPreferenceStore(join(folder, 'session-tree.json'))
    await store.replace({ ...base, repositoryGroups: [group], repositorySessionIds: ['group:landing'] }, [{ id: '$1', name: 'work' }])
    await store.recordSessionRename('$1', 'work', 'renamed')
    expect((await store.load([{ id: '$1', name: 'renamed' }])).repositoryGroups).toEqual([group])
    // A rename already recorded (e.g. by the HTTP rename route) is not overwritten by a late event.
    await store.recordSessionRename('$1', 'work', 'other')
    expect((await store.load([{ id: '$1', name: 'renamed' }])).sessionNamesById).toEqual({ $1: 'renamed' })
  })

  it('accepts a deliberate group assignment for a reused id, but still drops stale membership', async () => {
    const store = new SessionPreferenceStore(join(folder, 'session-tree.json'))
    const empty = { ...group, sessionIds: [] }
    await store.replace({ ...base, ungroupedSessionIds: [], repositoryGroups: [{ ...group, id: 'stale', sessionIds: ['$2'] }, empty], repositorySessionIds: ['group:stale', 'group:landing'] }, [{ id: '$1', name: 'old' }, { id: '$2', name: 'gone' }], '1:1')
    // After a tmux restart, $1 and $2 belong to new sessions; the old names are not live.
    const sessions = [{ id: '$1', name: 'new' }, { id: '$2', name: 'other' }]
    const view = await store.load(sessions, '2:2')
    expect(view.repositoryGroups?.find((item) => item.id === 'stale')?.sessionIds).toEqual(['name:gone'])
    const saved = await store.replace({ ...view, repositoryGroups: view.repositoryGroups?.map((item) => item.id === 'landing' ? { ...item, sessionIds: ['$1'] } : item) }, sessions, '2:2')
    expect(saved.repositoryGroups?.find((item) => item.id === 'landing')?.sessionIds).toEqual(['$1'])
    expect(saved.sessionNamesById?.$1).toBe('new')
    expect((await store.load(sessions, '2:2')).repositoryGroups?.find((item) => item.id === 'landing')?.sessionIds).toEqual(['$1'])
  })

  it('accepts a reused id moved back into the group its old session was in, on the first save', async () => {
    const store = new SessionPreferenceStore(join(folder, 'session-tree.json'))
    await store.replace({ ...base, repositoryGroups: [group], repositorySessionIds: ['group:landing'] }, [{ id: '$1', name: 'old' }], '1:1')
    const sessions = [{ id: '$1', name: 'new' }]
    const view = await store.load(sessions, '2:2')
    expect(view.repositoryGroups).toEqual([{ ...group, sessionIds: ['name:old'] }])
    const saved = await store.replace({ ...view, repositoryGroups: [group] }, sessions, '2:2')
    expect(saved.repositoryGroups).toEqual([group])
    expect(saved.sessionNamesById?.$1).toBe('new')
  })

  it('does not hand an old session\'s group to its id\'s new session when a stale snapshot is saved', async () => {
    const store = new SessionPreferenceStore(join(folder, 'session-tree.json'))
    const before = await store.replace({ ...base, repositoryGroups: [group], repositorySessionIds: ['group:landing'] }, [{ id: '$1', name: 'old' }], '1:1')
    const sessions = [{ id: '$1', name: 'new' }]
    expect((await store.load(sessions, '2:2')).repositoryGroups).toEqual([{ ...group, sessionIds: ['name:old'] }])
    // A client still holding the pre-restart view saves an unrelated change.
    const saved = await store.replace({ ...before, repositoryGroups: [{ ...group, collapsed: false }] }, sessions, '2:2')
    expect(saved.repositoryGroups).toEqual([{ ...group, collapsed: false, sessionIds: ['name:old'] }])
    expect(saved.ungroupedSessionIds).toEqual(['name:old', '$1'])
  })

  it('names a newly created group member from the client until tmux reports it', async () => {
    const store = new SessionPreferenceStore(join(folder, 'session-tree.json'))
    await store.replace({ ...base, ungroupedSessionIds: ['$3'], repositoryGroups: [{ ...group, sessionIds: [] }], sessionNamesById: { $3: 'deleted' } }, [])
    const view = await store.load([])
    expect(view.sessionNamesById?.$3).toBe('deleted')
    await store.replace({ ...view, repositoryGroups: [{ ...group, sessionIds: ['$3'] }], sessionNamesById: { ...view.sessionNamesById, $3: 'fresh' } }, [])
    expect((await store.load([{ id: '$3', name: 'fresh' }])).repositoryGroups).toEqual([{ ...group, sessionIds: ['$3'] }])
  })

  it('keeps a session created into a manual group before tmux reports it', async () => {
    const store = new SessionPreferenceStore(join(folder, 'session-tree.json'))
    const sessions = [{ id: '$1', name: 'work' }]
    const view = await store.load(sessions, '1:1')
    const saved = await store.replace({ ...view, groupingMode: 'manual', groups: [{ id: 'g', name: 'G', sessionIds: ['$2'] }] }, sessions, '1:1')
    expect(saved.groups).toEqual([{ id: 'g', name: 'G', sessionIds: ['$2'] }])
    const loaded = await store.load([...sessions, { id: '$2', name: 'fresh' }], '1:1')
    expect(loaded.groups).toEqual([{ id: 'g', name: 'G', sessionIds: ['$2'] }])
    expect(loaded.ungroupedSessionIds).toEqual(['$1'])
  })

  it('keeps a recorded rename when a stale client snapshot is saved afterwards', async () => {
    const store = new SessionPreferenceStore(join(folder, 'session-tree.json'))
    await store.replace({ ...base, repositoryGroups: [group], repositorySessionIds: ['group:landing'] }, [{ id: '$1', name: 'work' }])
    const clientView = await store.load([{ id: '$1', name: 'work' }])
    await store.recordSessionRename('$1', 'work', 'renamed')
    const saved = await store.replace(clientView, [{ id: '$1', name: 'renamed' }])
    expect(saved.repositoryGroups).toEqual([group])
    expect(saved.sessionNamesById).toEqual({ $1: 'renamed' })
  })

  it('uses the member name after remapping even when the destination id has a different stored name', () => {
    const reconciled = reconcileSessionTreePreferences({
      ...base,
      repositoryGroups: [group],
      sessionNamesById: { $1: 'work', $8: 'deleted' },
      serverId: '1:1',
    }, [{ id: '$8', name: 'work' }, { id: '$1', name: 'scratch' }], '2:2')
    expect(reconciled.repositoryGroups).toEqual([{ ...group, sessionIds: ['$8'] }])
  })

  it('keeps groups and order through a tmux-resurrect restore that hands out ids one session at a time', async () => {
    const store = new SessionPreferenceStore(join(folder, 'session-tree.json'))
    const before = [{ id: '$40', name: 'perf-a' }, { id: '$41', name: 'scratch' }, { id: '$42', name: 'perf-b' }]
    await store.replace({
      ...base, ungroupedSessionIds: [], groupingMode: 'repository',
      // $1 and $2 are long-closed sessions; their ids will be reused after the restart.
      repositorySessionIds: ['$1', '$41', 'group:landing', '$2'],
      repositoryGroups: [{ ...group, sessionIds: ['$42', '$40'] }],
      sessionNamesById: { $1: 'closed-1', $2: 'closed-2' },
    }, before, '1:1')

    const restored: { id: string; name: string }[] = [{ id: '$0', name: 'tmr-bootstrap' }]
    for (const name of ['perf-a', 'perf-b', 'scratch']) {
      restored.push({ id: `$${restored.length}`, name })
      await store.load(restored, '2:2')
    }
    const after = await new SessionPreferenceStore(store.statePath).load(restored.slice(1), '2:2')
    expect(after.repositoryGroups).toEqual([{ ...group, sessionIds: ['$2', '$1'] }])
    expect(after.repositorySessionIds).toEqual(['name:closed-1', '$3', 'group:landing', 'name:closed-2'])
    expect(after.sessionNamesById).toMatchObject({ $1: 'perf-a', $2: 'perf-b', $3: 'scratch' })
  })

  it('reads preferences saved before server ids were recorded on this tmux server as its own, correcting names from tmux', async () => {
    const path = join(folder, 'session-tree.json')
    await writeFile(path, JSON.stringify({
      ...base, ungroupedSessionIds: ['$3', '$1'], repositorySessionIds: ['$3', '$1'],
      sessionNamesById: { $3: 'closed long ago', $1: 'work' },
    }))
    const store = new SessionPreferenceStore(path)
    const view = await store.load([{ id: '$1', name: 'work' }, { id: '$3', name: 'Battery usage' }], '5:5')
    expect(view.repositorySessionIds).toEqual(['$3', '$1'])
    expect(view.sessionNamesById).toEqual({ $1: 'work', $3: 'Battery usage' })
    expect(view.serverId).toBe('5:5')
    // The next restart finds "Battery usage" by its real name.
    const restarted = await store.load([{ id: '$1', name: 'Battery usage' }, { id: '$2', name: 'work' }], '6:6')
    expect(restarted.repositorySessionIds).toEqual(['$1', '$2'])
  })

  it('reads preferences saved before server ids were recorded by name if tmux started after they were written', async () => {
    const path = join(folder, 'session-tree.json')
    await writeFile(path, JSON.stringify({
      ...base, ungroupedSessionIds: [], repositoryGroups: [{ ...group, sessionIds: ['$7'] }], sessionNamesById: { $7: 'perf' },
    }))
    const writtenAt = Math.floor((await stat(path)).mtimeMs / 1000)
    // tmux restarted after the save and restore has only reached $7 so far, with another session.
    const view = await new SessionPreferenceStore(path).load([{ id: '$7', name: 'scratch' }], `9:${writtenAt + 60}`)
    expect(view.repositoryGroups).toEqual([{ ...group, sessionIds: ['name:perf'] }])
    expect((await new SessionPreferenceStore(path).load([{ id: '$7', name: 'scratch' }, { id: '$8', name: 'perf' }], `9:${writtenAt + 60}`)).repositoryGroups)
      .toEqual([{ ...group, sessionIds: ['$8'] }])
  })

  it('judges an old preferences file before an identity write on the same request updates its write time', async () => {
    const path = join(folder, 'session-tree.json')
    await writeFile(path, JSON.stringify({ ...base, ungroupedSessionIds: [], repositoryGroups: [{ ...group, sessionIds: ['$7'] }], sessionNamesById: { $7: 'perf' } }))
    const now = Math.floor(Date.now() / 1000)
    await utimes(path, now - 120, now - 120)
    const serverId = `9:${now - 60}`
    const sessions = [{ id: '$7', name: 'scratch' }]
    const store = new SessionPreferenceStore(path)
    // The preferences GET assigns identities (a write) before it loads.
    await store.ensureIdentities([], sessions, serverId)
    expect((await store.load(sessions, serverId)).repositoryGroups).toEqual([{ ...group, sessionIds: ['name:perf'] }])
  })

  it('keeps a renamed member in place when a stale client still names it as a session that now exists', async () => {
    const store = new SessionPreferenceStore(join(folder, 'session-tree.json'))
    await store.replace({ ...base, repositoryGroups: [group], repositorySessionIds: ['group:landing'] }, [{ id: '$1', name: 'work' }], '1:1')
    const clientView = await store.load([{ id: '$1', name: 'work' }], '1:1')
    await store.recordSessionRename('$1', 'work', 'renamed', '1:1')
    const sessions = [{ id: '$1', name: 'renamed' }, { id: '$2', name: 'work' }]
    const saved = await store.replace({ ...clientView, repositoryGroups: [{ ...group, collapsed: false }] }, sessions, '1:1')
    expect(saved.repositoryGroups).toEqual([{ ...group, collapsed: false, sessionIds: ['$1'] }])
    expect(saved.sessionNamesById).toEqual({ $1: 'renamed', $2: 'work' })
  })

  it('does not rename an old server\'s entry when a session is renamed before the first load after a restart', async () => {
    const store = new SessionPreferenceStore(join(folder, 'session-tree.json'))
    await store.replace({ ...base, ungroupedSessionIds: [], repositoryGroups: [group] }, [{ id: '$1', name: 'api' }, { id: '$2', name: 'scratch' }], '1:1')
    await store.renameIdentity('scratch', 'notes', '$1', '2:2')
    const view = await store.load([{ id: '$1', name: 'notes' }, { id: '$2', name: 'api' }], '2:2')
    expect(view.repositoryGroups).toEqual([{ ...group, sessionIds: ['$2'] }])
  })

  it('matches a client view without a server id by name, as it may predate a tmux restart', async () => {
    const store = new SessionPreferenceStore(join(folder, 'session-tree.json'))
    await store.replace({ ...base, ungroupedSessionIds: [], repositoryGroups: [group] }, [{ id: '$1', name: 'api' }], '1:1')
    const legacyView = { ...base, ungroupedSessionIds: [], repositoryGroups: [group], sessionNamesById: { $1: 'api' } }
    const saved = await store.replace(legacyView, [{ id: '$1', name: 'scratch' }, { id: '$2', name: 'api' }], '2:2')
    expect(saved.repositoryGroups).toEqual([{ ...group, sessionIds: ['$2'] }])
  })

  it('rejects malformed placeholders and server ids', () => {
    expect(parseSessionTreePreferences({ ...base, ungroupedSessionIds: ['name:'] })).toBeNull()
    expect(parseSessionTreePreferences({ ...base, ungroupedSessionIds: ['name:bad\nname'] })).toBeNull()
    expect(parseSessionTreePreferences({ ...base, serverId: '' })).toBeNull()
    expect(parseSessionTreePreferences({ ...base, serverId: 7 })).toBeNull()
    expect(parseSessionTreePreferences({ ...base, ungroupedSessionIds: ['name:Battery usage'], serverId: '1:1' })).toMatchObject({ ungroupedSessionIds: ['name:Battery usage'], serverId: '1:1' })
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
