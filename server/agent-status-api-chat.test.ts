import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { expect, it, vi } from 'vitest'
import { AgentStatusHookApi } from './agent-status-api.js'
import { AgentStatusRegistry } from './agent-status-registry.js'

it('ignores native Cursor hooks for a Cursor chat pane with no hook association', async () => {
  const token = 'agent-hook-token-that-is-at-least-32-characters'
  const registry = new AgentStatusRegistry()
  registry.applyChatHost('%1', { provider: 'cursor', sessionId: 'agent-12345678-0000', status: 'working' }, 1)
  const onChange = vi.fn()
  const verifyCursorAssociation = vi.fn()
  const api = new AgentStatusHookApi({
    token, registry, chatOwnsPane: () => true, paneExists: () => true,
    paneCommand: () => 'node', onChange, verifyCursorAssociation,
  })
  const request = Readable.from([Buffer.from(JSON.stringify({ hook_event_name: 'stop', conversation_id: 'native-tui-session', status: 'completed' }))]) as IncomingMessage
  request.method = 'POST'
  request.headers = { authorization: `Bearer ${token}`, 'x-commando-pane': '%1', 'content-type': 'application/json' }
  const writeHead = vi.fn()
  const end = vi.fn()
  const response = { writeHead, end, setHeader: vi.fn() } as unknown as ServerResponse
  expect(await api.handle(request, response, new URL('http://localhost/api/agent-status/hooks/cursor'))).toBe(true)
  expect(writeHead).toHaveBeenCalledWith(200, expect.any(Object))
  expect(JSON.parse(end.mock.calls[0]![0])).toEqual({ ok: true, changed: false })
  expect(verifyCursorAssociation).not.toHaveBeenCalled()
  expect(registry.get('%1')).toMatchObject({ provider: 'cursor', agentSessionId: 'agent-12345678-0000', status: 'working' })
  expect(registry.cursorAssociation('%1')).toBeNull()
  expect(onChange).not.toHaveBeenCalled()
})
