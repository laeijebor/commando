import { EventEmitter } from 'node:events'
import type { WebSocket } from 'ws'
import { describe, expect, it } from 'vitest'
import { AGENT_HOST_PROTOCOL_VERSION, type ChatItem, type ChatSessionInfo } from '../shared/agent-chat.js'
import type { ServerMessage } from '../shared/protocol.js'
import { AgentHostHub, hostRunsInPane } from './agent-host-hub.js'

class FakeSocket extends EventEmitter {
  readonly OPEN = 1
  readyState = 1
  sent: unknown[] = []
  closeCode: number | undefined
  send(data: string) { this.sent.push(JSON.parse(data)) }
  close(code?: number) {
    if (this.readyState !== 1) return
    this.closeCode = code
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

function setup(options: { panes?: Set<string>; verifyHost?: (paneId: string, hostPid: number) => Promise<boolean>; now?: () => number; currentHostBuild?: () => Promise<string | undefined>; handoffs?: ConstructorParameters<typeof AgentHostHub>[0]['handoffs']; replyImages?: ConstructorParameters<typeof AgentHostHub>[0]['replyImages'] } = {}) {
  const panes = options.panes ?? new Set(['%1', '%2'])
  const broadcasts: ServerMessage[] = []
  const hub = new AgentHostHub({
    paneExists: (paneId) => panes.has(paneId),
    targetIdFor: (paneId) => `target-${paneId.slice(1)}`,
    broadcast: (message) => broadcasts.push(message),
    ...(options.verifyHost ? { verifyHost: options.verifyHost } : {}),
    ...(options.now ? { now: options.now } : {}),
    ...(options.currentHostBuild ? { currentHostBuild: options.currentHostBuild } : {}),
    ...(options.handoffs ? { handoffs: options.handoffs } : {}),
    ...(options.replyImages ? { replyImages: options.replyImages } : {}),
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
    expect(socket.sent).toEqual([{ type: 'welcome', version: AGENT_HOST_PROTOCOL_VERSION }])
    expect(hub.states()).toEqual([expect.objectContaining({ paneId: '%1', targetId: 'target-1', hostConnected: true })])
    expect(hub.items('%1').map((entry) => entry.kind === 'assistant_message' && entry.text)).toEqual(['Hello', 'more'])
    expect(broadcasts.map((message) => message.type)).toEqual(['chat_state', 'chat_items'])
    expect(hub.owns('%1')).toBe(true)
  })

  it('attaches the local images replies show, in snapshots and streamed items, against the chat folder', async () => {
    const calls: string[] = []
    const replyImages = async (items: readonly ChatItem[], cwd: string) => items.map((entry) => {
      calls.push(`${entry.id}@${cwd}`)
      return entry.kind === 'assistant_message' ? { ...entry, images: [{ src: 'a.png', id: `${'a'.repeat(64)}.png` }] } : entry
    })
    const { hub, broadcasts, connect } = setup({ replyImages })
    const socket = connect()
    socket.host({ type: 'session_snapshot', session: session('%1'), items: [item('a', '![a](a.png)'), item('p', 'plain')] })
    socket.host({ type: 'items', paneId: '%1', items: [item('b', '![a](a.png) again')] })
    socket.host({ type: 'items', paneId: '%1', items: [item('c', 'no image')] })
    await settle()
    // Only batches with a Markdown image go through the store.
    expect(calls).toEqual(['a@/work', 'p@/work', 'b@/work'])
    expect(hub.items('%1').filter((entry) => entry.kind === 'assistant_message' && entry.images).map((entry) => entry.id)).toEqual(['a', 'p', 'b'])
    expect(broadcasts.at(-2)).toMatchObject({ type: 'chat_items', items: [{ id: 'b', images: [{ src: 'a.png' }] }] })
  })

  it('renders pr-diagram fences in snapshots and streamed items, and keeps the reply when rendering fails', async () => {
    const calls: string[] = []
    const logs: string[] = []
    let fail = false
    const hub = new AgentHostHub({
      paneExists: () => true, targetIdFor: () => undefined, broadcast: () => undefined, log: (message) => logs.push(message),
      replyDiagrams: async (items) => {
        if (fail) throw new Error('renderer exploded')
        return items.map((entry) => {
          calls.push(entry.id)
          return entry.kind === 'assistant_message' ? { ...entry, diagrams: [{ hash: 'a'.repeat(64), id: `${'b'.repeat(64)}.svg` }] } : entry
        })
      },
    })
    const socket = new FakeSocket()
    hub.connect(socket as unknown as WebSocket)
    socket.host({ type: 'session_snapshot', session: session('%1'), items: [item('a', '```pr-diagram\n{}\n```')] })
    socket.host({ type: 'items', paneId: '%1', items: [item('p', 'plain')] })
    await settle()
    fail = true
    socket.host({ type: 'items', paneId: '%1', items: [item('b', '```pr-diagram\n{}\n```')] })
    await settle()
    // Only batches that mention pr-diagram are rendered.
    expect(calls).toEqual(['a'])
    expect(hub.items('%1').map((entry) => entry.kind === 'assistant_message' && Boolean(entry.diagrams))).toEqual([true, false, false])
    expect(logs).toEqual([expect.stringContaining('renderer exploded')])
  })

  it("doesn't hold a snapshot for a render, and broadcasts the reply once its diagram is ready", async () => {
    const diagram = { hash: 'a'.repeat(64), id: `${'b'.repeat(64)}.svg` }
    let ready = false
    const finished: (() => void)[] = []
    const calls: string[] = []
    const replyDiagrams = async (items: readonly ChatItem[], cwd: string, wait?: { onRendered?: (ids: string[]) => void }) => items.map((entry) => {
      const onRendered = wait?.onRendered
      if (entry.kind !== 'assistant_message') return entry
      calls.push(`${entry.id}@${cwd}`)
      if (ready) return { ...entry, diagrams: [diagram] }
      if (onRendered && entry.text.includes('pr-diagram')) finished.push(() => onRendered([entry.id]))
      return entry
    })
    const broadcasts: ServerMessage[] = []
    const hub = new AgentHostHub({ paneExists: () => true, targetIdFor: () => undefined, broadcast: (message) => broadcasts.push(message), replyDiagrams })
    const socket = new FakeSocket()
    hub.connect(socket as unknown as WebSocket)
    socket.host({ type: 'session_snapshot', session: session('%1'), items: [item('a', '```pr-diagram\n{}\n```'), item('p', 'plain')] })
    await settle()
    expect(broadcasts.map((message) => message.type)).toEqual(['chat_state'])
    expect(hub.items('%1').every((entry) => !(entry.kind === 'assistant_message' && entry.diagrams))).toBe(true)

    // Two renders finish together: the pane's reply is attached again once, and only it is sent.
    ready = true
    finished.forEach((done) => done())
    finished.forEach((done) => done())
    await settle()
    await settle()
    expect(calls).toEqual(['a@/work', 'p@/work', 'a@/work'])
    expect(broadcasts.at(-1)).toEqual({ type: 'chat_items', paneId: '%1', items: [{ ...item('a', '```pr-diagram\n{}\n```'), diagrams: [diagram] }] })
    expect(hub.items('%1')[0]).toMatchObject({ diagrams: [diagram] })
  })

  it('applies a finished render and a newer copy of the reply in the order they came', async () => {
    let onDone: ((ids: string[]) => void) | undefined
    let hold: Promise<void> | undefined
    let release!: () => void
    const replyDiagrams = async (items: readonly ChatItem[], _cwd: string, wait?: { onRendered?: (ids: string[]) => void }) => {
      onDone ??= wait?.onRendered
      const gate = hold
      hold = undefined
      if (gate) await gate
      return items.map((entry) => gate && entry.kind === 'assistant_message' ? { ...entry, diagrams: [{ hash: 'a'.repeat(64), id: `${'b'.repeat(64)}.svg` }] } : entry)
    }
    const broadcasts: ServerMessage[] = []
    const hub = new AgentHostHub({ paneExists: () => true, targetIdFor: () => undefined, broadcast: (message) => broadcasts.push(message), replyDiagrams })
    const socket = new FakeSocket()
    hub.connect(socket as unknown as WebSocket)
    socket.host({ type: 'session_snapshot', session: session('%1'), items: [item('a', 'old ```pr-diagram\n{}\n```')] })
    await settle()
    // The render finishes and the refresh starts; a newer copy of the reply arrives and waits its turn.
    hold = new Promise<void>((resolve) => { release = resolve })
    onDone?.(['a'])
    await settle()
    socket.host({ type: 'items', paneId: '%1', items: [item('a', 'new ```pr-diagram\n{}\n```')] })
    await settle()
    const sent = broadcasts.length
    release()
    await settle()
    await settle()
    const updates = broadcasts.slice(sent).flatMap((message) => message.type === 'chat_items' ? message.items : [])
    expect(updates.map((entry) => entry.kind === 'assistant_message' && entry.text.split(' ')[0])).toEqual(['old', 'new'])
    expect(hub.items('%1')[0]).toEqual(item('a', 'new ```pr-diagram\n{}\n```'))
  })

  it('applies a render that finishes during a slow snapshot once the snapshot is stored', async () => {
    const diagram = { hash: 'a'.repeat(64), id: `${'b'.repeat(64)}.svg` }
    let rendered = false
    let releaseImages!: () => void
    const imagesHeld = new Promise<void>((resolve) => { releaseImages = resolve })
    const broadcasts: ServerMessage[] = []
    const hub = new AgentHostHub({
      paneExists: () => true, targetIdFor: () => undefined, broadcast: (message) => broadcasts.push(message),
      replyDiagrams: async (items, _cwd, wait) => items.map((entry) => {
        if (entry.kind !== 'assistant_message') return entry
        if (rendered) return { ...entry, diagrams: [diagram] }
        // The render finishes straight away, while the snapshot still waits on its images.
        queueMicrotask(() => { rendered = true; wait?.onRendered?.([entry.id]) })
        return entry
      }),
      replyImages: async (items) => { await imagesHeld; return [...items] },
    })
    const socket = new FakeSocket()
    hub.connect(socket as unknown as WebSocket)
    socket.host({ type: 'session_snapshot', session: session('%1'), items: [item('a', '![x](x.png) ```pr-diagram\n{}\n```')] })
    await settle()
    expect(hub.items('%1')).toEqual([])
    releaseImages()
    await settle()
    await settle()
    expect(hub.items('%1')[0]).toMatchObject({ diagrams: [diagram] })
    expect(broadcasts.at(-1)).toMatchObject({ type: 'chat_items', items: [{ id: 'a', diagrams: [diagram] }] })
  })

  it('applies a render that finishes during a slow live update to the newest copy of the reply', async () => {
    const diagram = { hash: 'a'.repeat(64), id: `${'b'.repeat(64)}.svg` }
    let rendered = false
    let hold: Promise<void> | undefined
    let releaseImages!: () => void
    const broadcasts: ServerMessage[] = []
    const hub = new AgentHostHub({
      paneExists: () => true, targetIdFor: () => undefined, broadcast: (message) => broadcasts.push(message),
      replyDiagrams: async (items, _cwd, wait) => items.map((entry) => {
        if (entry.kind !== 'assistant_message') return entry
        if (rendered) return { ...entry, diagrams: [diagram] }
        if (entry.text.includes('done')) queueMicrotask(() => { rendered = true; wait?.onRendered?.([entry.id]) })
        return entry
      }),
      replyImages: async (items) => { if (hold) await hold; return [...items] },
    })
    const socket = new FakeSocket()
    hub.connect(socket as unknown as WebSocket)
    socket.host({ type: 'session_snapshot', session: session('%1'), items: [item('a', 'streaming ![x](x.png)', { status: 'running' })] })
    await settle()
    hold = new Promise<void>((resolve) => { releaseImages = resolve })
    socket.host({ type: 'items', paneId: '%1', items: [item('a', 'done ![x](x.png) ```pr-diagram\n{}\n```')] })
    await settle()
    releaseImages()
    await settle()
    await settle()
    const [stored] = hub.items('%1')
    expect(stored).toMatchObject({ text: 'done ![x](x.png) ```pr-diagram\n{}\n```', status: 'completed', diagrams: [diagram] })
    // No update re-sent the streaming copy.
    expect(broadcasts.filter((message) => message.type === 'chat_items').flatMap((message) => message.type === 'chat_items' ? message.items : [])
      .every((entry) => entry.kind === 'assistant_message' && entry.text.startsWith('done'))).toBe(true)
  })

  it('lets a subagent transcript wait briefly for its diagrams', async () => {
    const waits: unknown[] = []
    const hub = new AgentHostHub({
      paneExists: () => true, targetIdFor: () => undefined, broadcast: () => undefined,
      replyDiagrams: async (items, _cwd, wait) => { waits.push(wait); return [...items] },
    })
    const socket = new FakeSocket()
    hub.connect(socket as unknown as WebSocket)
    socket.host({ type: 'session_snapshot', session: session('%1', { hostVersion: AGENT_HOST_PROTOCOL_VERSION }), items: [] })
    await settle()
    const read = hub.subagentTranscript('%1', 'a711')
    const request = socket.sent.at(-1) as { requestId: string }
    socket.host({ type: 'subagent_transcript_result', paneId: '%1', requestId: request.requestId, items: [item('s', '```pr-diagram\n{}\n```')] })
    await read
    expect(waits).toEqual([{ waitMs: 3000 }])
  })

  it('shows replies without their images when storing them fails', async () => {
    const logs: string[] = []
    const hub = new AgentHostHub({
      paneExists: () => true, targetIdFor: () => undefined, broadcast: () => undefined, log: (message) => logs.push(message),
      replyImages: async () => { throw new Error('disk full') },
    })
    const socket = new FakeSocket()
    hub.connect(socket as unknown as WebSocket)
    socket.host({ type: 'session_snapshot', session: session('%1'), items: [item('a', '![a](a.png)')] })
    await settle()
    expect(hub.items('%1')).toEqual([item('a', '![a](a.png)')])
    expect(logs).toEqual([expect.stringContaining('disk full')])
  })

  it('replaces the timeline when the host starts the conversation over', async () => {
    const { hub, broadcasts, connect } = setup()
    const socket = connect()
    socket.host({ type: 'session_snapshot', session: session('%1'), items: [item('a', 'old'), item('b', 'older')] })
    socket.host({ type: 'items', paneId: '%1', items: [item('n', 'cleared')], replace: true })
    await settle()
    expect(hub.items('%1').map((entry) => entry.id)).toEqual(['n'])
    expect(broadcasts.at(-1)).toEqual({ type: 'chat_items', paneId: '%1', items: [item('n', 'cleared')], replace: true })
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
    expect(impostor.closeCode).toBe(4003)
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

  it('routes picker changes to the host and reports the settings a resume should carry', async () => {
    const { hub, connect } = setup()
    const socket = connect()
    socket.host({ type: 'session_snapshot', session: session('%1', { hostVersion: 2, permissionMode: 'default', selectedModel: 'haiku' }), items: [] })
    await settle()
    socket.sent = []
    expect(hub.configure('%1', { model: 'sonnet', effort: 'high' }, 'q1')).toBe(true)
    expect(hub.configure('%2', { effort: 'low' }, 'q2')).toBe(false)
    expect(socket.sent).toEqual([{ type: 'configure', paneId: '%1', settings: { model: 'sonnet', effort: 'high' }, requestId: 'q1' }])
    socket.host({ type: 'session_update', session: session('%1', { hostVersion: 2, permissionMode: 'plan', prePlanPermissionMode: 'acceptEdits', selectedModel: 'sonnet', effort: 'high', fast: true, bypassAllowed: true }) })
    await settle()
    expect(hub.resumeSettings('%1')).toEqual({ model: 'sonnet', effort: 'high', fast: true, permissionMode: 'plan', prePlanPermissionMode: 'acceptEdits', bypassAllowed: true })
    expect(hub.resumeSettings('%2')).toBeUndefined()
  })

  it('trusts no settings from a host older than the pickers, and logs messages it drops', async () => {
    const logs: string[] = []
    const hub = new AgentHostHub({ paneExists: () => true, targetIdFor: () => undefined, broadcast: () => {}, log: (line) => logs.push(line) })
    const socket = new FakeSocket()
    hub.connect(socket as unknown as WebSocket)
    // A host from before this protocol: it was launched with --model, which its settings omit.
    socket.host({ type: 'session_snapshot', session: session('%1', { hostVersion: 1, permissionMode: 'default', model: 'claude-opus-5-5' }), items: [] })
    socket.host({ type: 'session_update', session: { paneId: '%1' } })
    await settle()
    expect(hub.resumeSettings('%1')).toBeUndefined()
    expect(logs).toEqual(['[agent-host] dropped an invalid session_update message from a host'])
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

describe('host updates', () => {
  it('flags a host whose build differs from the checkout, and routes a restart to it', async () => {
    let current = 'build-a'
    const { hub, broadcasts, connect } = setup({ currentHostBuild: async () => current })
    const socket = connect()
    socket.host({ type: 'session_snapshot', session: session('%1', { hostBuild: 'build-a' }), items: [] })
    await settle()
    expect(hub.states()[0]?.updateAvailable).toBeUndefined()
    current = 'build-b'
    await hub.reconcile()
    expect(hub.states()[0]?.updateAvailable).toBe(true)
    expect(broadcasts.at(-1)).toMatchObject({ type: 'chat_state', chat: { updateAvailable: true } })
    socket.sent = []
    expect(hub.restart('%1', 'r1')).toBe(true)
    expect(socket.sent).toEqual([{ type: 'restart', paneId: '%1', requestId: 'r1' }])
  })
})

describe('host registration races', () => {
  it('does not register a host whose socket closed while its snapshot was being checked', async () => {
    let release!: (build: string) => void
    const { hub, connect } = setup({ currentHostBuild: () => new Promise((resolve) => { release = resolve }) })
    const socket = connect()
    socket.host({ type: 'session_snapshot', session: session('%1', { hostBuild: 'a' }), items: [] })
    await settle()
    socket.close()
    release('a')
    await settle()
    expect(hub.owns('%1')).toBe(false)
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

describe('AgentHostHub richer input', () => {
  const imageId = `${'a'.repeat(64)}.png`

  it('keeps the command list on the chat and relays changes', async () => {
    const { hub, broadcasts, connect } = setup()
    const socket = connect()
    socket.host({ type: 'session_snapshot', session: session('%1', { hostVersion: 3 }), items: [] })
    socket.host({ type: 'commands', paneId: '%1', commands: [{ name: 'compact', description: 'Free context', kind: 'command' }] })
    await settle()
    expect(hub.states()[0]?.commands).toEqual([{ name: 'compact', description: 'Free context', kind: 'command' }])
    expect(broadcasts.at(-1)).toEqual({ type: 'chat_commands', paneId: '%1', commands: [{ name: 'compact', description: 'Free context', kind: 'command' }] })
    // A reconnecting host keeps the menu until it resends the list.
    socket.host({ type: 'session_snapshot', session: session('%1', { hostVersion: 3 }), items: [] })
    await settle()
    expect(hub.states()[0]?.commands).toHaveLength(1)
  })

  it('asks the host for files and resolves with its answer only', async () => {
    const { hub, connect } = setup()
    const socket = connect()
    const other = connect()
    socket.host({ type: 'session_snapshot', session: session('%1', { hostVersion: 3 }), items: [] })
    await settle()
    const pending = hub.searchFiles('%1', 'comp')
    const request = socket.sent.at(-1) as { type: string; requestId: string; query: string }
    expect(request).toMatchObject({ type: 'file_search', paneId: '%1', query: 'comp' })
    // Another host can't answer this pane's search.
    other.host({ type: 'file_search_result', paneId: '%1', requestId: request.requestId, entries: [{ path: 'evil', kind: 'file' }], truncated: false })
    socket.host({ type: 'file_search_result', paneId: '%1', requestId: request.requestId, entries: [{ path: 'src/Composer.tsx', kind: 'file' }], truncated: true })
    expect(await pending).toEqual({ entries: [{ path: 'src/Composer.tsx', kind: 'file' }], truncated: true })
  })

  it('answers a search with an error when the host is old, gone or disconnects', async () => {
    const { hub, connect } = setup()
    const socket = connect()
    socket.host({ type: 'session_snapshot', session: session('%1', { hostVersion: 2 }), items: [] })
    await settle()
    expect((await hub.searchFiles('%1', 'x')).error).toMatch(/Restart this chat/)
    expect((await hub.searchFiles('%2', 'x')).error).toMatch(/No agent host/)
    socket.host({ type: 'session_snapshot', session: session('%1', { hostVersion: 3 }), items: [] })
    await settle()
    const pending = hub.searchFiles('%1', 'x')
    socket.close()
    expect((await pending).error).toMatch(/disconnected/)
  })

  it('forwards image refs only to hosts that take them', async () => {
    const { hub, connect } = setup()
    const socket = connect()
    socket.host({ type: 'session_snapshot', session: session('%1', { hostVersion: 2 }), items: [] })
    await settle()
    expect(hub.takesInput('%1')).toBe(false)
    socket.host({ type: 'session_snapshot', session: session('%1', { hostVersion: 3 }), items: [] })
    await settle()
    expect(hub.takesInput('%1')).toBe(true)
    expect(hub.send('%1', 'look', 'r1', [{ id: imageId, name: 'a.png' }])).toBe(true)
    expect(socket.sent.at(-1)).toEqual({ type: 'send', paneId: '%1', text: 'look', images: [{ id: imageId, name: 'a.png' }], requestId: 'r1' })
    hub.send('%1', 'plain', 'r2')
    expect(socket.sent.at(-1)).toEqual({ type: 'send', paneId: '%1', text: 'plain', requestId: 'r2' })
  })

  it('routes queue changes, subagent controls, steers and dropped queue ids only to hosts that take them', async () => {
    const { hub, connect } = setup()
    const socket = connect()
    socket.host({ type: 'session_snapshot', session: session('%1', { hostVersion: 3 }), items: [] })
    await settle()
    expect(hub.takesTurnFlow('%1')).toBe(false)
    expect(hub.updateQueue('%1', { action: 'remove', id: 'q1' }, 'r0')).toBe(false)
    expect(hub.controlTask('%1', 'stop', 'a711', 'toolu_1', 'r0')).toBe(false)
    socket.host({ type: 'session_snapshot', session: session('%1', { hostVersion: 7 }), items: [] })
    await settle()
    expect(hub.takesSteerAll('%1')).toBe(false)
    expect(hub.updateQueue('%1', { action: 'steer_all' }, 'r0')).toBe(false)
    socket.host({ type: 'session_snapshot', session: session('%1', { hostVersion: AGENT_HOST_PROTOCOL_VERSION }), items: [] })
    await settle()
    expect(hub.updateQueue('%1', { action: 'edit', id: 'q1', text: 'new' }, 'r1')).toBe(true)
    expect(socket.sent.at(-1)).toEqual({ type: 'queue', paneId: '%1', requestId: 'r1', action: 'edit', id: 'q1', text: 'new' })
    expect(hub.updateQueue('%1', { action: 'steer_all' }, 'r1b')).toBe(true)
    expect(socket.sent.at(-1)).toEqual({ type: 'queue', paneId: '%1', requestId: 'r1b', action: 'steer_all' })
    expect(hub.controlTask('%1', 'background', 'a711', 'toolu_1', 'r2')).toBe(true)
    expect(socket.sent.at(-1)).toEqual({ type: 'task', paneId: '%1', action: 'background', agentId: 'a711', toolUseId: 'toolu_1', requestId: 'r2' })
    hub.send('%1', 'now', 'r3', [], { delivery: 'steer' })
    expect(socket.sent.at(-1)).toEqual({ type: 'send', paneId: '%1', text: 'now', delivery: 'steer', requestId: 'r3' })
    hub.interrupt('%1', 'r4', ['q1'])
    expect(socket.sent.at(-1)).toEqual({ type: 'interrupt', paneId: '%1', requestId: 'r4', dropQueued: ['q1'] })
  })

  it('asks the host for a subagent transcript and answers only with its own reply', async () => {
    const { hub, connect } = setup()
    const socket = connect()
    const other = connect()
    expect((await hub.subagentTranscript('%1', 'a711')).error).toMatch(/No agent host/)
    socket.host({ type: 'session_snapshot', session: session('%1', { hostVersion: 3 }), items: [] })
    await settle()
    expect((await hub.subagentTranscript('%1', 'a711')).error).toMatch(/Restart this chat/)
    socket.host({ type: 'session_snapshot', session: session('%1', { hostVersion: AGENT_HOST_PROTOCOL_VERSION }), items: [] })
    await settle()
    const pending = hub.subagentTranscript('%1', 'a711')
    const request = socket.sent.at(-1) as { type: string; requestId: string }
    expect(request).toMatchObject({ type: 'subagent_transcript', paneId: '%1', agentId: 'a711' })
    other.host({ type: 'subagent_transcript_result', paneId: '%1', requestId: request.requestId, items: [item('evil', 'x')] })
    socket.host({ type: 'subagent_transcript_result', paneId: '%1', requestId: request.requestId, items: [item('m1', 'It is Sunday.')] })
    expect((await pending).items.map((entry) => entry.id)).toEqual(['m1'])
    const dropped = hub.subagentTranscript('%1', 'a711')
    socket.close()
    expect((await dropped).error).toMatch(/disconnected/)
  })

  it('relays MCP requests to hosts that manage them and answers only with their own reply', async () => {
    const { hub, connect } = setup()
    const socket = connect()
    const other = connect()
    expect((await hub.mcp('%1', { action: 'status' })).error).toMatch(/No agent host/)
    socket.host({ type: 'session_snapshot', session: session('%1', { hostVersion: 5 }), items: [] })
    await settle()
    expect((await hub.mcp('%1', { action: 'status' })).error).toMatch(/Restart this chat/)
    socket.host({ type: 'session_snapshot', session: session('%1', { hostVersion: AGENT_HOST_PROTOCOL_VERSION }), items: [] })
    await settle()
    const pending = hub.mcp('%1', { action: 'disable', server: 'github' })
    const request = socket.sent.at(-1) as { type: string; requestId: string }
    expect(request).toMatchObject({ type: 'mcp', paneId: '%1', request: { action: 'disable', server: 'github' } })
    other.host({ type: 'mcp_result', paneId: '%1', requestId: request.requestId, servers: [] })
    socket.host({ type: 'mcp_result', paneId: '%1', requestId: request.requestId, servers: [{ name: 'github', status: 'disabled', tools: [] }], authUrl: 'javascript:alert(1)' })
    expect(await pending).toEqual({ servers: [{ name: 'github', status: 'disabled', tools: [] }] })
    const dropped = hub.mcp('%1', { action: 'status' })
    socket.close()
    expect((await dropped).error).toMatch(/disconnected/)
  })
})

describe('AgentHostHub switch to Claude Code', () => {
  const image = { id: `${'a'.repeat(64)}.png`, name: 'shot.png' }

  function switchable(save: (entry: unknown) => Promise<void> = async () => undefined) {
    const saved: unknown[] = []
    const taken: string[] = []
    const discarded: string[] = []
    let carried: { id: string; text: string; images: typeof image[] } | undefined
    const handoffs = {
      save: async (entry: unknown) => { saved.push(entry); await save(entry) },
      returned: () => carried,
      take: (_sessionId: string, carryId: string, images?: number) => {
        taken.push(carryId)
        return images === 0 ? { id: 'carry-2', text: '', images: [image] } : undefined
      },
      discard: (sessionId: string) => { discarded.push(sessionId); return true },
    }
    const run = setup({ handoffs })
    return { ...run, saved, taken, discarded, setCarried: (value: typeof carried) => { carried = value } }
  }

  it("relays a switch, keeps the client's draft, and saves it with the host's queue before the host goes", async () => {
    const { hub, connect, saved } = switchable()
    const socket = connect()
    socket.host({ type: 'session_snapshot', session: session('%1', { hostVersion: 5, sessionId: 'abcd1234-0000' }), items: [] })
    await settle()
    expect(hub.switchToClaudeCode('%1', 'after_turn', { text: 'draft', images: [image] }, 'r1')).toBeNull()
    expect(socket.sent.at(-1)).toEqual({ type: 'switch', paneId: '%1', action: 'after_turn', requestId: 'r1' })
    socket.host({ type: 'handoff', paneId: '%1', sessionId: 'abcd1234-0000', cwd: '/work', queue: [{ id: 'q1', text: 'queued' }], returnFlags: ['--permission-mode', 'default'] })
    await settle()
    expect(saved).toEqual([{ sessionId: 'abcd1234-0000', cwd: '/work', returnFlags: ['--permission-mode', 'default'], draft: { text: 'draft', images: [image] }, queue: [{ id: 'q1', text: 'queued' }] }])
    expect(socket.sent.at(-1)).toEqual({ type: 'handoff_saved', paneId: '%1', ok: true })
  })

  it('persists the Codex handoff provider and pane before any TUI hooks exist', async () => {
    const { hub, connect, saved } = switchable()
    const socket = connect()
    socket.host({ type: 'session_snapshot', session: session('%1', { provider: 'codex', hostVersion: 5, sessionId: 'codex-thread' }), items: [] })
    await settle()
    expect(hub.switchToClaudeCode('%1', 'after_turn', { text: 'draft', images: [] }, 'r1')).toBeNull()
    socket.host({ type: 'handoff', paneId: '%1', provider: 'codex', sessionId: 'codex-thread', cwd: '/work', queue: [], returnFlags: ['--permission-mode', 'plan'] })
    await settle()
    expect(saved).toEqual([{
      paneId: '%1', provider: 'codex', sessionId: 'codex-thread', cwd: '/work', queue: [],
      returnFlags: ['--permission-mode', 'plan'], draft: { text: 'draft', images: [] },
    }])
    expect(socket.sent.at(-1)).toEqual({ type: 'handoff_saved', paneId: '%1', ok: true })
  })

  it('refuses a switch for a host that predates it, and a handoff for another conversation', async () => {
    const { hub, connect, saved } = switchable()
    const old = connect()
    old.host({ type: 'session_snapshot', session: session('%1', { hostVersion: 4, sessionId: 'abcd1234-0000' }), items: [] })
    await settle()
    expect(hub.switchToClaudeCode('%1', 'now', undefined, 'r1')).toMatch(/restart it to switch/)
    expect(hub.switchToClaudeCode('%2', 'now', undefined, 'r2')).toMatch(/No agent host/)
    const current = connect()
    current.host({ type: 'session_snapshot', session: session('%2', { hostVersion: 5, sessionId: 'abcd1234-0000' }), items: [] })
    current.host({ type: 'handoff', paneId: '%2', sessionId: 'ffff1234-0000', cwd: '/work', queue: [], returnFlags: [] })
    await settle()
    expect(saved).toEqual([])
    expect(current.sent.at(-1)).toMatchObject({ type: 'handoff_saved', ok: false })
  })

  it('tells the host when the draft and queue could not be kept', async () => {
    const { connect } = switchable(async () => { throw new Error('disk full') })
    const socket = connect()
    socket.host({ type: 'session_snapshot', session: session('%1', { hostVersion: 5, sessionId: 'abcd1234-0000' }), items: [] })
    socket.host({ type: 'handoff', paneId: '%1', sessionId: 'abcd1234-0000', cwd: '/work', queue: [], returnFlags: [] })
    await settle()
    expect(socket.sent.at(-1)).toEqual({ type: 'handoff_saved', paneId: '%1', ok: false, error: "Commando couldn't save the chat's draft and queue: disk full" })
  })

  it('offers a returned chat what it carried until a composer takes it', async () => {
    const { hub, connect, broadcasts, taken, setCarried } = switchable()
    setCarried({ id: 'carry-1', text: 'queued\n\ndraft', images: [image] })
    const socket = connect()
    socket.host({ type: 'session_snapshot', session: session('%1', { hostVersion: 5, sessionId: 'abcd1234-0000' }), items: [] })
    await settle()
    expect(hub.states()[0]?.carried).toEqual({ id: 'carry-1', text: 'queued\n\ndraft', images: [image] })
    expect(hub.takeCarried('%1', 'other')).toBe(false)
    expect(hub.takeCarried('%1', 'carry-1')).toBe(true)
    expect(taken).toEqual(['carry-1'])
    expect(hub.states()[0]?.carried).toBeUndefined()
    expect(broadcasts.at(-1)).toMatchObject({ type: 'chat_state', chat: { paneId: '%1' } })
  })

  it('offers images that did not fit again under a new id', async () => {
    const { hub, connect, broadcasts, setCarried } = switchable()
    setCarried({ id: 'carry-1', text: 'draft', images: [image] })
    const socket = connect()
    socket.host({ type: 'session_snapshot', session: session('%1', { hostVersion: 5, sessionId: 'abcd1234-0000' }), items: [] })
    await settle()
    expect(hub.takeCarried('%1', 'carry-1', 0)).toBe(true)
    expect(hub.states()[0]?.carried).toEqual({ id: 'carry-2', text: '', images: [image] })
    expect(broadcasts.at(-1)).toMatchObject({ type: 'chat_state', chat: { carried: { id: 'carry-2' } } })
  })

  it('ends the chat as soon as a host that handed over goes, and forgets a switch the host gave up on', async () => {
    const { hub, connect, broadcasts, discarded } = switchable()
    const socket = connect()
    const switching = session('%1', { hostVersion: 5, sessionId: 'abcd1234-0000', claudeCodeSwitch: 'switching' })
    socket.host({ type: 'session_snapshot', session: switching, items: [] })
    socket.host({ type: 'handoff', paneId: '%1', sessionId: 'abcd1234-0000', cwd: '/work', queue: [], returnFlags: [] })
    await settle()
    socket.close()
    expect(hub.states()).toEqual([])
    expect(broadcasts.at(-1)).toEqual({ type: 'chat_removed', paneId: '%1' })

    const other = connect()
    other.host({ type: 'session_snapshot', session: switching, items: [] })
    other.host({ type: 'handoff', paneId: '%1', sessionId: 'abcd1234-0000', cwd: '/work', queue: [], returnFlags: [] })
    other.host({ type: 'session_update', session: { ...switching, claudeCodeSwitch: undefined } })
    await settle()
    expect(discarded).toEqual(['abcd1234-0000'])
    other.close()
    expect(hub.states()[0]).toMatchObject({ hostConnected: false })
  })

  it('carries an untaken draft across again, and keeps the draft when Cancel comes too late', async () => {
    const { hub, connect, saved, setCarried } = switchable()
    setCarried({ id: 'carry-1', text: 'from last time', images: [image] })
    const socket = connect()
    socket.host({ type: 'session_snapshot', session: session('%1', { hostVersion: 5, sessionId: 'abcd1234-0000', claudeCodeSwitch: 'switching' }), items: [] })
    await settle()
    hub.switchToClaudeCode('%1', 'after_turn', { text: 'typed now', images: [] }, 'r1')
    hub.switchToClaudeCode('%1', 'cancel', undefined, 'r2')
    socket.host({ type: 'handoff', paneId: '%1', sessionId: 'abcd1234-0000', cwd: '/work', queue: [], returnFlags: [] })
    await settle()
    expect(saved).toEqual([expect.objectContaining({ draft: { text: 'from last time\n\ntyped now', images: [image] } })])
  })
})

describe('aside hub routing', () => {
  const aside = { parentPaneId: '%1', id: 'abcd1234', title: 'Why?', mode: 'read-only' as const, method: 'fork' as const, readOnlyEnforced: true, forkedFrom: { sessionId: 'main', at: 'turn' }, createdAt: 1 }
  it('verifies the parent pane, relays all composer paths, and keeps aside status and requests out of pane integrations', async () => {
    const checks: string[] = []
    const statuses: unknown[] = []
    const requests: unknown[] = []
    const broadcasts: ServerMessage[] = []
    const hub = new AgentHostHub({
      paneExists: (paneId) => paneId === '%1', targetIdFor: (paneId) => `target-${paneId}`,
      verifyHost: async (paneId) => { checks.push(paneId); return paneId === '%1' },
      broadcast: (message) => broadcasts.push(message),
      interactions: { status: (...args) => statuses.push(args), open: (...args) => requests.push(args), close: (...args) => requests.push(args) },
    })
    const socket = new FakeSocket()
    hub.connect(socket as unknown as WebSocket)
    socket.host({ type: 'session_snapshot', session: session('%1', { hostVersion: 9, sessionId: 'main' }), items: [] })
    socket.host({ type: 'session_snapshot', session: session('%1~abcd1234', { hostVersion: 9, sessionId: 'child', aside }), items: [] })
    await settle()
    const statusCount = statuses.length
    socket.host({ type: 'items', paneId: '%1~abcd1234', items: [{ ...item('request', ''), kind: 'request', requestId: 'ask', requestKind: 'approval', toolName: 'Bash', title: 'Allow?' }] })
    socket.host({ type: 'session_update', session: session('%1~abcd1234', { hostVersion: 9, sessionId: 'child', status: 'waiting', aside }) })
    await settle()
    expect(checks).toEqual(['%1', '%1'])
    expect(statuses).toHaveLength(statusCount)
    expect(requests).toEqual([])
    expect(hub.states()[1]?.targetId).toBe('target-%1')
    expect(hub.send('%1~abcd1234', 'Hello', 's')).toBe(true)
    expect(hub.updateQueue('%1~abcd1234', { action: 'steer_all' }, 'q')).toBe(true)
    expect(hub.interrupt('%1~abcd1234', 'i')).toBe(true)
    expect(hub.configure('%1~abcd1234', { model: 'sonnet' }, 'c')).toBe(true)
    expect(hub.answer('%1~abcd1234', 'ask', { kind: 'approval', decision: 'deny' }, 'a')).toBe(true)
    const files = hub.searchFiles('%1~abcd1234', 'src')
    const transcript = hub.subagentTranscript('%1~abcd1234', 'abc123')
    const mcp = hub.mcp('%1~abcd1234', { action: 'status' })
    for (const request of socket.sent as { type: string; paneId: string; requestId: string }[]) {
      if (request.type === 'file_search') socket.host({ type: 'file_search_result', paneId: request.paneId, requestId: request.requestId, entries: [], truncated: false })
      if (request.type === 'subagent_transcript') socket.host({ type: 'subagent_transcript_result', paneId: request.paneId, requestId: request.requestId, items: [] })
      if (request.type === 'mcp') socket.host({ type: 'mcp_result', paneId: request.paneId, requestId: request.requestId, servers: [] })
    }
    expect(await files).toEqual({ entries: [], truncated: false })
    expect(await transcript).toEqual({ items: [] })
    expect(await mcp).toEqual({ servers: [] })
    await hub.reconcile()
    expect(hub.owns('%1~abcd1234')).toBe(true)
    expect(hub.isAsideSession('%1', 'child')).toBe(true)
    socket.host({ type: 'session_closed', paneId: '%1' })
    await settle()
    expect(hub.states()).toEqual([])
    expect(broadcasts.filter((message) => message.type === 'chat_removed')).toEqual([{ type: 'chat_removed', paneId: '%1~abcd1234' }, { type: 'chat_removed', paneId: '%1' }])
    expect(requests).toEqual([])
  })
  it('matches lifecycle results by request, pane and socket, updates main state and rejects old hosts', async () => {
    const { hub, broadcasts, connect } = setup()
    const socket = connect()
    socket.host({ type: 'session_snapshot', session: session('%1', { hostVersion: 9 }), items: [] })
    await settle()
    const pending = hub.aside('%1', { action: 'open', text: 'Why?' })
    const request = socket.sent.at(-1) as { requestId: string }
    const impostor = connect()
    impostor.host({ type: 'aside_result', paneId: '%1', requestId: request.requestId, ok: false, error: 'wrong socket' })
    socket.host({ type: 'aside_result', paneId: '%2', requestId: request.requestId, ok: false, error: 'wrong pane' })
    socket.host({ type: 'asides', paneId: '%1', asides: [{ ...aside, parentPaneId: undefined, sessionId: 'child', status: 'closed', closedAt: 2 }] })
    socket.host({ type: 'aside_result', paneId: '%1', requestId: request.requestId, ok: true, asideId: aside.id })
    expect(await pending).toEqual({ ok: true, asideId: aside.id })
    expect(hub.states()[0]?.asides?.[0]).toMatchObject({ id: aside.id, status: 'closed' })
    expect(hub.isAsideSession('%1', 'child')).toBe(true)
    expect(broadcasts.at(-1)?.type).toBe('chat_asides')
    socket.host({ type: 'session_snapshot', session: session('%2', { hostVersion: 8 }), items: [] })
    await settle()
    expect(await hub.aside('%2', { action: 'open', text: 'Why?' })).toMatchObject({ ok: false, error: expect.stringContaining('Restart') })
    const disconnected = hub.aside('%1', { action: 'close', asideId: aside.id })
    socket.close()
    expect(await disconnected).toMatchObject({ ok: false, error: expect.stringContaining('disconnected') })
    impostor.close()
  })
  it('rejects aside snapshots from a different parent owner or host pid', async () => {
    const { hub, broadcasts, connect } = setup()
    const owner = connect(), impostor = connect()
    owner.host({ type: 'session_snapshot', session: session('%1', { hostVersion: 9 }), items: [] })
    await settle()
    const aside = { parentPaneId: '%1', id: 'abcd1234', title: 'Side', mode: 'read-only', method: 'fork', readOnlyEnforced: true, forkedFrom: { sessionId: 'main' }, createdAt: 1 }
    const child = session('%1~abcd1234', { hostVersion: 9, aside: aside as ChatSessionInfo['aside'] })
    impostor.host({ type: 'session_snapshot', session: child, items: [] })
    owner.host({ type: 'session_snapshot', session: { ...child, hostPid: 99 }, items: [] })
    await settle()
    expect(hub.states().map((state) => state.paneId)).toEqual(['%1'])
    expect(broadcasts.filter((message) => message.type === 'chat_state')).toHaveLength(1)
    owner.host({ type: 'session_snapshot', session: child, items: [] })
    await settle()
    expect(hub.owns(child.paneId)).toBe(true)
    owner.close(); impostor.close()
  })
  it('relays read failures, retains them across snapshots and clears them after recovery', async () => {
    const { hub, broadcasts, connect } = setup()
    const socket = connect()
    socket.host({ type: 'session_snapshot', session: session('%1'), items: [] })
    socket.host({ type: 'asides', paneId: '%1', asides: [], error: 'EACCES' })
    await settle()
    expect(hub.states()[0]?.asidesError).toBe('EACCES')
    expect(broadcasts.at(-1)).toEqual({ type: 'chat_asides', paneId: '%1', asides: [], error: 'EACCES' })
    socket.host({ type: 'session_snapshot', session: session('%1'), items: [] })
    await settle()
    expect(hub.states()[0]?.asidesError).toBe('EACCES')
    socket.host({ type: 'asides', paneId: '%1', asides: [] })
    await settle()
    expect(hub.states()[0]?.asidesError).toBeUndefined()
    expect(broadcasts.at(-1)).toEqual({ type: 'chat_asides', paneId: '%1', asides: [] })
    socket.close()
  })
})
