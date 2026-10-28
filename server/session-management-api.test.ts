import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionManagementApi } from './session-management-api.js'
import { SessionPreferenceStore } from './session-preferences.js'
import type { SessionBrief } from '../shared/protocol.js'
import { SessionBriefStore } from './session-briefs.js'
import { TmuxSessionActions, type TmuxProcessExecutor } from './tmux-session-actions.js'

let folder: string
beforeEach(async () => { folder = await mkdtemp(join(tmpdir(), 'commando-identity-api-')) })
afterEach(async () => {
  vi.restoreAllMocks()
  await rm(folder, { recursive: true, force: true })
})

// Exercise the HTTP handler directly: no listening socket or shared daemon.
async function request(api: SessionManagementApi, path: string, method: string, body?: unknown) {
  const incoming = Object.assign(Readable.from(body === undefined ? [] : [JSON.stringify(body)]), {
    method, headers: { 'content-type': 'application/json' },
  }) as IncomingMessage
  let status = 0
  let result = ''
  const response = {
    setHeader() {},
    writeHead(code: number) { status = code },
    end(value: string) { result = value },
  } as unknown as ServerResponse
  await api.handle(incoming, response, new URL(`/api/session-management${path}`, 'http://localhost'))
  return { status, body: JSON.parse(result) }
}
function setup() {
  const preferences = new SessionPreferenceStore(join(folder, 'session-tree.json'))
  const sessions = [{ id: '$1', name: 'Chat' }]
  const rename = vi.fn(async (_id: string, name: string) => { sessions[0].name = name })
  const actions = new TmuxSessionActions()
  actions.rename = rename
  const api = new SessionManagementApi({ preferences, actions, currentSessions: () => sessions, currentWindowIds: () => [] })
  return { api, preferences, rename }
}

describe('session identity HTTP API', () => {
  it('assigns live and historical names through the preferences channel', async () => {
    const { api } = setup()
    const live = await request(api, '/preferences', 'GET')
    expect(live.status).toBe(200)
    expect(live.body.preferences.sessionIdentities.Chat.glyph).toBe('💬')
    const historical = await request(api, '/identities', 'POST', { names: ['Subscriptions'] })
    expect(historical.status).toBe(200)
    expect(historical.body.preferences.sessionIdentities.Subscriptions.glyph).toBe('💷')
    expect(historical.body.preferences.sessionIdentities.Chat).toEqual(live.body.preferences.sessionIdentities.Chat)
  })
  it('validates emoji, changes and resets glyphs, and moves the identity after rename', async () => {
    const { api, preferences, rename } = setup()
    expect((await request(api, '/sessions/%241/identity', 'POST', { glyph: 'two words' })).status).toBe(400)
    const custom = await request(api, '/sessions/%241/identity', 'POST', { glyph: '👨‍👩‍👧‍👦' })
    expect(custom.status).toBe(200)
    expect(custom.body.preferences.sessionIdentities.Chat.glyphSource).toBe('user')
    const renamed = await request(api, '/sessions/%241/rename', 'POST', { name: 'Billing' })
    expect(renamed.status).toBe(200)
    expect(rename).toHaveBeenCalledWith('$1', 'Billing')
    const identities = (await preferences.load()).sessionIdentities
    expect(identities?.Billing).toEqual(custom.body.preferences.sessionIdentities.Chat)
    expect(identities?.Chat).toBeUndefined()
    const reset = await request(api, '/sessions/%241/identity', 'POST', { reset: true })
    expect(reset.body.preferences.sessionIdentities.Billing).toMatchObject({ glyph: '💷', glyphSource: 'auto' })
  })
  it('rejects malformed assignment requests and unknown sessions', async () => {
    const { api } = setup()
    for (const names of [null, [123], [''], Array(501).fill('Chat')]) {
      expect((await request(api, '/identities', 'POST', { names })).status).toBe(400)
    }
    expect((await request(api, '/sessions/%249/identity', 'POST', { reset: true })).status).toBe(404)
    expect((await request(api, '/identities', 'GET')).status).toBe(405)
  })
})

describe('session rename API', () => {
  it.each(['identity', 'brief', 'both'] as const)('still refreshes and succeeds when %s bookkeeping fails', async (failure) => {
    const preferences = new SessionPreferenceStore(join(folder, 'session-tree.json'))
    const identityError = new Error('Preferences are not writable')
    const briefError = new Error('Briefs are not writable')
    const renameIdentity = vi.spyOn(preferences, 'renameIdentity')
    if (failure !== 'brief') renameIdentity.mockRejectedValue(identityError)
    const afterSessionRenamed = vi.fn(async () => {
      if (failure !== 'identity') throw briefError
    })
    const onSessionsChanged = vi.fn()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const execute = vi.fn<TmuxProcessExecutor>().mockResolvedValue({ stdout: '', stderr: '' })
    const api = new SessionManagementApi({
      preferences,
      actions: new TmuxSessionActions(execute, { COMMANDO_TMUX_SOCKET_NAME: 'rename-test' }),
      currentSessions: () => [{ id: '$1', name: 'original' }], currentWindowIds: () => [],
      afterSessionRenamed, onSessionsChanged,
    })

    expect(await request(api, '/sessions/%241/rename', 'POST', { name: 'renamed' })).toEqual({
      status: 200, body: { ok: true, sessionId: '$1', name: 'renamed' },
    })
    expect(execute).toHaveBeenCalledOnce()
    expect(renameIdentity).toHaveBeenCalledWith('original', 'renamed', '$1', undefined)
    expect(afterSessionRenamed).toHaveBeenCalledWith('$1', 'original', 'renamed')
    expect(onSessionsChanged).toHaveBeenCalledOnce()
    expect(execute.mock.invocationCallOrder[0]).toBeLessThan(renameIdentity.mock.invocationCallOrder[0]!)
    expect(renameIdentity.mock.invocationCallOrder[0]).toBeLessThan(afterSessionRenamed.mock.invocationCallOrder[0]!)
    expect(afterSessionRenamed.mock.invocationCallOrder[0]).toBeLessThan(onSessionsChanged.mock.invocationCallOrder[0]!)
    if (failure !== 'brief') {
      expect(warn).toHaveBeenCalledWith('[commando] Session identity move failed after session rename', identityError)
    }
    if (failure !== 'identity') {
      expect(warn).toHaveBeenCalledWith('[commando] Session brief update failed after session rename', briefError)
    }
  })

  it('persists detached ownership before refreshing sessions using the previous live name', async () => {
    const path = join(folder, 'briefs.json')
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
      preferences: new SessionPreferenceStore(join(folder, 'session-tree.json')),
      actions: new TmuxSessionActions(execute, { COMMANDO_TMUX_SOCKET_NAME: 'rename-test' }),
      currentSessions: () => [{ id: '$1', name: 'original' }], currentWindowIds: () => [],
      afterSessionRenamed, onSessionsChanged,
    })

    expect(await request(api, '/sessions/%241/rename', 'POST', { name: 'renamed' })).toEqual({ status: 200, body: { ok: true, sessionId: '$1', name: 'renamed' } })
    expect(afterSessionRenamed).toHaveBeenCalledWith('$1', 'original', 'renamed')
    expect(execute.mock.invocationCallOrder[0]).toBeLessThan(afterSessionRenamed.mock.invocationCallOrder[0]!)
    expect(afterSessionRenamed.mock.invocationCallOrder[0]).toBeLessThan(onSessionsChanged.mock.invocationCallOrder[0]!)
  })

  it('does not rewrite history when tmux rejects the rename', async () => {
    const preferences = new SessionPreferenceStore(join(folder, 'session-tree.json'))
    const renameIdentity = vi.spyOn(preferences, 'renameIdentity')
    const execute = vi.fn<TmuxProcessExecutor>().mockRejectedValue(new Error('Rename failed'))
    const afterSessionRenamed = vi.fn()
    const onSessionsChanged = vi.fn()
    const api = new SessionManagementApi({
      preferences,
      actions: new TmuxSessionActions(execute, { COMMANDO_TMUX_SOCKET_NAME: 'rename-test' }),
      currentSessions: () => [{ id: '$1', name: 'original' }], currentWindowIds: () => [],
      afterSessionRenamed, onSessionsChanged,
    })
    expect((await request(api, '/sessions/%241/rename', 'POST', { name: 'renamed' })).status).toBe(502)
    expect(renameIdentity).not.toHaveBeenCalled()
    expect(afterSessionRenamed).not.toHaveBeenCalled()
    expect(onSessionsChanged).not.toHaveBeenCalled()
  })
})
