import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { WebSocket } from 'ws'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WebPane } from '../shared/protocol.js'
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

async function startRelay(engineOverrides: Partial<ChromiumEngine> = {}) {
  const engine = {
    subscribeScreencast: vi.fn(async () => () => undefined),
    dispatchInput: vi.fn(),
    setViewport: vi.fn(async () => undefined),
    reload: vi.fn(async () => undefined),
    inspectAt: vi.fn(async () => ({ ok: true as const, selector: '#a', tag: 'div', rect: { x: 0, y: 0, width: 1, height: 1 } })),
    ...engineOverrides,
  } as unknown as ChromiumEngine
  const service = { get: (id: string) => (id === 'w-11111111' ? pane() : undefined) } as unknown as WebPaneService
  const relay = new WebTileRelay({ engine, service })
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
  await new Promise<void>((resolve) => socket.once('open', () => resolve()))
  return { socket, engine }
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
