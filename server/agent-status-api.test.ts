import { association } from './cursor-hook-test-fixtures.js'
import { createServer, type Server } from 'node:http'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentInteractionBroker } from './agent-interaction-broker.js'
import { AgentStatusHookApi } from './agent-status-api.js'
import { AgentStatusRegistry, type AgentStatusChange } from './agent-status-registry.js'

const token = 'agent-hook-token-that-is-at-least-32-characters'
let server: Server
let baseUrl: string
let changes: AgentStatusChange[]
let interactions: AgentInteractionBroker
let registry: AgentStatusRegistry

beforeEach(async () => {
  changes = []
  interactions = new AgentInteractionBroker()
  registry = new AgentStatusRegistry()
  const api = new AgentStatusHookApi({
    token,
    registry,
    verifyCursorAssociation: async () => association,
    cursorAssociationCurrent: async () => true,
    paneExists: (paneId) => paneId === '%1',
    paneCommand: () => 'opencode',
    onChange: (change) => changes.push(change),
    interactions,
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

  it('accepts authenticated Codex turn callbacks', async () => {
    const response = await post('/api/agent-status/hooks/codex', {
      event: {
        type: 'agent-turn-complete',
        'turn-id': 'turn-1',
        'thread-id': 'thread-1',
        'input-messages': ['Ship the release'],
        'last-assistant-message': '🟢 Released 1.2.0',
      },
      receivedAt: 100,
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true, changed: true })
    expect(registry.get('%1')).toMatchObject({
      provider: 'codex',
      agentSessionId: 'thread-1',
      status: 'done',
      source: 'hook',
      confidence: 'high',
      summary: 'Released 1.2.0',
      updatedAt: 123,
    })
    expect(changes).toHaveLength(1)
  })

  it('rejects malformed Codex bodies and reports unknown Codex events as unchanged', async () => {
    expect((await post('/api/agent-status/hooks/codex', {})).status).toBe(400)
    expect((await post('/api/agent-status/hooks/codex', { event: [] })).status).toBe(400)
    expect((await post('/api/agent-status/hooks/codex', { event: { type: 42 } })).status).toBe(400)

    const unknown = await post('/api/agent-status/hooks/codex', {
      event: { type: 'approval-requested' },
    })

    expect(unknown.status).toBe(200)
    expect(await unknown.json()).toEqual({ ok: true, changed: false })
    expect(registry.values()).toEqual([])
  })

  it('clears an OpenCode question when the provider answers it elsewhere', async () => {
    interactions.registerConsumer()
    const asked = post('/api/agent-status/hooks/opencode', {
      directory: '/workspace',
      event: {
        type: 'question.asked',
        properties: {
          sessionID: 'ses_1',
          id: 'question-1',
          attention: 'Which target?',
          request: {
            id: 'question-1',
            kind: 'question',
            prompt: 'Which target?',
            questions: [{
              header: 'Target',
              question: 'Which target?',
              options: [{ label: 'Production' }],
              multiple: false,
              custom: false,
            }],
          },
        },
      },
    })
    await vi.waitFor(() => expect(interactions.hasPending('%1', 'question-1')).toBe(true))

    const replied = await post('/api/agent-status/hooks/opencode', {
      directory: '/workspace',
      event: {
        type: 'question.replied',
        properties: { sessionID: 'ses_1', requestID: 'question-1' },
      },
    })

    expect(replied.status).toBe(200)
    expect(await asked.then((response) => response.json())).toEqual({ ok: true, changed: true })
    expect(interactions.hasPending('%1', 'question-1')).toBe(false)
    expect(registry.get('%1')).toMatchObject({ status: 'working' })
    expect(registry.get('%1')?.details?.requests).toBeUndefined()
  })

  it('does not resurrect an OpenCode question when its reply arrives first', async () => {
    interactions.registerConsumer()
    await post('/api/agent-status/hooks/opencode', {
      directory: '/workspace',
      event: {
        type: 'question.replied',
        properties: { sessionID: 'ses_1', requestID: 'question-1' },
      },
    })

    const asked = await post('/api/agent-status/hooks/opencode', {
      directory: '/workspace',
      event: {
        type: 'question.asked',
        properties: {
          sessionID: 'ses_1',
          id: 'question-1',
          attention: 'Which target?',
          request: {
            id: 'question-1',
            kind: 'question',
            prompt: 'Which target?',
            questions: [],
          },
        },
      },
    })

    expect(await asked.json()).toEqual({ ok: true, changed: false })
    expect(interactions.hasPending('%1', 'question-1')).toBe(false)
    expect(registry.get('%1')?.details?.requests).toBeUndefined()
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

describe('authenticated Cursor native route', () => {
  const native = (event: string, patch: Record<string, unknown> = {}) => ({
    hook_event_name: event, conversation_id: 'cursor-conversation', generation_id: event === 'sessionStart' || event === 'sessionEnd' ? 'cursor-conversation' : 'generation-1', ...patch,
  })
  it('requires auth, validates conversation/generation/status and rejects aliases', async () => {
    expect((await post('/api/agent-status/hooks/cursor', native('beforeSubmitPrompt'), { token: 'wrong' })).status).toBe(401)
    expect((await post('/api/agent-status/hooks/agent', native('beforeSubmitPrompt'))).status).toBe(404)
    for (const invalid of [native('stop', { status: 'idle' }), native('preToolUse', { generation_id: '' }), native('afterAgentThought'), native('stop', { status: 'completed', conversation_id: 'bad;id' })]) {
      expect((await post('/api/agent-status/hooks/cursor', invalid)).status).toBe(400)
    }
    const response = await post('/api/agent-status/hooks/cursor', native('beforeSubmitPrompt', { intent: 'Fix tests' }))
    expect(response.status).toBe(200)
    expect(registry.get('%1')).toMatchObject({ provider: 'cursor', source: 'hook', status: 'working', details: { intent: 'Fix tests' } })
  })
  it.each(['native-first', 'imported-first', 'interleaved'])('owns one status/recap stream without held imported interactions: %s', async (ordering) => {
    const imported = { hook_event_name: 'PreToolUse', session_id: 'cursor-conversation', conversation_id: 'cursor-conversation', cursor_version: '2026.10.01',
      tool_name: 'AskUserQuestion', request: { id: 'must-not-wait', kind: 'question', prompt: 'Wrong question' } }
    const ignoreImported = async () => {
      const response = await post('/api/agent-status/hooks/claude', imported)
      expect(await response.json()).toEqual({ ok: true, changed: false })
    }
    if (ordering === 'imported-first') await ignoreImported()
    await post('/api/agent-status/hooks/cursor', native('beforeSubmitPrompt'))
    await ignoreImported()
    if (ordering === 'interleaved') await ignoreImported()
    await post('/api/agent-status/hooks/cursor', native('afterAgentResponse', { finalMessage: '🟢 One result' }))
    await post('/api/agent-status/hooks/cursor', native('stop', { status: 'completed' }))
    await ignoreImported()
    await post('/api/agent-status/hooks/cursor', native('stop', { status: 'completed' }))
    expect(changes.filter((change) => change?.type === 'upsert' && change.status.details?.recap)).toHaveLength(1)
    expect(registry.get('%1')).toMatchObject({ provider: 'cursor', status: 'done', details: { recap: { summary: 'One result' } } })
    expect(registry.get('%1')?.details?.requests).toBeUndefined()
  })
  it('rejects oversized bodies and nonexistent panes', async () => {
    expect((await post('/api/agent-status/hooks/cursor', native('beforeSubmitPrompt'), { paneId: '%9' })).status).toBe(404)
    expect((await post('/api/agent-status/hooks/cursor', native('beforeSubmitPrompt', { intent: 'x'.repeat(70_000) }))).status).toBe(413)
  })
})

describe('chat panes', () => {
  it('neither holds nor records PermissionRequest prompts that the chat host answers itself', async () => {
    const chatRegistry = new AgentStatusRegistry()
    const chatInteractions = new AgentInteractionBroker()
    const release = chatInteractions.registerConsumer()
    const api = new AgentStatusHookApi({
      token,
      registry: chatRegistry,
      paneExists: (paneId) => paneId === '%1',
      paneCommand: () => 'node',
      onChange: () => {},
      interactions: chatInteractions,
      chatOwnsPane: () => true,
      now: () => 123,
    })
    const chatServer = createServer((request, response) => {
      void api.handle(request, response, new URL(request.url ?? '/', 'http://127.0.0.1'))
    })
    await new Promise<void>((resolve) => chatServer.listen(0, '127.0.0.1', resolve))
    const address = chatServer.address()
    if (!address || typeof address === 'string') throw new Error('Test server did not bind')
    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/api/agent-status/hooks/claude`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'X-Commando-Pane': '%1' },
        body: JSON.stringify({
          hook_event_name: 'PermissionRequest',
          session_id: 'session-1',
          tool_name: 'Edit',
          attention: 'Allow Edit?',
          request: { id: 'request-1', kind: 'permission', prompt: 'Allow Edit?', toolName: 'Edit' },
        }),
        signal: AbortSignal.timeout(2_000),
      })
      expect(await response.json()).toEqual({ ok: true, changed: true })
      expect(chatRegistry.get('%1')?.details?.requests ?? []).toEqual([])
      expect(chatInteractions.hasPending('%1', 'request-1')).toBe(false)
    } finally {
      release()
      await new Promise<void>((resolve) => chatServer.close(() => resolve()))
    }
  })
})
