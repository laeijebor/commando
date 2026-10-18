import type { IncomingMessage, ServerResponse } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionBrief } from '../shared/protocol.js'
import { SessionBriefStore } from './session-briefs.js'
import { SessionManagementApi } from './session-management-api.js'
import { TmuxSessionActions, type TmuxProcessExecutor } from './tmux-session-actions.js'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function rename(api: SessionManagementApi) {
  const request = Object.assign(Readable.from([Buffer.from(JSON.stringify({ name: 'renamed' }))]), {
    method: 'POST', headers: { 'content-type': 'application/json' },
  }) as IncomingMessage
  const writeHead = vi.fn()
  const end = vi.fn()
  const response = { writeHead, end } as unknown as ServerResponse
  expect(await api.handle(request, response, new URL('http://localhost/api/session-management/sessions/%241/rename'))).toBe(true)
  return { status: writeHead.mock.calls[0]![0], body: JSON.parse(end.mock.calls[0]![0] as string) as unknown }
}

describe('session rename API', () => {
  it('persists detached ownership before refreshing sessions using the previous live name', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'commando-session-rename-'))
    directories.push(directory)
    const path = join(directory, 'briefs.json')
    const target = '550e8400-e29b-41d4-a716-446655440000'
    const reusedTarget = '6ba7b810-9dad-41d1-80b4-00c04fd430c8'
    const closed: SessionBrief = { paneId: '%1', targetId: target, sessionId: '$1', sessionName: 'original',
      headline: 'Closed chat', headlineSource: 'agent', state: 'done', updates: [], updatedAt: 100,
      agentSession: { provider: 'claude', id: 'closed-conversation' } }
    await writeFile(path, JSON.stringify({ version: 4, briefs: {}, detached: {
      [target]: closed,
      [reusedTarget]: { ...closed, targetId: reusedTarget, sessionName: 'previous-server',
        agentSession: { provider: 'codex', id: 'unrelated-conversation' } },
    } }))
    const briefs = new SessionBriefStore(path)
    await briefs.load()
    const execute = vi.fn<TmuxProcessExecutor>().mockResolvedValue({ stdout: '', stderr: '' })
    const afterSessionRenamed = vi.fn(async (id: string, previousName: string, name: string) => {
      await briefs.renameSession(id, previousName, name)
    })
    const onSessionsChanged = vi.fn(async () => {
      const replay = new SessionBriefStore(path)
      await replay.load()
      expect(replay.conversationRecords().map(({ sessionName }) => sessionName)).toEqual(['renamed', 'previous-server'])
    })
    const api = new SessionManagementApi({
      actions: new TmuxSessionActions(execute, { COMMANDO_TMUX_SOCKET_NAME: 'rename-test' }),
      currentSessions: () => [{ id: '$1', name: 'original' }], currentWindowIds: () => [],
      afterSessionRenamed, onSessionsChanged,
    })

    expect(await rename(api)).toEqual({ status: 200, body: { ok: true, sessionId: '$1', name: 'renamed' } })
    expect(afterSessionRenamed).toHaveBeenCalledWith('$1', 'original', 'renamed')
    expect(execute.mock.invocationCallOrder[0]).toBeLessThan(afterSessionRenamed.mock.invocationCallOrder[0]!)
    expect(afterSessionRenamed.mock.invocationCallOrder[0]).toBeLessThan(onSessionsChanged.mock.invocationCallOrder[0]!)
  })

  it('does not rewrite history when tmux rejects the rename', async () => {
    const execute = vi.fn<TmuxProcessExecutor>().mockRejectedValue(new Error('Rename failed'))
    const afterSessionRenamed = vi.fn()
    const onSessionsChanged = vi.fn()
    const api = new SessionManagementApi({
      actions: new TmuxSessionActions(execute, { COMMANDO_TMUX_SOCKET_NAME: 'rename-test' }),
      currentSessions: () => [{ id: '$1', name: 'original' }], currentWindowIds: () => [],
      afterSessionRenamed, onSessionsChanged,
    })
    expect((await rename(api)).status).toBe(502)
    expect(afterSessionRenamed).not.toHaveBeenCalled()
    expect(onSessionsChanged).not.toHaveBeenCalled()
  })
})
