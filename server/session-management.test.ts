import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  parseSessionTreePreferences,
  reconcileSessionTreePreferences,
  SessionPreferenceStore,
} from './session-preferences.js'
import { SessionManagementApi } from './session-management-api.js'
import { TmuxSessionActions, type TmuxProcessExecutor } from './tmux-session-actions.js'

const directories: string[] = []
const servers: Server[] = []

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
    }

    expect(reconcileSessionTreePreferences(preferences, [
      { id: '$1', name: 'scratch' },
      { id: '$2', name: 'vivi-app' },
      { id: '$3', name: 'gizmo-web' },
      { id: '$4', name: 'gizmo-api' },
    ])).toEqual({
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
    })
  })

  it('serializes private persistent preferences', async () => {
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
    ])
    expect(saved.ungroupedSessionIds).toEqual(['$2'])
    expect(saved.sessionNamesById).toEqual({ '$1': 'work', '$2': 'other' })
    await expect(new SessionPreferenceStore(path).load([
      { id: '$1', name: 'work' },
      { id: '$2', name: 'other' },
    ])).resolves.toEqual(saved)
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(saved)

    const partialRestore = await new SessionPreferenceStore(path).load([
      { id: '$1', name: 'other' },
    ])
    expect(partialRestore).toEqual({
      version: 1,
      groups: [{ id: 'work', name: 'Work', sessionIds: ['$1'] }],
      ungroupedSessionIds: [],
      sessionNamesById: { '$1': 'work' },
    })
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(saved)

    const restored = await new SessionPreferenceStore(path).load([
      { id: '$1', name: 'other' },
      { id: '$2', name: 'work' },
    ])
    expect(restored).toEqual({
      version: 1,
      groups: [{ id: 'work', name: 'Work', sessionIds: ['$2'] }],
      ungroupedSessionIds: ['$1'],
      sessionNamesById: { '$1': 'other', '$2': 'work' },
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
