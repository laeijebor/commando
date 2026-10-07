import { verifyCursorHookAssociation, type CursorHookAssociation, type CursorOwnershipIO } from './cursor-hook-ownership.js'
import { association } from './cursor-hook-test-fixtures.js'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import type { AgentStatusKind } from '../shared/protocol.js'
import { AgentInteractionBroker } from './agent-interaction-broker.js'
import { AgentStatusHookApi } from './agent-status-api.js'
import { AgentStatusRegistry, type AgentStatusChange } from './agent-status-registry.js'
import { buildNotification, type PushNotification } from './push-notifier.js'

const token = 'cursor-hook-test-token-that-is-long-enough'
const native = (event: string, patch: Record<string, unknown> = {}) => ({
  hook_event_name: event, conversation_id: 'conv-abcdefgh', generation_id: event === 'sessionStart' || event === 'sessionEnd' ? 'conv-abcdefgh' : 'gen-1', ...patch,
})

// Exercise the actual API handler/body stream without binding a socket.
function harness(command = 'node', options: { verify?: (pane: string, body: Record<string, unknown>) => Promise<CursorHookAssociation | null> } = {}) {
  const registry = new AgentStatusRegistry()
  const interactions = new AgentInteractionBroker()
  const wait = vi.spyOn(interactions, 'wait')
  const changes: AgentStatusChange[] = []
  const notifications: PushNotification[] = []
  let previous: AgentStatusKind | undefined
  let now = 0
  let currentAssociation = association
  let foregroundVerified = command !== 'claude'
  const api = new AgentStatusHookApi({
    token, registry, interactions,
    verifyCursorAssociation: options.verify ?? (async (_pane, body) => body.association === null ? null : currentAssociation),
    cursorAssociationCurrent: async () => foregroundVerified,
    paneExists: (paneId) => paneId === '%1', paneCommand: () => command,
    now: () => ++now,
    onChange: (change) => {
      changes.push(change)
      if (change?.type !== 'upsert') return
      const notification = buildNotification(change.status, previous, { sessionId: '$1', sessionName: 'cursor-test' })
      if (notification) notifications.push(notification)
      previous = change.status.status
    },
  })
  const post = async (path: string, body: unknown, options: {
    token?: string; pane?: string; method?: string; contentType?: string; raw?: string; declaredLength?: string
  } = {}) => {
    const raw = options.raw ?? JSON.stringify(body)
    const request = Readable.from([Buffer.from(raw)]) as IncomingMessage
    request.method = options.method ?? 'POST'
    request.headers = {
      authorization: `Bearer ${options.token ?? token}`, 'x-commando-pane': options.pane ?? '%1',
      'content-type': options.contentType ?? 'application/json',
      ...(options.declaredLength ? { 'content-length': options.declaredLength } : {}),
    }
    let status = 0; let responseBody = ''
    const headers: Record<string, unknown> = {}
    const response = {
      setHeader: (name: string, value: unknown) => { headers[name] = value },
      writeHead: (code: number, values: Record<string, unknown>) => { status = code; Object.assign(headers, values) },
      end: (body: string) => { responseBody += body },
    } as unknown as ServerResponse
    expect(await api.handle(request, response, new URL(path, 'http://127.0.0.1'))).toBe(true)
    return { status, headers, body: JSON.parse(responseBody) }
  }
  return { registry, interactions, wait, changes, notifications, post, setAssociation: (value: CursorHookAssociation) => { currentAssociation = value }, setForegroundVerified: (value: boolean) => { foregroundVerified = value } }
}

describe('Cursor native hook API in-process', () => {
  it('validates auth, route, pane ownership, method, JSON schema and size before mutation', async () => {
    const { post, registry } = harness()
    const path = '/api/agent-status/hooks/cursor'
    expect((await post(path, native('beforeSubmitPrompt'), { token: 'wrong' })).status).toBe(401)
    expect((await post('/api/agent-status/hooks/agent', native('beforeSubmitPrompt'))).status).toBe(404)
    expect((await post(path, native('beforeSubmitPrompt'), { pane: '%9' })).status).toBe(404)
    expect((await post(path, native('beforeSubmitPrompt'), { pane: 'not-a-pane' })).status).toBe(400)
    expect((await post(path, native('beforeSubmitPrompt'), { method: 'GET' })).status).toBe(405)
    expect((await post(path, {}, { contentType: 'text/plain' })).status).toBe(415)
    expect((await post(path, {}, { raw: '{' })).status).toBe(400)
    expect((await post(path, [], {})).status).toBe(400)
    for (const body of [native('stop', { status: 'idle' }), native('preToolUse', { generation_id: '' }), native('afterAgentThought'), native('stop', { status: 'completed', conversation_id: 'id;inject' })]) {
      expect((await post(path, body)).status).toBe(400)
    }
    expect((await post(path, native('beforeSubmitPrompt', { intent: 'x'.repeat(70_000) }))).status).toBe(413)
    expect((await post(path, {}, { declaredLength: '70000' })).status).toBe(413)
    expect(registry.get('%1')).toBeUndefined()
  })

  it('accepts normalized metadata through first prompt, checks, response and stop', async () => {
    const { post, registry, notifications } = harness('agent')
    const path = '/api/agent-status/hooks/cursor'
    await post(path, native('sessionStart'))
    await post(path, native('beforeSubmitPrompt', { intent: 'First intent' }))
    await post(path, native('preToolUse', { activityId: 'tool-1', activity: { label: 'Run command', kind: 'command', state: 'running' }, check: { label: 'test', status: 'running' } }))
    await post(path, native('postToolUse', { activityId: 'tool-1', activity: { label: 'Run command', kind: 'command', state: 'completed' }, check: { label: 'test', status: 'passed' } }))
    await post(path, native('afterAgentResponse', { finalMessage: '🟢 Fixed tests token=private-secret' }))
    expect(registry.get('%1')?.details?.recap).toBeUndefined()
    await post(path, native('stop', { status: 'completed' }))
    expect(registry.get('%1')).toMatchObject({ provider: 'cursor', source: 'hook', details: { intent: 'First intent', checks: [{ status: 'passed' }], recap: { outcome: 'done', summary: 'Fixed tests token=[REDACTED]' } } })
    expect(notifications).toHaveLength(1)
    expect(notifications[0].title).toBe('Cursor finished · cursor-test')
  })

  it.each(['native-first', 'imported-first', 'interleaved'])('keeps one stream, recap and push and never waits for imported interactions: %s', async (ordering) => {
    const { post, registry, interactions, wait, changes, notifications } = harness()
    const release = interactions.registerConsumer()
    const imported = { hook_event_name: 'PreToolUse', session_id: 'conv-abcdefgh', conversation_id: 'conv-abcdefgh', cursor_version: '2026.10.01',
      tool_name: 'AskUserQuestion', request: { id: 'must-not-wait', kind: 'question', prompt: 'Duplicate interaction' } }
    const ignored = async () => expect((await post('/api/agent-status/hooks/claude', imported)).body).toEqual({ ok: true, changed: false })
    try {
      if (ordering === 'imported-first') await ignored()
      await post('/api/agent-status/hooks/cursor', native('beforeSubmitPrompt'))
      await ignored()
      await post('/api/agent-status/hooks/cursor', native('afterAgentResponse', { finalMessage: '🟢 One completion' }))
      if (ordering === 'interleaved') await ignored()
      await post('/api/agent-status/hooks/cursor', native('stop', { status: 'completed' }))
      await ignored()
      await post('/api/agent-status/hooks/cursor', native('stop', { status: 'completed' }))
      expect(changes.filter((change) => change?.type === 'upsert' && change.status.details?.recap)).toHaveLength(1)
      expect(notifications).toHaveLength(1)
      expect(registry.get('%1')?.provider).toBe('cursor')
      expect(registry.get('%1')?.details?.requests).toBeUndefined()
      expect(wait).not.toHaveBeenCalled()
    } finally { release() }
  })

  it('defends old stripped Claude bridges with explicit process evidence and matching native session', async () => {
    const imported = { hook_event_name: 'Stop', session_id: 'conv-abcdefgh', finalMessage: 'Wrong completion' }
    const explicit = harness('cursor-agent')
    expect((await explicit.post('/api/agent-status/hooks/claude', imported)).body.changed).toBe(false)
    const runtime = harness('node')
    await runtime.post('/api/agent-status/hooks/cursor', native('beforeSubmitPrompt'))
    expect((await runtime.post('/api/agent-status/hooks/claude', imported)).body.changed).toBe(false)
    expect(runtime.registry.get('%1')?.provider).toBe('cursor')
    const claude = harness('claude')
    await claude.post('/api/agent-status/hooks/claude', { ...imported, session_id: 'real-claude' })
    expect(claude.registry.get('%1')?.provider).toBe('claude')
  })

  it('suppresses aborted pushes and isolates child completion/candidates and late generations', async () => {
    const { post, registry, notifications } = harness()
    const path = '/api/agent-status/hooks/cursor'
    await post(path, native('beforeSubmitPrompt'))
    await post(path, native('afterAgentResponse', { finalMessage: 'Old candidate' }))
    await post(path, native('beforeSubmitPrompt', { generation_id: 'gen-2' }))
    await post(path, native('afterAgentResponse', { finalMessage: 'Late candidate' }))
    await post(path, native('afterAgentResponse', { generation_id: 'gen-2', conversation_id: 'child-conv', parent_conversation_id: 'conv-abcdefgh', text: 'Child candidate' }))
    await post(path, native('stop', { generation_id: 'gen-2', status: 'aborted' }))
    expect(registry.get('%1')).toMatchObject({ status: 'unknown', summary: 'Cursor turn cancelled', details: { recap: { outcome: 'cancelled' } } })
    expect(notifications).toEqual([])
  })
})

it('rejects unverified foreground association before status mutation', async () => {
  const { post, registry } = harness()
  expect((await post('/api/agent-status/hooks/cursor', native('beforeSubmitPrompt', { association: null }))).status).toBe(403)
  expect(registry.get('%1')).toBeUndefined()
})
it('reconciles a final blocked recap with needs_input and suppresses misleading finished pushes', async () => {
  const { post, registry, notifications } = harness()
  const path = '/api/agent-status/hooks/cursor'
  await post(path, native('beforeSubmitPrompt'))
  await post(path, native('afterAgentResponse', { text: 'Intro\n🟢 Intermediate\nMore detail\n🔴 Need approval password=private-value' }))
  await post(path, native('stop', { status: 'completed' }))
  await post(path, native('stop', { status: 'completed' }))
  expect(registry.get('%1')).toMatchObject({ status: 'needs_input', details: { recap: { outcome: 'blocked', summary: 'Need approval password=[REDACTED]' } } })
  expect(notifications).toEqual([])
  expect(JSON.stringify(registry.get('%1'))).not.toContain('private-value')
})

it('preserves genuine Claude on an unrelated node after Cursor loses actual foreground ownership', async () => {
  const { post, registry, setForegroundVerified } = harness('node')
  await post('/api/agent-status/hooks/cursor', native('beforeSubmitPrompt'))
  setForegroundVerified(false)
  await post('/api/agent-status/hooks/claude', { hook_event_name: 'UserPromptSubmit', session_id: 'conv-abcdefgh', intent: 'Real Claude work' })
  expect(registry.get('%1')?.provider).toBe('claude')
})
it('accepts only its own delayed sessionStart context and preserves prompt-first working intent', async () => {
  const { post, registry } = harness()
  const path = '/api/agent-status/hooks/cursor'
  await post(path, native('beforeSubmitPrompt', { emittedAt: '20', intent: 'First intent' }))
  expect((await post(path, native('sessionStart', { emittedAt: '10' }))).body).toEqual({ ok: true, changed: false, accepted: true })
  expect((await post(path, native('sessionStart', { emittedAt: '11', conversation_id: 'unseen-delayed', generation_id: 'unseen-delayed' }))).body).toEqual({ ok: true, changed: false, accepted: false })
  expect(registry.get('%1')).toMatchObject({ status: 'working', details: { intent: 'First intent' } })
})

it.each(['stop-first', 'response-first'])('preserves the observed final recap through authenticated API transport: %s', async (ordering) => {
  const { post, registry, notifications } = harness()
  const path = '/api/agent-status/hooks/cursor'
  await post(path, native('sessionStart'))
  await post(path, native('beforeSubmitPrompt'))
  await post(path, native('preToolUse', { tool_name: 'Read', tool_use_id: 'opaque/read +=' }))
  await post(path, native('postToolUse', { tool_name: 'Read', tool_use_id: 'opaque/read +=' }))
  if (ordering === 'response-first') await post(path, native('afterAgentResponse', { text: '🟢 Cursor native acceptance complete' }))
  await post(path, native('stop', { status: 'completed' }))
  const completedAt = registry.get('%1')?.details?.recap?.completedAt
  if (ordering === 'stop-first') expect((await post(path, native('afterAgentResponse', { text: '🟢 Cursor native acceptance complete' }))).body).toEqual({ ok: true, changed: true, accepted: true })
  expect(registry.get('%1')).toMatchObject({ status: 'done', details: { recap: { summary: 'Cursor native acceptance complete', completedAt } } })
  expect((await post(path, native('afterAgentResponse', { text: '🟢 Cursor native acceptance complete' }))).body.changed).toBe(false)
  await post(path, native('sessionEnd'))
  expect((await post(path, native('afterAgentResponse', { text: '🟢 Too late' }))).body.changed).toBe(false)
  expect(notifications).toHaveLength(1)
})
it('accepts startup context for a new verified producer after its predecessor was working', async () => {
  const { post, registry, setAssociation } = harness()
  const path = '/api/agent-status/hooks/cursor'
  await post(path, native('beforeSubmitPrompt', { intent: 'A working' }))
  setAssociation({ ...association, producerPid: 120, producerStarted: 'Tue Oct 6 12:01:01 2026' })
  expect((await post(path, native('sessionStart', { conversation_id: 'producer-B', generation_id: 'producer-B' }))).body).toEqual({ ok: true, changed: true, accepted: true })
  expect(registry.get('%1')).toMatchObject({ agentSessionId: 'producer-B', status: 'unknown' })
})
it('records stop after sequential ownership probes take longer than the former request lifetime', async () => {
  const io: CursorOwnershipIO = {
    run: async (command, args) => {
      await new Promise((resolve) => setTimeout(resolve, 400))
      if (command === 'tmux') return '/fixture/cursor.sock|90|100'
      if (args[0] === '-p') return 'node'
      return '90 1 90 -1 Tue Oct 6 12:00:00 2026 tmux\n100 90 100 100 Tue Oct 6 12:00:01 2026 node /fixture/cursor-agent/versions/1/index.js\n110 100 100 100 Tue Oct 6 12:00:02 2026 node bridge.mjs'
    },
    socket: async (path) => ({ path, device: '1', inode: '2' }),
    executable: async (command) => command === 'node' ? '/usr/bin/node' : command,
  }
  const { post, registry } = harness('node', { verify: (pane, body) => verifyCursorHookAssociation(pane, body, { io, socketArgs: ['-S', association.socketPath] }) })
  const path = '/api/agent-status/hooks/cursor'
  await post(path, native('beforeSubmitPrompt', { association, emittedAt: process.hrtime.bigint().toString() }))
  expect((await post(path, native('stop', { status: 'completed', association, emittedAt: process.hrtime.bigint().toString() }))).body).toEqual({ ok: true, changed: true, accepted: true })
  expect(registry.get('%1')?.status).toBe('done')
})
