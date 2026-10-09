import { EventEmitter } from 'node:events'
import type { WebSocket } from 'ws'
import { describe, expect, it } from 'vitest'
import type { ChatItem, ChatSessionInfo } from '../shared/agent-chat.js'
import type { ServerMessage } from '../shared/protocol.js'
import { AgentHostHub, hostRunsInPane } from './agent-host-hub.js'

class FakeSocket extends EventEmitter {
  readonly OPEN = 1
  readyState = 1
  sent: unknown[] = []
  send(data: string) { this.sent.push(JSON.parse(data)) }
  close() {
    if (this.readyState !== 1) return
    this.readyState = 3
    this.emit('close')
  }
  host(message: unknown) { this.emit('message', Buffer.from(JSON.stringify(message)), false) }
}

/** Host messages are applied through a promise queue. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

const session = (paneId: string, overrides: Partial<ChatSessionInfo> = {}): ChatSessionInfo => ({
  paneId, provider: 'claude', cwd: '/work', status: 'idle', hostPid: 10, hostVersion: 1, ...overrides,
})

const item = (id: string, text: string, overrides: Partial<ChatItem> = {}): ChatItem => ({
  id, turnId: 't1', status: 'completed', createdAt: 1, updatedAt: 1, kind: 'assistant_message', text, ...overrides,
} as ChatItem)

function setup(options: { panes?: Set<string>; verifyHost?: (paneId: string, hostPid: number) => Promise<boolean>; now?: () => number } = {}) {
  const panes = options.panes ?? new Set(['%1', '%2'])
  const broadcasts: ServerMessage[] = []
  const hub = new AgentHostHub({
    paneExists: (paneId) => panes.has(paneId),
    targetIdFor: (paneId) => `target-${paneId.slice(1)}`,
    broadcast: (message) => broadcasts.push(message),
    ...(options.verifyHost ? { verifyHost: options.verifyHost } : {}),
    ...(options.now ? { now: options.now } : {}),
  })
  const connect = () => {
    const socket = new FakeSocket()
    hub.connect(socket as unknown as WebSocket)
    socket.host({ type: 'hello', hostId: 'h', version: 1, mode: 'pane', pid: 10 })
    return socket
  }
  return { hub, broadcasts, connect, panes }
}

describe('AgentHostHub', () => {
  it('keeps a pane chat from snapshot plus streamed items and relays them to clients', async () => {
    const { hub, broadcasts, connect } = setup()
    const socket = connect()
    socket.host({ type: 'session_snapshot', session: session('%1'), items: [item('a', 'Hel')] })
    socket.host({ type: 'items', paneId: '%1', items: [item('a', 'Hello'), item('b', 'more')] })
    await settle()
    expect(socket.sent).toEqual([{ type: 'welcome', version: 1 }])
    expect(hub.states()).toEqual([expect.objectContaining({ paneId: '%1', targetId: 'target-1', hostConnected: true })])
    expect(hub.items('%1').map((entry) => entry.kind === 'assistant_message' && entry.text)).toEqual(['Hello', 'more'])
    expect(broadcasts.map((message) => message.type)).toEqual(['chat_state', 'chat_items'])
    expect(hub.owns('%1')).toBe(true)
  })

  it('holds a session for a pane tmux has not reported yet, then shows it once the pane appears', async () => {
    let now = 0
    const panes = new Set<string>()
    const { hub, broadcasts, connect } = setup({ panes, now: () => now })
    const socket = connect()
    socket.host({ type: 'session_snapshot', session: session('%7'), items: [item('a', 'kept')] })
    socket.host({ type: 'items', paneId: '%7', items: [item('b', 'while hidden')] })
    await settle()
    expect(hub.states()).toEqual([])
    expect(broadcasts).toEqual([])
    // Hooks from the pane must already skip held prompts in this window.
    expect(hub.owns('%7')).toBe(true)
    await hub.reconcile()
    expect(hub.states()).toEqual([])
    panes.add('%7')
    await hub.reconcile()
    expect(hub.states()).toEqual([expect.objectContaining({ paneId: '%7', targetId: 'target-7' })])
    expect(hub.items('%7')).toHaveLength(2)
    expect(broadcasts.map((message) => message.type)).toEqual(['chat_state'])

    const late = connect()
    late.host({ type: 'session_snapshot', session: session('%8'), items: [] })
    await settle()
    now = 61_000
    await hub.reconcile()
    expect(late.readyState).toBe(3)
  })

  it('refuses a host that does not run inside the pane it claims', async () => {
    const { hub, connect } = setup({ verifyHost: async (paneId, hostPid) => paneId === '%1' && hostPid === 10 })
    const impostor = connect()
    impostor.host({ type: 'session_snapshot', session: session('%2', { hostPid: 99 }), items: [] })
    await settle()
    expect(impostor.readyState).toBe(3)
    expect(hub.states()).toEqual([])
    const real = connect()
    real.host({ type: 'session_snapshot', session: session('%1'), items: [] })
    await settle()
    expect(hub.owns('%1')).toBe(true)
  })

  it('ignores malformed items, panes the socket does not own, and a replaced socket', async () => {
    const { hub, connect } = setup()
    const first = connect()
    const second = connect()
    first.host({ type: 'session_snapshot', session: session('%1'), items: [item('a', 'x'), { id: 'bad' }] })
    second.host({ type: 'items', paneId: '%1', items: [item('z', 'hijack')] })
    await settle()
    expect(hub.states().map((chat) => chat.paneId)).toEqual(['%1'])
    expect(hub.items('%1').map((entry) => entry.id)).toEqual(['a'])

    // A new host for the pane takes over; late messages from the old one are dropped.
    const replacement = connect()
    replacement.host({ type: 'session_snapshot', session: session('%1', { hostPid: 11 }), items: [] })
    await settle()
    first.emit('message', Buffer.from(JSON.stringify({ type: 'items', paneId: '%1', items: [item('late', 'stale')] })), false)
    await settle()
    expect(hub.items('%1')).toEqual([])
  })

  it('marks the host disconnected but keeps the chat, takes a fresh snapshot on reconnect, and expires it otherwise', async () => {
    let now = 0
    const { hub, broadcasts, connect } = setup({ now: () => now })
    const first = connect()
    first.host({ type: 'session_snapshot', session: session('%1'), items: [item('a', 'one')] })
    await settle()
    first.close()
    expect(hub.owns('%1')).toBe(false)
    expect(hub.states()[0]).toMatchObject({ hostConnected: false })
    expect(broadcasts.at(-1)).toMatchObject({ type: 'chat_session', paneId: '%1', hostConnected: false })

    const second = connect()
    second.host({ type: 'session_snapshot', session: session('%1', { status: 'running' }), items: [item('a', 'one'), item('b', 'two')] })
    await settle()
    expect(hub.owns('%1')).toBe(true)
    expect(hub.items('%1')).toHaveLength(2)

    second.close()
    now = 30_000
    await hub.reconcile()
    expect(hub.states()).toHaveLength(1)
    now = 61_000
    await hub.reconcile()
    expect(hub.states()).toEqual([])
    expect(broadcasts.at(-1)).toEqual({ type: 'chat_removed', paneId: '%1' })
  })

  it('routes sends, interrupts and answers to the owning host, and only answers open requests', async () => {
    const { hub, connect } = setup()
    const socket = connect()
    socket.host({
      type: 'session_snapshot',
      session: session('%1'),
      items: [
        { id: 'request-r1', turnId: 't', status: 'running', createdAt: 1, updatedAt: 1, kind: 'request', requestId: 'r1', requestKind: 'approval', toolName: 'Bash', title: 'Allow Bash?' },
        { id: 'request-r2', turnId: 't', status: 'completed', createdAt: 1, updatedAt: 1, kind: 'request', requestId: 'r2', requestKind: 'approval', toolName: 'Bash', title: 'Allow Bash?', answer: { kind: 'approval', decision: 'deny' } },
      ],
    })
    await settle()
    socket.sent = []
    expect(hub.send('%1', 'hi', 'q1')).toBe(true)
    expect(hub.interrupt('%1', 'q2')).toBe(true)
    expect(hub.answer('%1', 'r1', { kind: 'approval', decision: 'allow' }, 'q3')).toBe(true)
    expect(hub.answer('%1', 'r2', { kind: 'approval', decision: 'allow' }, 'q4')).toBe(false)
    expect(hub.answer('%1', 'missing', { kind: 'approval', decision: 'allow' }, 'q5')).toBe(false)
    expect(hub.send('%2', 'nobody home', 'q6')).toBe(false)
    expect(socket.sent.map((message) => (message as { type: string }).type)).toEqual(['send', 'interrupt', 'answer'])
  })

  it('drops chats whose pane disappeared and closes their host link', async () => {
    const { hub, broadcasts, connect, panes } = setup()
    const socket = connect()
    socket.host({ type: 'session_snapshot', session: session('%2'), items: [] })
    await settle()
    panes.delete('%2')
    await hub.reconcile()
    expect(hub.states()).toEqual([])
    expect(socket.readyState).toBe(3)
    expect(broadcasts.at(-1)).toEqual({ type: 'chat_removed', paneId: '%2' })
  })

  it('removes the chat when its host closes the session', async () => {
    const { hub, connect } = setup()
    const socket = connect()
    socket.host({ type: 'session_snapshot', session: session('%1'), items: [] })
    socket.host({ type: 'session_closed', paneId: '%1' })
    await settle()
    expect(hub.states()).toEqual([])
  })
})

describe('hostRunsInPane', () => {
  const rows = [{ pid: 100, ppid: 1 }, { pid: 200, ppid: 100 }, { pid: 300, ppid: 200 }, { pid: 400, ppid: 1 }]
  it('accepts the pane process or its descendants and nothing else', () => {
    expect(hostRunsInPane(rows, 300, 100)).toBe(true)
    expect(hostRunsInPane(rows, 100, 100)).toBe(true)
    expect(hostRunsInPane(rows, 400, 100)).toBe(false)
    expect(hostRunsInPane(rows, 999, 100)).toBe(false)
  })
})
