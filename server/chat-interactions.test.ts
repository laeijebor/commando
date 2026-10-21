import { EventEmitter } from 'node:events'
import { createServer } from 'node:http'
import type { WebSocket } from 'ws'
import { describe, expect, it } from 'vitest'
import type { ChatItem, ChatSessionInfo } from '../shared/agent-chat.js'
import type { CommandoSnapshot } from '../shared/protocol.js'
import { AgentHostHub } from './agent-host-hub.js'
import { AgentInteractionBroker } from './agent-interaction-broker.js'
import { answerAgentRequest } from './agent-request-answers.js'
import { AgentStatusHookApi } from './agent-status-api.js'
import { AgentStatusRegistry, type AgentStatusChange } from './agent-status-registry.js'
import { brokerChatInteractions, chatAnswerFor, chatHostReport, chatInteraction, type ChatRequestItem } from './chat-interactions.js'
import { buildCompanionSnapshot } from './companion.js'

class FakeSocket extends EventEmitter {
  readonly OPEN = 1
  readyState = 1
  sent: { type: string; [key: string]: unknown }[] = []
  send(data: string) { this.sent.push(JSON.parse(data)) }
  close() {
    if (this.readyState !== 1) return
    this.readyState = 3
    this.emit('close')
  }
  host(message: unknown) { this.emit('message', Buffer.from(JSON.stringify(message)), false) }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

const session = (overrides: Partial<ChatSessionInfo> = {}): ChatSessionInfo => ({
  paneId: '%1', provider: 'claude', cwd: '/work', status: 'idle', sessionId: 'sess-1', hostPid: 10, hostVersion: 4, ...overrides,
})

const approval = (requestId: string, overrides: Partial<ChatRequestItem> = {}): ChatRequestItem => ({
  id: `request-${requestId}`, turnId: 't1', status: 'running', createdAt: 1, updatedAt: 1,
  kind: 'request', requestId, requestKind: 'approval', toolName: 'Bash', title: 'Allow Bash?', detail: 'npm test', ...overrides,
})

const question = (requestId: string, overrides: Partial<ChatRequestItem> = {}): ChatRequestItem => ({
  ...approval(requestId),
  requestKind: 'question', toolName: 'AskUserQuestion', title: 'Claude is asking', detail: undefined,
  questions: [{ question: 'Which colour?', header: 'Colour', multiSelect: false, options: [{ label: 'Lavender' }, { label: 'Mint' }] }],
  ...overrides,
})

const userMessage: ChatItem = { id: 'u1', turnId: 't1', status: 'completed', createdAt: 1, updatedAt: 1, kind: 'user_message', text: 'hi' }

/** The daemon's wiring, as index.ts builds it, around a fake host socket. */
function setup() {
  const registry = new AgentStatusRegistry()
  const broker = new AgentInteractionBroker()
  const changes: AgentStatusChange[] = []
  const restored: string[] = []
  const news: string[] = []
  const publish = (change: AgentStatusChange, quiet?: boolean) => {
    if (change?.type !== 'upsert') return
    changes.push(change)
    ;(quiet ? restored : news).push(change.status.status)
  }
  const hub: AgentHostHub = new AgentHostHub({
    paneExists: (paneId) => paneId === '%1',
    targetIdFor: () => 'target-1',
    broadcast: () => {},
    interactions: brokerChatInteractions({
      registry,
      broker,
      publish,
      answer: (paneId, chatRequestId, answer) => hub.answerInteraction(paneId, chatRequestId, answer),
    }),
  })
  const socket = new FakeSocket()
  hub.connect(socket as unknown as WebSocket)
  const answerFromPhone = (requestId: string, action: 'allow_once' | 'deny' = 'allow_once') => answerAgentRequest(
    { interactions: broker, registry, onStatusChange: publish },
    '%1',
    requestId,
    { action },
  )
  const answersToHost = () => socket.sent.filter((message) => message.type === 'answer')
  return { registry, broker, hub, socket, changes, restored, news, answerFromPhone, answersToHost }
}

const companionRequests = (registry: AgentStatusRegistry, broker: AgentInteractionBroker) => buildCompanionSnapshot(
  {
    capturedAt: 1,
    sessions: [{ id: '$1', name: 'commando', attached: true }],
    windows: [{ id: '@1', sessionId: '$1', name: 'chat' }],
    panes: [{ id: '%1', sessionId: '$1', windowId: '@1', index: 0 }],
  } as unknown as CommandoSnapshot,
  registry.values(),
  [],
  () => undefined,
  (paneId, requestId) => broker.hasPending(paneId, requestId),
).sessions.flatMap((entry) => entry.requests)

describe('chat requests in the approvals broker', () => {
  it('lists each chat request once, even when its hook fires too', async () => {
    const { registry, broker, socket } = setup()
    const release = broker.registerConsumer()
    const api = new AgentStatusHookApi({
      token: 'agent-hook-token-that-is-at-least-32-characters',
      registry,
      paneExists: (paneId) => paneId === '%1',
      paneCommand: () => 'node',
      onChange: () => {},
      interactions: broker,
      chatOwnsPane: () => true,
    })
    const server = createServer((request, response) => { void api.handle(request, response, new URL(request.url ?? '/', 'http://127.0.0.1')) })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Test server did not bind')
    try {
      socket.host({ type: 'session_snapshot', session: session({ status: 'waiting' }), items: [userMessage, approval('r1')] })
      await settle()
      // The SDK's Claude runs Commando's hooks too: its PermissionRequest for the same prompt.
      const response = await fetch(`http://127.0.0.1:${address.port}/api/agent-status/hooks/claude`, {
        method: 'POST',
        headers: { Authorization: 'Bearer agent-hook-token-that-is-at-least-32-characters', 'Content-Type': 'application/json', 'X-Commando-Pane': '%1' },
        body: JSON.stringify({
          hook_event_name: 'PermissionRequest',
          session_id: 'sess-1',
          tool_name: 'Bash',
          attention: 'Claude needs your permission to use Bash',
          request: { id: 'hook-request', kind: 'permission', prompt: 'Allow Bash?', toolName: 'Bash' },
        }),
        signal: AbortSignal.timeout(2_000),
      })
      expect(await response.json()).toMatchObject({ ok: true })
      expect(broker.hasPending('%1', 'hook-request')).toBe(false)
      expect(broker.hasPending('%1', 'r1')).toBe(true)
      expect(registry.get('%1')?.details?.requests).toEqual([expect.objectContaining({ id: 'r1', kind: 'permission', prompt: 'npm test', toolName: 'Bash' })])
      expect(companionRequests(registry, broker)).toEqual([expect.objectContaining({ id: 'r1' })])
    } finally {
      release()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('stays listed with nobody watching, and the last watcher leaving does not cancel it', async () => {
    const { broker, socket } = setup()
    socket.host({ type: 'session_snapshot', session: session({ status: 'waiting' }), items: [approval('r1')] })
    await settle()
    expect(broker.hasPending('%1', 'r1')).toBe(true)
    broker.registerConsumer()()
    expect(broker.hasPending('%1', 'r1')).toBe(true)
  })

  it('sends the first answer to the host once and refuses the rest (c1-race)', async () => {
    const { hub, registry, broker, socket, answerFromPhone, answersToHost } = setup()
    socket.host({ type: 'session_snapshot', session: session({ status: 'waiting' }), items: [approval('r1')] })
    await settle()

    expect(answerFromPhone('r1')).toEqual({ ok: true, changed: true })
    expect(answersToHost()).toEqual([expect.objectContaining({ chatRequestId: 'r1', answer: { kind: 'approval', decision: 'allow' } })])
    expect(broker.hasPending('%1', 'r1')).toBe(false)
    expect(registry.get('%1')?.details?.requests).toBeUndefined()

    // Deny in the chat a moment later, before the host has confirmed the phone's answer.
    expect(hub.answer('%1', 'r1', { kind: 'approval', decision: 'deny' }, 'chat-1')).toBe(false)
    expect(hub.answered('%1', 'r1')).toBe(true)
    expect(answerFromPhone('r1', 'deny')).toMatchObject({ ok: false, code: 'request_unavailable' })
    expect(answersToHost()).toHaveLength(1)

    // The host confirms; nothing reopens.
    socket.host({ type: 'items', paneId: '%1', items: [approval('r1', { status: 'completed', answer: { kind: 'approval', decision: 'allow' } })] })
    await settle()
    expect(broker.hasPending('%1', 'r1')).toBe(false)
    expect(hub.answered('%1', 'r1')).toBe(true)
  })

  it('takes the request off every list when the chat answers it first', async () => {
    const { hub, registry, broker, socket, answerFromPhone, answersToHost } = setup()
    socket.host({ type: 'session_snapshot', session: session({ status: 'waiting' }), items: [approval('r1')] })
    await settle()
    expect(hub.answer('%1', 'r1', { kind: 'approval', decision: 'deny' }, 'chat-1')).toBe(true)
    expect(broker.hasPending('%1', 'r1')).toBe(false)
    expect(registry.get('%1')?.details?.requests).toBeUndefined()
    expect(answerFromPhone('r1')).toMatchObject({ ok: false, code: 'request_unavailable' })
    expect(answersToHost()).toEqual([expect.objectContaining({ answer: { kind: 'approval', decision: 'deny' } })])
  })

  it('withdraws open requests when /clear replaces the timeline', async () => {
    const { broker, socket, registry } = setup()
    socket.host({ type: 'session_snapshot', session: session({ status: 'waiting' }), items: [approval('r1')] })
    await settle()
    expect(broker.hasPending('%1', 'r1')).toBe(true)
    socket.host({ type: 'items', paneId: '%1', items: [{ ...userMessage, id: 'notice-1', kind: 'notice', level: 'info', text: 'Context cleared' }], replace: true })
    await settle()
    expect(broker.hasPending('%1', 'r1')).toBe(false)
    expect(registry.get('%1')?.details?.requests).toBeUndefined()
  })

  it('withdraws requests the host cancels, and every request and its status when the host disconnects', async () => {
    const { broker, socket, registry } = setup()
    socket.host({ type: 'session_snapshot', session: session({ status: 'waiting' }), items: [approval('r1'), approval('r2')] })
    await settle()
    socket.host({ type: 'items', paneId: '%1', items: [approval('r1', { status: 'interrupted', answer: { kind: 'cancelled', reason: 'Interrupted' } })] })
    await settle()
    expect(broker.hasPending('%1', 'r1')).toBe(false)
    expect(broker.hasPending('%1', 'r2')).toBe(true)
    socket.close()
    expect(broker.hasPending('%1', 'r2')).toBe(false)
    // Hooks have the pane meanwhile; it may run Claude Code itself now.
    expect(registry.get('%1')).toBeUndefined()
  })

  it('relists a request whose answer was lost with its host, and keeps a failed send answerable', async () => {
    const { hub, broker, socket, answerFromPhone } = setup()
    socket.host({ type: 'session_snapshot', session: session({ status: 'waiting' }), items: [approval('r1')] })
    await settle()
    expect(answerFromPhone('r1')).toMatchObject({ ok: true })
    socket.close()
    const next = new FakeSocket()
    hub.connect(next as unknown as WebSocket)
    next.host({ type: 'session_snapshot', session: session({ status: 'waiting' }), items: [approval('r1')] })
    await settle()
    expect(broker.hasPending('%1', 'r1')).toBe(true)
    expect(hub.answered('%1', 'r1')).toBe(false)

    next.readyState = 3
    expect(hub.answer('%1', 'r1', { kind: 'approval', decision: 'allow' }, 'chat-1')).toBe(false)
    expect(hub.answered('%1', 'r1')).toBe(false)
    expect(broker.hasPending('%1', 'r1')).toBe(true)
  })

  it('tells nobody about what a reconnecting host already had, only about what comes after', async () => {
    const { socket, restored, news } = setup()
    socket.host({ type: 'session_snapshot', session: session({ status: 'waiting' }), items: [userMessage, approval('r1')] })
    await settle()
    expect(restored).toEqual(['needs_input', 'needs_input'])
    expect(news).toEqual([])
    socket.host({ type: 'items', paneId: '%1', items: [approval('r2')] })
    await settle()
    expect(news).toEqual(['needs_input'])
  })

  it('relists what a reconnecting host still waits on, and drops what it no longer has', async () => {
    const { hub, broker, socket } = setup()
    socket.host({ type: 'session_snapshot', session: session({ status: 'waiting' }), items: [approval('r1'), approval('r2')] })
    await settle()
    const next = new FakeSocket()
    hub.connect(next as unknown as WebSocket)
    next.host({ type: 'session_snapshot', session: session({ status: 'waiting' }), items: [approval('r2')] })
    await settle()
    expect(broker.hasPending('%1', 'r1')).toBe(false)
    expect(broker.hasPending('%1', 'r2')).toBe(true)
  })

  it('answers a question from the island in the host shape, and a dismissal as a denial', async () => {
    const { broker, socket, answersToHost, registry } = setup()
    socket.host({ type: 'session_snapshot', session: session({ status: 'waiting' }), items: [question('q1'), question('q2')] })
    await settle()
    expect(registry.get('%1')?.details?.requests?.[0]).toMatchObject({
      kind: 'question', prompt: 'Which colour?', questions: [{ header: 'Colour', question: 'Which colour?', multiple: false, custom: true, options: [{ label: 'Lavender' }, { label: 'Mint' }] }],
    })
    expect(broker.answer('%1', 'q1', { action: 'answer', answers: [['Mint']] })).toBe(true)
    expect(broker.answer('%1', 'q2', { action: 'reject' })).toBe(true)
    expect(answersToHost().map((message) => message.answer)).toEqual([
      { kind: 'question', answers: { 'Which colour?': 'Mint' } },
      { kind: 'approval', decision: 'deny', message: 'The user dismissed the question.' },
    ])
  })
})

describe('chat status for the HUD', () => {
  it.each([
    ['codex', 'Codex'],
    ['claude', 'Claude'],
  ] as const)('keeps the %s chat identity through host status updates and reconnects', async (provider, name) => {
    const { registry, socket } = setup()
    socket.host({ type: 'session_snapshot', session: session({ provider }), items: [] })
    await settle()
    expect(registry.get('%1')).toMatchObject({ provider, status: 'unknown', summary: `${name} is ready` })

    socket.host({ type: 'items', paneId: '%1', items: [userMessage] })
    socket.host({ type: 'session_update', session: session({ provider, status: 'running' }) })
    await settle()
    expect(registry.get('%1')).toMatchObject({ provider, status: 'working', summary: `${name} is working` })

    socket.host({ type: 'session_update', session: session({ provider, status: 'idle' }) })
    await settle()
    expect(registry.get('%1')).toMatchObject({ provider, status: 'done', summary: `${name} is idle` })

    const restarted = setup()
    restarted.socket.host({ type: 'session_snapshot', session: session({ provider }), items: [userMessage] })
    await settle()
    expect(restarted.registry.get('%1')).toMatchObject({ provider, status: 'done', summary: `${name} is idle` })

    socket.host({ type: 'session_update', session: session({ provider, status: 'waiting' }) })
    socket.host({ type: 'items', paneId: '%1', items: [approval('r1')] })
    await settle()
    expect(registry.get('%1')).toMatchObject({ provider, status: 'needs_input', summary: `${name} needs input: Allow Bash?` })

    socket.host({ type: 'items', paneId: '%1', items: [approval('r1', { status: 'completed', answer: { kind: 'approval', decision: 'allow' } })] })
    socket.host({ type: 'session_update', session: session({ provider, status: 'error' }) })
    await settle()
    expect(registry.get('%1')).toMatchObject({ provider, status: 'failed', summary: `${name} failed` })

    socket.host({ type: 'session_closed', paneId: '%1' })
    await settle()
    expect(registry.get('%1')).toBeUndefined()
  })

  it('updates the identity when only the chat provider changes', async () => {
    const { registry, socket } = setup()
    socket.host({ type: 'session_snapshot', session: session(), items: [] })
    await settle()
    expect(registry.get('%1')).toMatchObject({ provider: 'claude', summary: 'Claude is ready' })

    socket.host({ type: 'session_update', session: session({ provider: 'codex' }) })
    await settle()
    expect(registry.get('%1')).toMatchObject({ provider: 'codex', summary: 'Codex is ready' })
  })

  it('holds the host status with high confidence, and resends it after a daemon restart', async () => {
    const { registry, socket } = setup()
    socket.host({ type: 'session_snapshot', session: session({ status: 'idle' }), items: [] })
    await settle()
    expect(registry.get('%1')).toMatchObject({ status: 'unknown', confidence: 'high', source: 'hook', summary: 'Claude is ready' })

    socket.host({ type: 'items', paneId: '%1', items: [userMessage] })
    socket.host({ type: 'session_update', session: session({ status: 'running' }) })
    await settle()
    expect(registry.get('%1')).toMatchObject({ status: 'working', confidence: 'high' })

    // Hooks add details; the status stays the host's.
    registry.applyClaudeHook('%1', { hook_event_name: 'Stop', session_id: 'sess-1', finalMessage: 'Tests pass' }, 5, 'node')
    expect(registry.get('%1')).toMatchObject({ status: 'working', details: { recap: { summary: 'Tests pass' } } })
    socket.host({ type: 'session_update', session: session({ status: 'idle' }) })
    await settle()
    expect(registry.get('%1')).toMatchObject({ status: 'done', summary: 'Tests pass' })

    // A fresh daemon: an empty registry, and the host reconnects with its snapshot.
    const restarted = setup()
    restarted.socket.host({ type: 'session_snapshot', session: session({ status: 'idle' }), items: [userMessage] })
    await settle()
    expect(restarted.registry.get('%1')).toMatchObject({ status: 'done', confidence: 'high' })
    // Not news, so no "finished" push for it.
    expect(restarted.restored).toEqual(['done'])
  })

  it('shows needs input while a request waits, and drops the status with the chat', async () => {
    const { registry, socket } = setup()
    socket.host({ type: 'session_snapshot', session: session({ status: 'waiting' }), items: [userMessage, approval('r1')] })
    await settle()
    expect(registry.get('%1')).toMatchObject({ status: 'needs_input', summary: 'Claude needs input: Allow Bash?' })
    socket.host({ type: 'session_closed', paneId: '%1' })
    await settle()
    expect(registry.get('%1')).toBeUndefined()
  })
})

describe('chat request mapping', () => {
  it('maps island answers onto the request kind and refuses ones that do not fit', () => {
    expect(chatAnswerFor(approval('r'), { action: 'allow_always' })).toEqual({ kind: 'approval', decision: 'allow_always' })
    expect(chatAnswerFor(approval('r'), { action: 'answer', answers: [['x']] })).toBeNull()
    expect(chatAnswerFor(question('q'), { action: 'allow_once' })).toBeNull()
    expect(chatAnswerFor(question('q'), { action: 'answer', answers: [['Mint'], ['extra']] })).toBeNull()
    expect(chatAnswerFor(question('q'), { action: 'answer', answers: [['Lavender', 'typed']] })).toEqual({ kind: 'question', answers: { 'Which colour?': 'Lavender, typed' } })
    // The listed label was cut at 80 characters; Claude gets the whole option.
    const long = `${'A very long option '.repeat(6)}end`
    const cut = question('q', { questions: [{ question: 'Which?', multiSelect: false, options: [{ label: long }] }] })
    expect(chatAnswerFor(cut, { action: 'answer', answers: [[long.slice(0, 80).trim()]] })).toEqual({ kind: 'question', answers: { 'Which?': long } })
  })

  it('shows an approval by its command and title', () => {
    expect(chatInteraction(approval('r'))).toEqual({
      request: { id: 'r', kind: 'permission', prompt: 'npm test', toolName: 'Bash' },
      attention: 'Allow Bash?',
    })
    expect(chatInteraction(approval('r', { detail: undefined })).request.prompt).toBe('Allow Bash?')
  })

  it('reports idle as done only after a turn, and nothing once closed', () => {
    expect(chatHostReport(session({ status: 'idle' }), false)?.status).toBe('unknown')
    expect(chatHostReport(session({ status: 'starting' }), false)?.status).toBe('unknown')
    expect(chatHostReport(session({ status: 'idle' }), true)?.status).toBe('done')
    expect(chatHostReport(session({ status: 'waiting' }), true)?.status).toBe('needs_input')
    expect(chatHostReport(session({ status: 'error' }), true)?.status).toBe('failed')
    expect(chatHostReport(session({ status: 'closed' }), true)).toBeNull()
  })
})
