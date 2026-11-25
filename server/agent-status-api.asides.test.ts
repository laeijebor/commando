import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import { AgentStatusHookApi } from './agent-status-api.js'
import { AgentStatusRegistry } from './agent-status-registry.js'

describe('aside hook status filtering', () => {
  it('ignores known aside session ids before status or PR updates, while main hooks still work', async () => {
    const registry = new AgentStatusRegistry()
    const changed = vi.fn()
    const pulls = vi.fn()
    const api = new AgentStatusHookApi({ token: 'a'.repeat(40), registry, paneExists: () => true, paneCommand: () => 'node',
      onChange: changed, onPullRequestsCreated: pulls, chatOwnsPane: () => true,
      chatAsideSession: (pane, session) => pane === '%1' && session === 'aside-session' })
    const run = async (sessionId: string) => {
      const request = Readable.from([JSON.stringify({ hook_event_name: 'SessionStart', session_id: sessionId })]) as IncomingMessage
      request.method = 'POST'
      request.headers = { authorization: `Bearer ${'a'.repeat(40)}`, 'content-type': 'application/json', 'x-commando-pane': '%1' }
      let body = ''
      const response = { setHeader: vi.fn(), writeHead: vi.fn(), end: (text: string) => { body = text } } as unknown as ServerResponse
      await api.handle(request, response, new URL('http://localhost/api/agent-status/hooks/claude'))
      return JSON.parse(body) as { ok: boolean; changed: boolean }
    }
    expect(await run('aside-session')).toEqual({ ok: true, changed: false })
    expect(registry.get('%1')).toBeUndefined()
    expect(changed).not.toHaveBeenCalled()
    expect(pulls).not.toHaveBeenCalled()
    expect((await run('main-session')).changed).toBe(true)
    expect(changed).toHaveBeenCalledOnce()
  })
})
