import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionManagementApi } from './session-management-api.js'
import { SessionPreferenceStore } from './session-preferences.js'
import { TmuxSessionActions } from './tmux-session-actions.js'

let folder: string
beforeEach(async () => { folder = await mkdtemp(join(tmpdir(), 'commando-identity-api-')) })
afterEach(async () => { await rm(folder, { recursive: true, force: true }) })

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
