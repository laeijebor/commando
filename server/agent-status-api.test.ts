import { createServer, type Server } from 'node:http'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentStatusHookApi } from './agent-status-api.js'
import { AgentStatusRegistry, type AgentStatusChange } from './agent-status-registry.js'

const token = 'agent-hook-token-that-is-at-least-32-characters'
let server: Server
let baseUrl: string
let changes: AgentStatusChange[]
let registry: AgentStatusRegistry

beforeEach(async () => {
  changes = []
  registry = new AgentStatusRegistry()
  const api = new AgentStatusHookApi({
    token,
    registry,
    paneExists: (paneId) => paneId === '%1',
    paneCommand: () => 'opencode',
    onChange: (change) => changes.push(change),
    now: () => 123,
  })
  server = createServer((request, response) => {
    void api.handle(request, response, new URL(request.url ?? '/', 'http://127.0.0.1'))
      .then((handled) => {
        if (!handled) {
          response.statusCode = 404
          response.end()
        }
      })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Test server did not bind')
  baseUrl = `http://127.0.0.1:${address.port}`
})

afterEach(async () => {
  vi.restoreAllMocks()
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
})

function post(path: string, body: unknown, options: { token?: string; paneId?: string } = {}) {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${options.token ?? token}`,
      'Content-Type': 'application/json',
      'X-Commando-Pane': options.paneId ?? '%1',
    },
    body: JSON.stringify(body),
  })
}

describe('AgentStatusHookApi', () => {
  it('accepts authenticated Claude hook events', async () => {
    const response = await post('/api/agent-status/hooks/claude', {
      hook_event_name: 'UserPromptSubmit',
      session_id: 'claude-session',
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true, changed: true })
    expect(registry.get('%1')).toMatchObject({
      provider: 'claude',
      status: 'working',
      source: 'hook',
      updatedAt: 123,
    })
    expect(changes).toHaveLength(1)
  })

  it('accepts authenticated OpenCode events', async () => {
    const response = await post('/api/agent-status/hooks/opencode', {
      directory: '/workspace',
      event: {
        type: 'session.status',
        properties: { sessionID: 'ses_1', status: { type: 'busy' } },
      },
    })

    expect(response.status).toBe(200)
    expect(registry.get('%1')).toMatchObject({ provider: 'opencode', status: 'working' })
  })

  it('rejects invalid credentials, pane ids, and unknown panes', async () => {
    expect((await post('/api/agent-status/hooks/claude', {}, { token: 'wrong-token' })).status).toBe(401)
    expect((await post('/api/agent-status/hooks/claude', {}, { paneId: '1' })).status).toBe(400)
    expect((await post('/api/agent-status/hooks/claude', {}, { paneId: '%2' })).status).toBe(404)
    expect(registry.values()).toEqual([])
  })

  it('rejects malformed payloads and unsupported methods', async () => {
    const malformedClaude = await post('/api/agent-status/hooks/claude', { session_id: 'session' })
    const malformedOpenCode = await post('/api/agent-status/hooks/opencode', { event: {} })
    const method = await fetch(`${baseUrl}/api/agent-status/hooks/claude`, {
      headers: { Authorization: `Bearer ${token}` },
    })

    expect(malformedClaude.status).toBe(400)
    expect(malformedOpenCode.status).toBe(400)
    expect(method.status).toBe(405)
    expect(method.headers.get('allow')).toBe('POST')
  })

  it('does not claim unrelated API paths', async () => {
    expect((await post('/api/other', {})).status).toBe(404)
  })
})
