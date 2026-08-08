import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { WebSocket } from 'ws'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WebPane, WebPanePendingNote, WebPanePendingSnapshot } from '../shared/protocol.js'
import type { ChromiumEngine } from './chromium-engine.js'
import type { WebPaneService } from './web-panes.js'
import { WebTileRelay, webTilePathId } from './web-tile-relay.js'

const servers: Server[] = []
const relays: WebTileRelay[] = []
const sockets: WebSocket[] = []

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate()
  for (const relay of relays.splice(0)) relay.close()
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
})

function pane(): WebPane {
  return {
    id: 'w-11111111',
    url: 'http://127.0.0.1:5173/',
    sessionId: '$1',
    windowId: '@2',
    anchorPaneId: '%12',
    placement: 'right',
    engine: 'chromium',
    openedBy: 'agent',
    status: 'open',
    createdAt: 0,
  }
}

function emptySnapshot(): WebPanePendingSnapshot {
  return { notes: [], knownUpTo: 0, dropped: 0 }
}

function snapshotOf(notes: WebPanePendingNote[], dropped = 0): WebPanePendingSnapshot {
  return { notes, knownUpTo: notes.length, dropped }
}

function pendingNote(comment: string, id: number): WebPanePendingNote {
  return {
    id,
    selector: 'redline:q1',
    tag: 'redline',
    rect: { x: 0, y: 0, width: 0, height: 0 },
    comment,
  }
}

async function startRelay(
  engineOverrides: Partial<ChromiumEngine> = {},
  pendingNotes: (webPaneId: string) => WebPanePendingSnapshot = () => emptySnapshot(),
) {
  const engine = {
    subscribeScreencast: vi.fn(async () => () => undefined),
    dispatchInput: vi.fn(),
    setViewport: vi.fn(async () => undefined),
    reload: vi.fn(async () => undefined),
    inspectAt: vi.fn(async () => ({ ok: true as const, selector: '#a', tag: 'div', rect: { x: 0, y: 0, width: 1, height: 1 } })),
    ...engineOverrides,
  } as unknown as ChromiumEngine
  const service = { get: (id: string) => (id === 'w-11111111' ? pane() : undefined) } as unknown as WebPaneService
  const relay = new WebTileRelay({ engine, service, pendingNotes })
  relays.push(relay)
  const server = createServer()
  server.on('upgrade', (request, socket, head) => {
    const id = webTilePathId(new URL(request.url ?? '/', 'http://127.0.0.1').pathname)
    if (id) relay.handleUpgrade(request, socket, head, id)
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws/web-tiles/w-11111111`)
  sockets.push(socket)
  // Collect from the first tick — connect-time messages (pending hydration)
  // can arrive in the same I/O batch as the open event.
  const messages: Record<string, unknown>[] = []
  socket.on('message', (data) => {
    messages.push(JSON.parse(String(data)) as Record<string, unknown>)
  })
  await new Promise<void>((resolve) => socket.once('open', () => resolve()))
  return { socket, engine, relay, messages }
}

function nextMessage(socket: WebSocket, type: string): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const onMessage = (data: unknown): void => {
      const message = JSON.parse(String(data)) as Record<string, unknown>
      if (message.type !== type) return
      socket.off('message', onMessage)
      resolve(message)
    }
    socket.on('message', onMessage)
  })
}

async function messageOfType(
  socket: WebSocket,
  messages: Record<string, unknown>[],
  type: string,
): Promise<Record<string, unknown>> {
  const seen = messages.find((message) => message.type === type)
  return seen ?? await nextMessage(socket, type)
}

describe('web tile relay inspect routing', () => {
  it('answers a valid inspect with an inspect_result carrying the same id', async () => {
    const { socket, engine } = await startRelay()
    const reply = nextMessage(socket, 'inspect_result')
    socket.send(JSON.stringify({ type: 'inspect', id: 'i-7', x: 10, y: 20, grade: 'hover' }))
    expect(await reply).toMatchObject({ id: 'i-7', ok: true, selector: '#a' })
    expect(engine.inspectAt).toHaveBeenCalledWith('w-11111111', 10, 20, 'hover')
  })

  it('ignores malformed inspect requests', async () => {
    const { socket, engine } = await startRelay()
    socket.send(JSON.stringify({ type: 'inspect', id: 'i-7', x: -5, y: 20, grade: 'hover' }))
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(engine.inspectAt).not.toHaveBeenCalled()
  })

  it('turns an inspectAt rejection into an ok:false reply', async () => {
    const { socket } = await startRelay({
      inspectAt: vi.fn(async () => {
        throw new Error('cdp went away')
      }),
    } as unknown as Partial<ChromiumEngine>)
    const reply = nextMessage(socket, 'inspect_result')
    socket.send(JSON.stringify({ type: 'inspect', id: 'i-8', x: 1, y: 1, grade: 'click' }))
    expect(await reply).toMatchObject({ id: 'i-8', ok: false })
  })
})

describe('web tile relay pending broadcast', () => {
  it('broadcasts the pending queue to subscribed tile sockets', async () => {
    const { socket, relay } = await startRelay()
    const reply = nextMessage(socket, 'pending')
    relay.broadcastPending('w-11111111', snapshotOf([pendingNote('Which plan?: Pro', 1)]))
    expect(await reply).toMatchObject({ notes: [{ id: 1, comment: 'Which plan?: Pro' }] })
  })

  it('broadcastPending is a no-op for unknown panes', async () => {
    const { relay } = await startRelay()
    expect(() => relay.broadcastPending('w-deadbeef', emptySnapshot())).not.toThrow()
  })

  it('hydrates a connecting socket with the current pending queue', async () => {
    const { socket, messages } = await startRelay({}, () => snapshotOf([pendingNote('queued earlier', 3)]))
    const message = await messageOfType(socket, messages, 'pending')
    expect(message).toMatchObject({ notes: [{ id: 3, comment: 'queued earlier' }] })
  })

  it('does not send an empty pending message on connect', async () => {
    const { messages } = await startRelay()
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(messages.map((message) => message.type)).not.toContain('pending')
  })
})
