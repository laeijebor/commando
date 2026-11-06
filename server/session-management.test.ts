import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  parseSessionTreePreferences,
  reconcileSessionTreePreferences,
  visibleSessionTreePreferences,
  SessionPreferenceStore,
} from './session-preferences.js'
import { SessionManagementApi } from './session-management-api.js'
import { SessionWorktreeConflictError } from './session-worktree-deletion.js'
import { TmuxSessionActions, type TmuxProcessExecutor } from './tmux-session-actions.js'
import { SessionArchives } from './session-archives.js'

const directories: string[] = []
const servers: Server[] = []
const PLAN_WORKTREE = { root: '/repo-worktrees/cleanup', mainRoot: '/repo', branch: 'cleanup', head: 'c'.repeat(40) }

// Default SessionArchives read this folder; keep tests away from the real archives.
beforeAll(() => { process.env.COMMANDO_SESSION_ARCHIVES_DIR = join(tmpdir(), `commando-no-archives-${process.pid}`) })
afterAll(() => { delete process.env.COMMANDO_SESSION_ARCHIVES_DIR })

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function startApi(api: SessionManagementApi): Promise<string> {
  const server = createServer((request, response) => {
    void api.handle(request, response, new URL(request.url ?? '/', 'http://127.0.0.1'))
  })
  servers.push(server)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

describe('session tree preferences', () => {
  it('validates repository order independently of manual membership', () => {
    const base = { version: 1, groups: [], ungroupedSessionIds: ['$1'], repositorySessionIds: ['$2', '$1'] }
    expect(parseSessionTreePreferences(base)).toEqual(base)
    for (const repositorySessionIds of [null, '$1', ['$1', '$1'], ['invalid'], [1], Array.from({ length: 4097 }, (_, i) => `$${i}`)]) {
      expect(parseSessionTreePreferences({ ...base, repositorySessionIds })).toBeNull()
    }
  })

  it('persists repo order across reloads and restored session IDs, retaining hidden history', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'commando-repo-order-'))
    directories.push(directory)
    const path = join(directory, 'sessions.json')
    const store = new SessionPreferenceStore(path)
    await store.replace({
      version: 1,
      groups: [{ id: 'work', name: 'Work', sessionIds: ['$1', '$2'] }],
      ungroupedSessionIds: [],
      repositorySessionIds: ['$2', '$1'],
    }, [{ id: '$1', name: 'alpha' }, { id: '$2', name: 'beta' }])
    const restoredSessions = [{ id: '$8', name: 'alpha' }, { id: '$9', name: 'beta' }, { id: '$10', name: 'new' }]
    const restored = await new SessionPreferenceStore(path).load(restoredSessions)
    expect(restored.repositorySessionIds).toEqual(['$9', '$8'])
    expect(restored.groups[0].sessionIds).toEqual(['$8', '$9'])
    expect(restored.ungroupedSessionIds).toEqual(['$10'])
    expect(visibleSessionTreePreferences(restored, restoredSessions).repositorySessionIds).toEqual(['$9', '$8'])
    const partial = await store.load([{ id: '$8', name: 'alpha' }])
    expect(partial.repositorySessionIds).toEqual(['$9', '$8'])
    expect(visibleSessionTreePreferences(partial, [{ id: '$8', name: 'alpha' }]).repositorySessionIds).toEqual(['$8'])
  })

  it('holds a paused session’s place by name until a session with its name returns', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'commando-paused-place-'))
    directories.push(directory)
    const store = new SessionPreferenceStore(join(directory, 'sessions.json'))
    const sessions = [{ id: '$1', name: 'alpha' }, { id: '$2', name: 'beta' }]
    await store.replace({
      version: 1, groups: [{ id: 'work', name: 'Work', sessionIds: ['$1', '$2'] }], ungroupedSessionIds: [],
      repositorySessionIds: ['$2', '$1'], repositoryGroups: [{ id: 'g', name: 'G', repoRoot: '/repo', sessionIds: ['$1'] }],
    }, sessions)
    await store.holdPlaceByName('$1', 'alpha')
    const paused = await store.load([{ id: '$2', name: 'beta' }])
    expect(paused.groups[0].sessionIds).toEqual(['name:alpha', '$2'])
    expect(paused.repositorySessionIds).toEqual(['$2', 'name:alpha'])
    expect(paused.repositoryGroups?.[0].sessionIds).toEqual(['name:alpha'])
    const resumed = await store.load([{ id: '$7', name: 'alpha' }, { id: '$2', name: 'beta' }])
    expect(resumed.groups[0].sessionIds).toEqual(['$7', '$2'])
    expect(resumed.repositoryGroups?.[0].sessionIds).toEqual(['$7'])
  })

  it('validates uniqueness and reconciles new sessions without discarding hidden history', () => {
    const preferences = {
      version: 1 as const,
      groups: [{ id: 'work', name: 'Work', sessionIds: ['$1'] }],
      ungroupedSessionIds: ['$2'],
    }
    expect(parseSessionTreePreferences(preferences)).toEqual(preferences)
    expect(parseSessionTreePreferences({ ...preferences, ungroupedSessionIds: ['$1'] })).toBeNull()
    expect(reconcileSessionTreePreferences(preferences, [
      { id: '$3', name: 'three' },
      { id: '$1', name: 'one' },
    ])).toEqual({
      ...preferences,
      ungroupedSessionIds: ['$2', '$3'],
      sessionNamesById: { '$1': 'one', '$3': 'three' },
    })
  })

  it('keeps restored sessions in place when tmux regenerates and reuses their ids', () => {
    const preferences = {
      version: 1 as const,
      groups: [
        { id: 'gizmo', name: 'GIZMO', sessionIds: ['$1', '$2'] },
        { id: 'vivi', name: 'VIVI', sessionIds: ['$3'] },
      ],
      ungroupedSessionIds: ['$4'],
      sessionNamesById: {
        '$1': 'gizmo-api',
        '$2': 'gizmo-web',
        '$3': 'vivi-app',
        '$4': 'scratch',
      },
      serverId: '1:1',
    }

    expect(reconcileSessionTreePreferences(preferences, [
      { id: '$1', name: 'scratch' },
      { id: '$2', name: 'vivi-app' },
      { id: '$3', name: 'gizmo-web' },
      { id: '$4', name: 'gizmo-api' },
    ], '2:2')).toEqual({
      version: 1,
      groups: [
        { id: 'gizmo', name: 'GIZMO', sessionIds: ['$4', '$3'] },
        { id: 'vivi', name: 'VIVI', sessionIds: ['$2'] },
      ],
      ungroupedSessionIds: ['$1'],
      sessionNamesById: {
        '$1': 'scratch',
        '$2': 'vivi-app',
        '$3': 'gizmo-web',
        '$4': 'gizmo-api',
      },
      serverId: '2:2',
    })
  })

  it('serializes private persistent preferences and follows sessions across a tmux restart by name', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'commando-session-prefs-'))
    directories.push(directory)
    const path = join(directory, 'private', 'sessions.json')
    const store = new SessionPreferenceStore(path)
    const saved = await store.replace({
      version: 1,
      groups: [{ id: 'work', name: 'Work', sessionIds: ['$1'] }],
      ungroupedSessionIds: [],
    }, [
      { id: '$1', name: 'work' },
      { id: '$2', name: 'other' },
    ], '1:1')
    expect(saved.ungroupedSessionIds).toEqual(['$2'])
    expect(saved.sessionNamesById).toEqual({ '$1': 'work', '$2': 'other' })
    expect(saved.serverId).toBe('1:1')
    await expect(new SessionPreferenceStore(path).load([
      { id: '$1', name: 'work' },
      { id: '$2', name: 'other' },
    ], '1:1')).resolves.toEqual(saved)
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(saved)

    // tmux restarted and restored "other" first, under the id "work" used to have.
    const partialRestore = await new SessionPreferenceStore(path).load([
      { id: '$1', name: 'other' },
    ], '2:2')
    expect(partialRestore).toEqual({
      version: 1,
      groups: [{ id: 'work', name: 'Work', sessionIds: ['name:work'] }],
      ungroupedSessionIds: ['$1'],
      sessionNamesById: { '$1': 'other' },
      serverId: '2:2',
    })
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(partialRestore)

    const restored = await new SessionPreferenceStore(path).load([
      { id: '$1', name: 'other' },
      { id: '$2', name: 'work' },
    ], '2:2')
    expect(restored).toEqual({
      version: 1,
      groups: [{ id: 'work', name: 'Work', sessionIds: ['$2'] }],
      ungroupedSessionIds: ['$1'],
      sessionNamesById: { '$1': 'other', '$2': 'work' },
      serverId: '2:2',
    })
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(restored)
  })
})

describe('tmux session actions', () => {
  it('uses fixed argv and the configured socket for rename and delete', async () => {
    const execute = vi.fn<TmuxProcessExecutor>().mockResolvedValue({ stdout: '', stderr: '' })
    const actions = new TmuxSessionActions(execute, { COMMANDO_TMUX_SOCKET_NAME: 'qa' })
    await actions.rename('$12', 'renamed')
    await actions.delete('$12')
    await actions.deleteWindow('@7')
    expect(execute.mock.calls.map((call) => call[1])).toEqual([
      ['-L', 'qa', 'rename-session', '-t', '$12', 'renamed'],
      ['-L', 'qa', 'kill-session', '-t', '$12'],
      ['-L', 'qa', 'kill-window', '-t', '@7'],
    ])
    expect(execute.mock.calls[0][2]).toMatchObject({ shell: false, timeout: 3_000 })
  })

  it('rejects invalid identifiers and names before executing tmux', async () => {
    const execute = vi.fn<TmuxProcessExecutor>().mockResolvedValue({ stdout: '', stderr: '' })
    const actions = new TmuxSessionActions(execute, {})
    await expect(actions.rename('qa', 'name')).rejects.toThrow('Invalid tmux session id')
    await expect(actions.rename('$1', 'bad:name')).rejects.toThrow('unsupported characters')
    await expect(actions.deleteWindow('7')).rejects.toThrow('Invalid tmux window id')
    expect(execute).not.toHaveBeenCalled()
  })
})

describe('session management API', () => {
  it('archives an exact session id and restores only its archive', async () => {
    const archives = {
      list: vi.fn().mockResolvedValue([{ id: 'archive-id', name: 'work', createdAt: 1, windowCount: 1, paneCount: 2 }]),
      archive: vi.fn().mockResolvedValue({ id: 'archive-id', name: 'work', createdAt: 1, windowCount: 1, paneCount: 2 }),
      restore: vi.fn().mockResolvedValue('$9'),
    } as unknown as SessionArchives
    const onSessionsChanged = vi.fn().mockResolvedValue(undefined)
    const afterSessionRestored = vi.fn()
    const api = new SessionManagementApi({ archives, currentSessions: () => [{ id: '$1', name: 'other' }], currentWindowIds: () => [], onSessionsChanged, afterSessionRestored })
    const baseUrl = await startApi(api)
    const route = `${baseUrl}/api/session-management/sessions/%241/archive`
    const denied = await fetch(route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirmSessionId: '$2' }) })
    expect(denied.status).toBe(400)
    expect(vi.mocked(archives.archive)).not.toHaveBeenCalled()
    const archived = await fetch(route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirmSessionId: '$1' }) })
    expect(archived.status).toBe(200)
    expect(vi.mocked(archives.archive)).toHaveBeenCalledWith('$1', 'other', { paused: false })
    const restored = await fetch(`${baseUrl}/api/session-management/archives/archive-id/restore`, { method: 'POST' })
    expect(restored.status).toBe(200)
    await expect(restored.json()).resolves.toMatchObject({ sessionId: '$9' })
    expect(afterSessionRestored).toHaveBeenCalledWith('$9')
    expect(onSessionsChanged).toHaveBeenCalledTimes(2)
  })

  const worktree = { root: '/repo-worktrees/feature', mainRoot: '/repo', branch: 'feature', head: 'a'.repeat(40) }
  const post = (url: string, body: unknown) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const archiveHarness = (options: { commit?: () => Promise<typeof worktree>; paused?: boolean } = {}) => {
    const summary = { id: '11111111-1111-4111-8111-111111111111', name: 'work', createdAt: 1, windowCount: 1, paneCount: 1, ...(options.paused ? { paused: true as const } : {}) }
    const archives = {
      list: vi.fn().mockResolvedValue([summary]),
      get: vi.fn().mockResolvedValue({ ...summary, windows: [{ panes: [{ path: '/repo-worktrees/feature/app' }] }] }),
      archive: vi.fn().mockResolvedValue(summary),
      update: vi.fn(async (_id: string, change: object) => ({ ...summary, paused: undefined, ...change })),
    } as unknown as SessionArchives
    const remove = vi.fn().mockResolvedValue(undefined)
    const plan = { worktree, auxiliarySessions: [{ id: '$2', name: 'tilt-feature' }], remove }
    const actions = { delete: vi.fn().mockResolvedValue(undefined) } as unknown as TmuxSessionActions
    const preferences = { holdPlaceByName: vi.fn().mockResolvedValue(undefined) } as unknown as SessionPreferenceStore
    const commitWorkInProgress = vi.fn(options.commit ?? (async () => ({ ...worktree, head: 'b'.repeat(40) })))
    const prepareDirectoriesWorktreeDeletion = vi.fn().mockResolvedValue(plan)
    const api = new SessionManagementApi({
      archives, actions, preferences, commitWorkInProgress, prepareDirectoriesWorktreeDeletion,
      currentSessions: () => [{ id: '$1', name: 'work' }, { id: '$2', name: 'tilt-feature' }],
      currentWindowIds: () => [],
      prepareSessionWorktreeDeletion: vi.fn().mockResolvedValue(plan),
      sessionRepo: () => ({ root: '/repo', name: 'repo', branch: 'feature' }),
    })
    return { api, archives, remove, actions, preferences, commitWorkInProgress, prepareDirectoriesWorktreeDeletion, summary }
  }

  it('archives a session by saving uncommitted work, closing its helpers and removing its worktree', async () => {
    const { api, archives, remove, actions, commitWorkInProgress } = archiveHarness()
    const response = await post(`${await startApi(api)}/api/session-management/sessions/%241/archive`, { confirmSessionId: '$1' })
    expect(response.status).toBe(200)
    expect(vi.mocked(archives.archive)).toHaveBeenCalledWith('$1', 'work', { paused: false, repo: { root: '/repo', name: 'repo', branch: 'feature' } })
    expect(vi.mocked(actions.delete)).toHaveBeenCalledWith('$2')
    expect(commitWorkInProgress).toHaveBeenCalledWith(worktree, 'wip: archived session “work”')
    const removed = { path: worktree.root, mainRoot: '/repo', branch: 'feature', wipCommit: 'b'.repeat(40) }
    expect(vi.mocked(archives.update)).toHaveBeenCalledWith(expect.any(String), { worktree: removed })
    expect(remove).toHaveBeenCalledWith({ ...worktree, head: 'b'.repeat(40) })
    const body = await response.json()
    expect(body.archive.worktree).toEqual(removed)
    expect(body.worktreeKept).toBeUndefined()
  })

  it('keeps the worktree and says why when the work-in-progress commit fails', async () => {
    const { api, archives, remove } = archiveHarness({ commit: async () => { throw new Error('Worktree has unresolved merge conflicts') } })
    const response = await post(`${await startApi(api)}/api/session-management/sessions/%241/archive`, { confirmSessionId: '$1' })
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ worktreeKept: 'Worktree has unresolved merge conflicts' })
    expect(remove).not.toHaveBeenCalled()
    expect(vi.mocked(archives.update)).toHaveBeenLastCalledWith(expect.any(String), {})
  })

  it('keeps a worktree that a paused session will reopen in', async () => {
    const { api, archives, remove, commitWorkInProgress, summary } = archiveHarness()
    const other = { id: '22222222-2222-4222-8222-222222222222', name: 'side quest', createdAt: 2, windowCount: 1, paneCount: 1, paused: true as const }
    vi.mocked(archives.list).mockResolvedValue([summary, other])
    vi.mocked(archives.get).mockImplementation(async (id) => ({ ...(id === other.id ? other : summary), windows: [{ panes: [{ path: `${worktree.root}/app` }] }] }) as never)
    const response = await post(`${await startApi(api)}/api/session-management/sessions/%241/archive`, { confirmSessionId: '$1' })
    await expect(response.json()).resolves.toMatchObject({ worktreeKept: 'Paused session “side quest” still uses this worktree' })
    expect(commitWorkInProgress).not.toHaveBeenCalled()
    expect(remove).not.toHaveBeenCalled()
  })

  it('lets another archived session in the worktree check it out again when restored', async () => {
    const { api, archives, remove, summary } = archiveHarness()
    const other = { id: '33333333-3333-4333-8333-333333333333', name: 'older', createdAt: 0, windowCount: 1, paneCount: 1 }
    vi.mocked(archives.list).mockResolvedValue([summary, other])
    vi.mocked(archives.get).mockImplementation(async (id) => ({ ...(id === other.id ? other : summary), windows: [{ panes: [{ path: worktree.root }] }] }) as never)
    const response = await post(`${await startApi(api)}/api/session-management/sessions/%241/archive`, { confirmSessionId: '$1' })
    expect(response.status).toBe(200)
    expect(vi.mocked(archives.update)).toHaveBeenCalledWith(other.id, { worktree: { path: worktree.root, mainRoot: '/repo', branch: 'feature' } })
    expect(vi.mocked(archives.update)).not.toHaveBeenCalledWith(summary.id, { worktree: { path: worktree.root, mainRoot: '/repo', branch: 'feature' } })
    // Recorded before the folder goes, so a failed removal never leaves an archive without a way back.
    const recordedAt = vi.mocked(archives.update).mock.invocationCallOrder[vi.mocked(archives.update).mock.calls.findIndex(([id]) => id === other.id)]
    expect(recordedAt).toBeLessThan(remove.mock.invocationCallOrder[0])
  })

  it('archiving a paused session records the worktree on an archive that had to keep it', async () => {
    // Pause A, archive B (B keeps the worktree because A will reopen in it), then archive paused A.
    const { api, archives, remove, summary } = archiveHarness({ paused: true })
    const keptB = { id: '44444444-4444-4444-8444-444444444444', name: 'B', createdAt: 0, windowCount: 1, paneCount: 1 }
    vi.mocked(archives.list).mockResolvedValue([summary, keptB])
    vi.mocked(archives.get).mockImplementation(async (id) => ({ ...(id === keptB.id ? keptB : summary), windows: [{ panes: [{ path: `${worktree.root}/app` }] }] }) as never)
    const response = await post(`${await startApi(api)}/api/session-management/archives/${summary.id}/archive`, {})
    expect(response.status).toBe(200)
    expect(vi.mocked(archives.update)).toHaveBeenCalledWith(keptB.id, { worktree: { path: worktree.root, mainRoot: '/repo', branch: 'feature' } })
    expect(remove).toHaveBeenCalled()
  })

  it('pauses a session: stops it and its helpers, holds its place and keeps the worktree', async () => {
    const { api, archives, remove, actions, preferences, commitWorkInProgress } = archiveHarness()
    const response = await post(`${await startApi(api)}/api/session-management/sessions/%241/pause`, { confirmSessionId: '$1' })
    expect(response.status).toBe(200)
    expect(vi.mocked(archives.archive)).toHaveBeenCalledWith('$1', 'work', { paused: true, repo: { root: '/repo', name: 'repo', branch: 'feature' } })
    expect(vi.mocked(actions.delete)).toHaveBeenCalledWith('$2')
    expect(vi.mocked(preferences.holdPlaceByName)).toHaveBeenCalledWith('$1', 'work')
    expect(commitWorkInProgress).not.toHaveBeenCalled()
    expect(remove).not.toHaveBeenCalled()
  })

  it('archives a paused session from its saved directories', async () => {
    const { api, remove, prepareDirectoriesWorktreeDeletion, summary } = archiveHarness({ paused: true })
    const baseUrl = await startApi(api)
    const response = await post(`${baseUrl}/api/session-management/archives/${summary.id}/archive`, {})
    expect(response.status).toBe(200)
    expect(prepareDirectoriesWorktreeDeletion).toHaveBeenCalledWith(['/repo-worktrees/feature/app'])
    expect(remove).toHaveBeenCalled()
    expect((await response.json()).archive.paused).toBeUndefined()
  })

  it('enqueues a save after deleting a session, including the final session', async () => {
    const execute = vi.fn<TmuxProcessExecutor>().mockResolvedValue({ stdout: '', stderr: '' })
    const afterSessionDeleted = vi.fn()
    const onSessionsChanged = vi.fn().mockResolvedValue(undefined)
    const api = new SessionManagementApi({
      actions: new TmuxSessionActions(execute, { COMMANDO_TMUX_SOCKET_NAME: 'qa' }),
      currentSessions: () => [{ id: '$1', name: 'work' }],
      currentWindowIds: () => ['@7'],
      afterSessionDeleted,
      onSessionsChanged,
    })
    const baseUrl = await startApi(api)

    const response = await fetch(`${baseUrl}/api/session-management/sessions/%241/delete`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirmSessionId: '$1' }),
    })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ ok: true, sessionId: '$1' })
    expect(execute).toHaveBeenCalledWith(
      'tmux',
      ['-L', 'qa', 'kill-session', '-t', '$1'],
      expect.objectContaining({ shell: false, timeout: 3_000 }),
    )
    expect(afterSessionDeleted).toHaveBeenCalledWith('$1')
    expect(execute.mock.invocationCallOrder[0]).toBeLessThan(afterSessionDeleted.mock.invocationCallOrder[0])
    expect(onSessionsChanged).toHaveBeenCalled()
  })

  it('prepares linked worktree deletion before closing tmux, then removes it and refreshes', async () => {
    const execute = vi.fn<TmuxProcessExecutor>().mockResolvedValue({ stdout: '', stderr: '' })
    const removeWorktree = vi.fn().mockResolvedValue(undefined)
    const prepareSessionWorktreeDeletion = vi.fn().mockResolvedValue({ worktree: PLAN_WORKTREE, auxiliarySessions: [], remove: removeWorktree })
    const onSessionsChanged = vi.fn().mockResolvedValue(undefined)
    const api = new SessionManagementApi({
      actions: new TmuxSessionActions(execute, { COMMANDO_TMUX_SOCKET_NAME: 'qa' }),
      currentSessions: () => [{ id: '$1', name: 'work' }],
      currentWindowIds: () => [],
      prepareSessionWorktreeDeletion,
      onSessionsChanged,
    })
    const baseUrl = await startApi(api)

    const response = await fetch(`${baseUrl}/api/session-management/sessions/%241/delete`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirmSessionId: '$1', deleteWorktree: true }),
    })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ worktreeDeleted: true })
    expect(prepareSessionWorktreeDeletion).toHaveBeenCalledWith('$1')
    expect(prepareSessionWorktreeDeletion.mock.invocationCallOrder[0]).toBeLessThan(execute.mock.invocationCallOrder[0])
    expect(execute.mock.invocationCallOrder[0]).toBeLessThan(removeWorktree.mock.invocationCallOrder[0])
    expect(removeWorktree.mock.invocationCallOrder[0]).toBeLessThan(onSessionsChanged.mock.invocationCallOrder[0])
  })

  it('previews and closes only confirmed dependent sessions before deleting the worktree', async () => {
    const execute = vi.fn<TmuxProcessExecutor>().mockResolvedValue({ stdout: '', stderr: '' })
    const remove = vi.fn().mockResolvedValue(undefined)
    const prepare = vi.fn()
      .mockResolvedValueOnce({ worktree: PLAN_WORKTREE, auxiliarySessions: [{ id: '$2', name: 'native_app-cleanup' }], remove }) // preview
      .mockResolvedValueOnce({ worktree: PLAN_WORKTREE, auxiliarySessions: [{ id: '$2', name: 'native_app-cleanup' }], remove }) // refused delete
    const api = new SessionManagementApi({
      actions: new TmuxSessionActions(execute, { COMMANDO_TMUX_SOCKET_NAME: 'qa' }),
      currentSessions: () => [{ id: '$1', name: 'cleanup' }, { id: '$2', name: 'native_app-cleanup' }, { id: '$3', name: 'unrelated' }],
      currentWindowIds: () => [], prepareSessionWorktreeDeletion: prepare,
    })
    const baseUrl = await startApi(api)
    const route = `${baseUrl}/api/session-management/sessions/%241`
    const preview = await fetch(`${route}/delete-preview`)
    expect(preview.status).toBe(200)
    await expect(preview.json()).resolves.toEqual({ auxiliarySessions: [{ id: '$2', name: 'native_app-cleanup' }] })
    const deleteRequest = (ids: string[]) => fetch(`${route}/delete`, {
      method: 'DELETE', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirmSessionId: '$1', deleteWorktree: true, confirmAuxiliarySessionIds: ids }),
    })
    const missingConsent = await deleteRequest([])
    expect(missingConsent.status).toBe(409)
    expect(execute).not.toHaveBeenCalled()
    // A new preflight is required after the refused request.
    prepare.mockResolvedValueOnce({ worktree: PLAN_WORKTREE, auxiliarySessions: [{ id: '$2', name: 'native_app-cleanup' }], remove })
      .mockResolvedValueOnce({ worktree: PLAN_WORKTREE, auxiliarySessions: [], remove })
    const accepted = await deleteRequest(['$2'])
    expect(accepted.status).toBe(200)
    expect(execute.mock.calls.map((call) => call[1])).toEqual([
      ['-L', 'qa', 'kill-session', '-t', '$2'],
      ['-L', 'qa', 'kill-session', '-t', '$1'],
    ])
    expect(execute.mock.invocationCallOrder[1]).toBeLessThan(remove.mock.invocationCallOrder[0])
  })

  it('does not close any sessions when the helper set changes after confirmation', async () => {
    const execute = vi.fn<TmuxProcessExecutor>().mockResolvedValue({ stdout: '', stderr: '' })
    const api = new SessionManagementApi({
      actions: new TmuxSessionActions(execute, {}),
      currentSessions: () => [{ id: '$1', name: 'cleanup' }], currentWindowIds: () => [],
      prepareSessionWorktreeDeletion: vi.fn().mockResolvedValue({ worktree: PLAN_WORKTREE, auxiliarySessions: [{ id: '$9', name: 'tilt-cleanup' }], remove: vi.fn() }),
    })
    const baseUrl = await startApi(api)
    const response = await fetch(`${baseUrl}/api/session-management/sessions/%241/delete`, {
      method: 'DELETE', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirmSessionId: '$1', deleteWorktree: true, confirmAuxiliarySessionIds: ['$2'] }),
    })
    expect(response.status).toBe(409)
    expect(execute).not.toHaveBeenCalled()
  })

  it('keeps the main session and worktree when a helper cannot be closed', async () => {
    const execute = vi.fn<TmuxProcessExecutor>().mockRejectedValue(new Error('helper refused to close'))
    const remove = vi.fn()
    const api = new SessionManagementApi({
      actions: new TmuxSessionActions(execute, {}),
      currentSessions: () => [{ id: '$1', name: 'cleanup' }], currentWindowIds: () => [],
      prepareSessionWorktreeDeletion: vi.fn().mockResolvedValue({ worktree: PLAN_WORKTREE, auxiliarySessions: [{ id: '$2', name: 'native_app-cleanup' }], remove }),
      onSessionsChanged: vi.fn().mockResolvedValue(undefined),
    })
    const baseUrl = await startApi(api)
    const response = await fetch(`${baseUrl}/api/session-management/sessions/%241/delete`, {
      method: 'DELETE', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirmSessionId: '$1', deleteWorktree: true, confirmAuxiliarySessionIds: ['$2'] }),
    })
    expect(response.status).toBe(502)
    expect(execute).toHaveBeenCalledTimes(1)
    expect(execute.mock.calls[0][1]).toEqual(['kill-session', '-t', '$2'])
    expect(remove).not.toHaveBeenCalled()
  })

  it('keeps the tmux session when linked worktree preparation fails', async () => {
    const execute = vi.fn<TmuxProcessExecutor>().mockResolvedValue({ stdout: '', stderr: '' })
    const api = new SessionManagementApi({
      actions: new TmuxSessionActions(execute, {}),
      currentSessions: () => [{ id: '$1', name: 'work' }],
      currentWindowIds: () => [],
      prepareSessionWorktreeDeletion: vi.fn().mockRejectedValue(new SessionWorktreeConflictError('Tmux session is not tied to a git worktree')),
    })
    const baseUrl = await startApi(api)

    const response = await fetch(`${baseUrl}/api/session-management/sessions/%241/delete`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirmSessionId: '$1', deleteWorktree: true }),
    })

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({ error: expect.stringMatching(/not tied to a git worktree/i) })
    expect(execute).not.toHaveBeenCalled()
  })

  it('reports operational worktree preparation failures as upstream errors', async () => {
    const execute = vi.fn<TmuxProcessExecutor>().mockResolvedValue({ stdout: '', stderr: '' })
    const api = new SessionManagementApi({
      actions: new TmuxSessionActions(execute, {}),
      currentSessions: () => [{ id: '$1', name: 'work' }],
      currentWindowIds: () => [],
      prepareSessionWorktreeDeletion: vi.fn().mockRejectedValue(new Error('tmux discovery failed')),
    })
    const baseUrl = await startApi(api)

    const response = await fetch(`${baseUrl}/api/session-management/sessions/%241/delete`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirmSessionId: '$1', deleteWorktree: true }),
    })

    expect(response.status).toBe(502)
    await expect(response.json()).resolves.toMatchObject({ error: 'tmux discovery failed' })
    expect(execute).not.toHaveBeenCalled()
  })

  it('reports partial completion when worktree removal fails after tmux closes', async () => {
    const execute = vi.fn<TmuxProcessExecutor>().mockResolvedValue({ stdout: '', stderr: '' })
    const onSessionsChanged = vi.fn().mockResolvedValue(undefined)
    const api = new SessionManagementApi({
      actions: new TmuxSessionActions(execute, {}),
      currentSessions: () => [{ id: '$1', name: 'work' }],
      currentWindowIds: () => [],
      prepareSessionWorktreeDeletion: vi.fn().mockResolvedValue(
        { worktree: PLAN_WORKTREE, auxiliarySessions: [], remove: vi.fn().mockRejectedValue(new Error('worktree contains locked files')) },
      ),
      onSessionsChanged,
    })
    const baseUrl = await startApi(api)

    const response = await fetch(`${baseUrl}/api/session-management/sessions/%241/delete`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirmSessionId: '$1', deleteWorktree: true }),
    })

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringMatching(/session was deleted.*worktree was not removed.*locked files/i),
    })
    expect(execute).toHaveBeenCalled()
    expect(onSessionsChanged).toHaveBeenCalled()
  })

  it('reports completed deletion when the subsequent session refresh fails', async () => {
    const execute = vi.fn<TmuxProcessExecutor>().mockResolvedValue({ stdout: '', stderr: '' })
    const api = new SessionManagementApi({
      actions: new TmuxSessionActions(execute, {}),
      currentSessions: () => [{ id: '$1', name: 'work' }],
      currentWindowIds: () => [],
      prepareSessionWorktreeDeletion: vi.fn().mockResolvedValue({ worktree: PLAN_WORKTREE, auxiliarySessions: [], remove: vi.fn().mockResolvedValue(undefined) }),
      onSessionsChanged: vi.fn().mockRejectedValue(new Error('snapshot unavailable')),
    })
    const baseUrl = await startApi(api)

    const response = await fetch(`${baseUrl}/api/session-management/sessions/%241/delete`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirmSessionId: '$1', deleteWorktree: true }),
    })

    expect(response.status).toBe(502)
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringMatching(/session and worktree were deleted.*refresh failed.*snapshot unavailable/i),
    })
    expect(execute).toHaveBeenCalled()
  })

  it('releases resize ownership and closes an existing window', async () => {
    const execute = vi.fn<TmuxProcessExecutor>().mockResolvedValue({ stdout: '', stderr: '' })
    const beforeWindowDeleted = vi.fn().mockResolvedValue(undefined)
    const onSessionsChanged = vi.fn().mockResolvedValue(undefined)
    const api = new SessionManagementApi({
      actions: new TmuxSessionActions(execute, { COMMANDO_TMUX_SOCKET_NAME: 'qa' }),
      currentSessions: () => [{ id: '$1', name: 'work' }],
      currentWindowIds: () => ['@7'],
      beforeWindowDeleted,
      onSessionsChanged,
    })
    const baseUrl = await startApi(api)

    const response = await fetch(`${baseUrl}/api/session-management/windows/%407/delete`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirmWindowId: '@7' }),
    })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ ok: true, windowId: '@7' })
    expect(beforeWindowDeleted).toHaveBeenCalledWith('@7')
    expect(execute).toHaveBeenCalledWith(
      'tmux',
      ['-L', 'qa', 'kill-window', '-t', '@7'],
      expect.objectContaining({ shell: false, timeout: 3_000 }),
    )
    expect(onSessionsChanged).toHaveBeenCalled()
  })

  it('requires the exact window confirmation id', async () => {
    const execute = vi.fn<TmuxProcessExecutor>().mockResolvedValue({ stdout: '', stderr: '' })
    const api = new SessionManagementApi({
      actions: new TmuxSessionActions(execute, {}),
      currentSessions: () => [{ id: '$1', name: 'work' }],
      currentWindowIds: () => ['@7'],
    })
    const baseUrl = await startApi(api)

    const response = await fetch(`${baseUrl}/api/session-management/windows/%407/delete`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirmWindowId: '@8' }),
    })

    expect(response.status).toBe(400)
    expect(execute).not.toHaveBeenCalled()
  })
})

describe('session grouping mode preference', () => {
  const base = { version: 1 as const, groups: [], ungroupedSessionIds: ['$1'] }

  it('accepts repository or manual and rejects anything else', () => {
    expect(parseSessionTreePreferences({ ...base, groupingMode: 'repository' })?.groupingMode).toBe('repository')
    expect(parseSessionTreePreferences({ ...base, groupingMode: 'manual' })?.groupingMode).toBe('manual')
    expect(parseSessionTreePreferences({ ...base, groupingMode: 'by-color' })).toBeNull()
  })

  it('is optional and omitted from the parsed shape when absent', () => {
    expect(parseSessionTreePreferences(base)).toEqual(base)
  })

  it('survives reconciliation and the visible projection', () => {
    const sessions = [{ id: '$1', name: 'work' }]
    const reconciled = reconcileSessionTreePreferences({ ...base, groupingMode: 'manual' }, sessions)
    expect(reconciled.groupingMode).toBe('manual')
    expect(visibleSessionTreePreferences(reconciled, sessions).groupingMode).toBe('manual')
  })
})
