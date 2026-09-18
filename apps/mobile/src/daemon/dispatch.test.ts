import type { ClientMessage, ServerMessage } from '@commando/protocol'

import type { Host } from '../hosts/types'
import { SNAPSHOT } from '../testing/fixtures'

/**
 * `client.ts` captures the global `WebSocket` when it is first imported, so the
 * double has to be installed before the module is required.
 */
class FakeSocket {
  static last: FakeSocket | null = null

  readyState = 0
  sent: string[] = []
  onopen: (() => void) | null = null
  onmessage: ((event: { data?: unknown }) => void) | null = null
  onerror: (() => void) | null = null
  onclose: ((event: { code?: number; reason?: string }) => void) | null = null

  constructor(readonly url: string) {
    FakeSocket.last = this
  }

  send(data: string): void {
    this.sent.push(data)
  }

  close(): void {
    this.readyState = 3
    this.onclose?.({ code: 1000, reason: 'closed' })
  }

  open(): void {
    this.readyState = 1
    this.onopen?.()
  }

  deliver(message: ServerMessage): void {
    this.onmessage?.({ data: JSON.stringify(message) })
  }

  /** Every `ClientMessage` this socket was asked to carry, already parsed. */
  outgoing(): ClientMessage[] {
    return this.sent.map((raw) => JSON.parse(raw) as ClientMessage)
  }
}

const originalWebSocket = globalThis.WebSocket
globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket

/* eslint-disable @typescript-eslint/no-require-imports */
const { DaemonClient } = require('./client') as typeof import('./client')
const { useDaemonStore } = require('./store') as typeof import('./store')
/* eslint-enable @typescript-eslint/no-require-imports */

afterAll(() => {
  globalThis.WebSocket = originalWebSocket
})

const HOST: Host = {
  id: 'studio',
  name: 'studio',
  baseUrl: 'http://studio.tail-1a2b.ts.net:4310',
  auth: { kind: 'token', token: 'secret' },
}

function connect(): { client: InstanceType<typeof DaemonClient>; socket: FakeSocket } {
  const client = new DaemonClient({ host: HOST })
  client.start()
  const socket = FakeSocket.last
  if (!socket) throw new Error('the client did not open a socket')
  socket.open()
  return { client, socket }
}

beforeEach(() => {
  FakeSocket.last = null
  useDaemonStore.setState({ byHost: {} })
})

describe('server message dispatch', () => {
  it('folds every message into the store, then the pane, then the listeners', () => {
    const { client, socket } = connect()
    const seen: ServerMessage[] = []
    const paneMessages: ServerMessage[] = []
    client.subscribe((message) => seen.push(message))
    client.subscribePane('%14', (message) => paneMessages.push(message))

    socket.deliver({ type: 'snapshot', snapshot: SNAPSHOT })
    socket.deliver({
      type: 'pane_data',
      paneId: '%14',
      data: 'aGk=',
      encoding: 'base64',
      revision: 2,
    })

    // The pane bytes reach the pane exactly once, and the listeners see both
    // messages — a pane stream is not a reason to stop the fan-out.
    expect(paneMessages).toHaveLength(1)
    expect(seen.map((message) => message.type)).toEqual(['snapshot', 'pane_data'])
    expect(useDaemonStore.getState().byHost.studio?.snapshot?.revision).toBe(41)

    client.stop()
  })

  it('correlates an answered request and an error by requestId', () => {
    const { client, socket } = connect()
    const seen: ServerMessage[] = []
    client.subscribe((message) => seen.push(message))

    socket.deliver({
      type: 'agent_request_answered',
      paneId: '%14',
      interactionId: 'req-1',
      changed: true,
      requestId: 'm-1',
    })
    socket.deliver({ type: 'error', code: 'invalid_answer', message: 'no', requestId: 'm-2' })

    expect(seen).toEqual([
      { type: 'agent_request_answered', paneId: '%14', interactionId: 'req-1', changed: true, requestId: 'm-1' },
      { type: 'error', code: 'invalid_answer', message: 'no', requestId: 'm-2' },
    ])

    client.stop()
  })
})

describe('pane subscriptions', () => {
  it('asks for a pane the snapshot did not know about yet', () => {
    const { client, socket } = connect()
    socket.deliver({ type: 'snapshot', snapshot: SNAPSHOT })

    // A pane the daemon has just created is not in the snapshot on screen, so
    // the first `subscribe` leaves it out rather than risking a protocol kill.
    client.subscribePane('%99', () => undefined)
    expect(subscribedPanes(socket)).toEqual([[]])

    socket.deliver({
      type: 'snapshot',
      snapshot: { ...SNAPSHOT, panes: [...SNAPSHOT.panes, { ...SNAPSHOT.panes[0]!, id: '%99' }] },
    })
    expect(subscribedPanes(socket)).toEqual([[], ['%99']])

    client.stop()
  })

  it('re-subscribes, re-watches and drops its leases on a reconnect', () => {
    jest.useFakeTimers()
    try {
      const { client, socket } = connect()
      socket.deliver({ type: 'snapshot', snapshot: SNAPSHOT })
      client.subscribePane('%14', () => undefined)
      client.resizePane('%14', 80, 24)
      expect(client.holdsResizeLease('%14')).toBe(true)

      socket.readyState = 3
      socket.onclose?.({ code: 1006, reason: 'gone' })
      // The daemon drops every lease a socket held when it goes away.
      expect(client.holdsResizeLease('%14')).toBe(false)

      jest.advanceTimersByTime(1_000)
      const reconnected = FakeSocket.last
      expect(reconnected).not.toBe(socket)
      reconnected?.open()

      const types = reconnected?.outgoing().map((message) => message.type)
      expect(types).toEqual(['watch_usage', 'watch_interactions', 'subscribe'])
      expect(subscribedPanes(reconnected!)).toEqual([['%14']])

      client.stop()
    } finally {
      jest.useRealTimers()
    }
  })
})

/** The pane id lists of every `subscribe` this socket was asked to carry. */
function subscribedPanes(socket: FakeSocket): string[][] {
  return socket
    .outgoing()
    .filter((message): message is Extract<ClientMessage, { type: 'subscribe' }> => (
      message.type === 'subscribe'
    ))
    .map((message) => message.paneIds)
}
