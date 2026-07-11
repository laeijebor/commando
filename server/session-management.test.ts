import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  parseSessionTreePreferences,
  reconcileSessionTreePreferences,
  SessionPreferenceStore,
} from './session-preferences.js'
import { TmuxSessionActions, type TmuxProcessExecutor } from './tmux-session-actions.js'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('session tree preferences', () => {
  it('validates uniqueness and reconciles new sessions without discarding hidden history', () => {
    const preferences = {
      version: 1 as const,
      groups: [{ id: 'work', name: 'Work', sessionIds: ['$1'] }],
      ungroupedSessionIds: ['$2'],
    }
    expect(parseSessionTreePreferences(preferences)).toEqual(preferences)
    expect(parseSessionTreePreferences({ ...preferences, ungroupedSessionIds: ['$1'] })).toBeNull()
    expect(reconcileSessionTreePreferences(preferences, ['$3', '$1'])).toEqual({
      ...preferences,
      ungroupedSessionIds: ['$2', '$3'],
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
    }, ['$1', '$2'])
    expect(saved.ungroupedSessionIds).toEqual(['$2'])
    await expect(new SessionPreferenceStore(path).load(['$1', '$2'])).resolves.toEqual(saved)
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(saved)
  })
})

describe('tmux session actions', () => {
  it('uses fixed argv and the configured socket for rename and delete', async () => {
    const execute = vi.fn<TmuxProcessExecutor>().mockResolvedValue({ stdout: '', stderr: '' })
    const actions = new TmuxSessionActions(execute, { COMMANDO_TMUX_SOCKET_NAME: 'qa' })
    await actions.rename('$12', 'renamed')
    await actions.delete('$12')
    expect(execute.mock.calls.map((call) => call[1])).toEqual([
      ['-L', 'qa', 'rename-session', '-t', '$12', 'renamed'],
      ['-L', 'qa', 'kill-session', '-t', '$12'],
    ])
    expect(execute.mock.calls[0][2]).toMatchObject({ shell: false, timeout: 3_000 })
  })

  it('rejects invalid identifiers and names before executing tmux', async () => {
    const execute = vi.fn<TmuxProcessExecutor>().mockResolvedValue({ stdout: '', stderr: '' })
    const actions = new TmuxSessionActions(execute, {})
    await expect(actions.rename('qa', 'name')).rejects.toThrow('Invalid tmux session id')
    await expect(actions.rename('$1', 'bad:name')).rejects.toThrow('unsupported characters')
    expect(execute).not.toHaveBeenCalled()
  })
})
