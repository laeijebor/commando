import { EventEmitter } from 'node:events'
import type { WebSocket } from 'ws'
import { describe, expect, it } from 'vitest'
import type { ChatItem, ChatSessionInfo } from '../shared/agent-chat.js'
import type { ServerMessage } from '../shared/protocol.js'
import { AgentHostHub } from './agent-host-hub.js'

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

const session = (paneId: string, overrides: Partial<ChatSessionInfo> = {}): ChatSessionInfo => ({
  paneId, provider: 'claude', cwd: '/work', status: 'idle', hostPid: 10, hostVersion: 1, ...overrides,
})

const item = (id: string, text: string, overrides: Partial<ChatItem> = {}): ChatItem => ({
  id, turnId: 't1', status: 'completed', createdAt: 1, updatedAt: 1, kind: 'assistant_message', text, ...overrides,
} as ChatItem)

function setup(panes = new Set(['%1', '%2'])) {
  const broadcasts: ServerMessage[] = []
  const hub = new AgentHostHub({
    paneExists: (paneId) => panes.has(paneId),
    targetIdFor: (paneId) => `target-${paneId.slice(1)}`,
    broadcast: (message) => broadcasts.push(message),
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
  it('keeps a pane chat from snapshot plus streamed items and relays them to clients', () => {
    const { hub, broadcasts, connect } = setup()
    const socket = connect()
    expect(socket.sent).toEqual([{ type: 'welcome', version: 1 }])
    socket.host({ type: 'session_snapshot', session: session('%1'), items: [item('a', 'Hel')] })
    socket.host({ type: 'items', paneId: '%1', items: [item('a', 'Hello'), item('b', 'more')] })
    expect(hub.states()).toEqual([expect.objectContaining({ paneId: '%1', targetId: 'target-1', hostConnected: true })])
    expect(hub.items('%1').map((entry) => entry.kind === 'assistant_message' && entry.text)).toEqual(['Hello', 'more'])
    expect(broadcasts.map((message) => message.type)).toEqual(['chat_state', 'chat_items'])
    expect(hub.owns('%1')).toBe(true)
  })

  it('holds a session for a pane tmux has not reported yet, then shows it once the pane appears', () => {
    let now = 0
    const panes = new Set<string>()
    const broadcasts: ServerMessage[] = []
    const hub = new AgentHostHub({ paneExists: (paneId) => panes.has(paneId), targetIdFor: () => 'target-7', broadcast: (message) => broadcasts.push(message), now: () => now })
    const socket = new FakeSocket()
    hub.connect(socket as unknown as WebSocket)
    socket.host({ type: 'session_snapshot', session: session('%7'), items: [item('a', 'kept')] })
    socket.host({ type: 'items', paneId: '%7', items: [item('b', 'while hidden')] })
    expect(hub.states()).toEqual([])
    expect(broadcasts).toEqual([])
    hub.reconcile()
    expect(hub.states()).toEqual([])
    panes.add('%7')
    hub.reconcile()
    expect(hub.states()).toEqual([expect.objectContaining({ paneId: '%7', targetId: 'target-7' })])
    expect(hub.items('%7')).toHaveLength(2)
    expect(broadcasts.map((message) => message.type)).toEqual(['chat_state'])

    const late = new FakeSocket()
    hub.connect(late as unknown as WebSocket)
    late.host({ type: 'session_snapshot', session: session('%8'), items: [] })
    now = 61_000
    hub.reconcile()
    expect(late.readyState).toBe(3)
  })

  it('ignores malformed items and panes the socket does not own', () => {
    const { hub, connect } = setup()
    const first = connect()
    const second = connect()
    first.host({ type: 'session_snapshot', session: session('%1'), items: [item('a', 'x'), { id: 'bad' }] })
    second.host({ type: 'items', paneId: '%1', items: [item('z', 'hijack')] })
    expect(hub.states().map((chat) => chat.paneId)).toEqual(['%1'])
    expect(hub.items('%1').map((entry) => entry.id)).toEqual(['a'])
  })

  it('marks the host disconnected but keeps the chat, then takes a fresh snapshot on reconnect', () => {
    const { hub, broadcasts, connect } = setup()
    const first = connect()
    first.host({ type: 'session_snapshot', session: session('%1'), items: [item('a', 'one')] })
    first.close()
    expect(hub.owns('%1')).toBe(false)
    expect(hub.states()[0]).toMatchObject({ hostConnected: false })
    expect(broadcasts.at(-1)).toMatchObject({ type: 'chat_session', paneId: '%1', hostConnected: false })

    const second = connect()
    second.host({ type: 'session_snapshot', session: session('%1', { status: 'running' }), items: [item('a', 'one'), item('b', 'two')] })
    expect(hub.owns('%1')).toBe(true)
    expect(hub.items('%1')).toHaveLength(2)
  })

  it('routes sends, interrupts and answers to the owning host, and only answers open requests', () => {
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
    socket.sent = []
    expect(hub.send('%1', 'hi', 'q1')).toBe(true)
    expect(hub.interrupt('%1', 'q2')).toBe(true)
    expect(hub.answer('%1', 'r1', { kind: 'approval', decision: 'allow' }, 'q3')).toBe(true)
    expect(hub.answer('%1', 'r2', { kind: 'approval', decision: 'allow' }, 'q4')).toBe(false)
    expect(hub.answer('%1', 'missing', { kind: 'approval', decision: 'allow' }, 'q5')).toBe(false)
    expect(hub.send('%2', 'nobody home', 'q6')).toBe(false)
    expect(socket.sent.map((message) => (message as { type: string }).type)).toEqual(['send', 'interrupt', 'answer'])
  })

  it('drops chats whose pane disappeared and closes their host link', () => {
    const { hub, broadcasts, connect, panes } = setup()
    const socket = connect()
    socket.host({ type: 'session_snapshot', session: session('%2'), items: [] })
    panes.delete('%2')
    hub.reconcile()
    expect(hub.states()).toEqual([])
    expect(socket.readyState).toBe(3)
    expect(broadcasts.at(-1)).toEqual({ type: 'chat_removed', paneId: '%2' })
  })

  it('removes the chat when its host closes the session', () => {
    const { hub, connect } = setup()
    const socket = connect()
    socket.host({ type: 'session_snapshot', session: session('%1'), items: [] })
    socket.host({ type: 'session_closed', paneId: '%1' })
    expect(hub.states()).toEqual([])
  })
})
