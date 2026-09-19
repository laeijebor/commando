import type { Host } from '../hosts/types'
import { TileRelayClient, type TileRelayState } from './relay'

/**
 * A stand-in for React Native's WebSocket that lets a test play the daemon:
 * it records what the client sent and pushes frames, pending snapshots and
 * closes back at it.
 */
class FakeSocket {
  static last: FakeSocket | null = null

  readyState = 1
  sent: string[] = []
  onopen: (() => void) | null = null
  onmessage: ((event: { data?: unknown }) => void) | null = null
  onerror: (() => void) | null = null
  onclose: ((event: { code?: number; reason?: string }) => void) | null = null

  constructor(readonly url: string, readonly headers?: Record<string, string>) {
    FakeSocket.last = this
  }

  send(data: string): void {
    this.sent.push(data)
  }

  close(): void {
    this.readyState = 3
  }

  open(): void {
    this.onopen?.()
  }

  deliver(message: unknown): void {
    this.onmessage?.({ data: JSON.stringify(message) })
  }

  shutdown(code: number, reason = ''): void {
    this.readyState = 3
    this.onclose?.({ code, reason })
  }

  parsed(): Array<Record<string, unknown>> {
    return this.sent.map((entry) => JSON.parse(entry) as Record<string, unknown>)
  }
}

const TOKEN_HOST: Host = {
  id: 'h1',
  name: 'studio',
  baseUrl: 'http://studio.tail-1a2b.ts.net:4310',
  auth: { kind: 'token', token: 'secret/token' },
}

const SESSION_HOST: Host = { ...TOKEN_HOST, id: 'h2', auth: { kind: 'session' } }

function connect(options: Partial<ConstructorParameters<typeof TileRelayClient>[0]> = {}): {
  client: TileRelayClient
  socket: FakeSocket
  states: TileRelayState[]
} {
  const states: TileRelayState[] = []
  const client = new TileRelayClient({
    host: TOKEN_HOST,
    webPaneId: 'w-0badcafe',
    createSocket: (url, headers) => new FakeSocket(url, headers) as unknown as WebSocket,
    ...options,
  })
  client.subscribe((state) => states.push(state))
  client.start()
  const socket = FakeSocket.last!
  socket.open()
  return { client, socket, states }
}

afterEach(() => {
  FakeSocket.last = null
})

describe('the tile socket URL', () => {
  it('carries an automation token as a query parameter', () => {
    const client = new TileRelayClient({ host: TOKEN_HOST, webPaneId: 'w-0badcafe' })
    expect(client.url).toBe(
      'ws://studio.tail-1a2b.ts.net:4310/ws/web-tiles/w-0badcafe?token=secret%2Ftoken',
    )
  })

  it('asks for review-only snapshots when that is all the screen wants', () => {
    const client = new TileRelayClient({ host: SESSION_HOST, webPaneId: 'w-0badcafe', mode: 'review' })
    expect(client.url).toBe('ws://studio.tail-1a2b.ts.net:4310/ws/web-tiles/w-0badcafe?mode=review')
  })

  it('upgrades to wss when the daemon uses TLS', () => {
    const client = new TileRelayClient({
      host: { ...SESSION_HOST, baseUrl: 'https://studio.example.com:443' },
      webPaneId: 'w-0badcafe',
    })
    expect(client.url.startsWith('wss://')).toBe(true)
  })

  it('replays the session cookie as a header, the way the daemon client does', () => {
    connect({ host: SESSION_HOST, cookie: 'commando.session=abc' })
    expect(FakeSocket.last?.headers).toEqual({ Cookie: 'commando.session=abc' })
  })

  it('sends no cookie header for a token host', () => {
    const { socket } = connect()
    expect(socket.headers).toBeUndefined()
  })
})

describe('the viewport', () => {
  it('goes out once the socket is open, rounded and clamped', () => {
    const { client, socket } = connect()
    client.setViewport({ width: 390.4, height: 640.6, deviceScaleFactor: 9 })
    expect(socket.parsed()).toContainEqual({
      type: 'viewport',
      width: 390,
      height: 641,
      deviceScaleFactor: 4,
    })
  })

  it('is not re-sent when nothing changed', () => {
    const { client, socket } = connect()
    client.setViewport({ width: 390, height: 640, deviceScaleFactor: 2 })
    client.setViewport({ width: 390, height: 640, deviceScaleFactor: 2 })
    expect(socket.parsed().filter((message) => message.type === 'viewport')).toHaveLength(1)
  })

  it('is re-sent when chromium reports it is ready', () => {
    const { client, socket } = connect()
    client.setViewport({ width: 390, height: 640, deviceScaleFactor: 2 })
    socket.deliver({ type: 'ready' })
    expect(socket.parsed().filter((message) => message.type === 'viewport')).toHaveLength(2)
  })
})

describe('input and reload', () => {
  it('wraps each CDP message in an input envelope', () => {
    const { client, socket } = connect()
    client.sendInput([
      { kind: 'mouse', type: 'mousePressed', x: 1, y: 2, button: 'left', buttons: 1, clickCount: 1, modifiers: 0 },
      { kind: 'mouse', type: 'mouseReleased', x: 1, y: 2, button: 'left', buttons: 0, clickCount: 1, modifiers: 0 },
    ])
    expect(socket.parsed()).toEqual([
      { type: 'input', event: expect.objectContaining({ type: 'mousePressed' }) },
      { type: 'input', event: expect.objectContaining({ type: 'mouseReleased' }) },
    ])
  })

  it('asks the daemon to reload the page', () => {
    const { client, socket } = connect()
    client.reload()
    expect(socket.parsed()).toEqual([{ type: 'reload' }])
  })
})

describe('correlated requests', () => {
  it('routes an inspect result back to its caller', async () => {
    const { client, socket } = connect()
    const result = client.inspect(12, 24, 'click')
    const request = socket.parsed().find((message) => message.type === 'inspect') as {
      id: string
      x: number
      y: number
      grade: string
    }
    expect(request).toMatchObject({ x: 12, y: 24, grade: 'click' })

    socket.deliver({
      type: 'inspect_result',
      id: request.id,
      ok: true,
      selector: '#candidate-inbox',
      tag: 'section',
      rect: { x: 0, y: 0, width: 100, height: 40 },
    })
    await expect(result).resolves.toMatchObject({ ok: true, selector: '#candidate-inbox' })
  })

  it('ignores a reply that correlates with nothing', () => {
    const { socket } = connect()
    expect(() => socket.deliver({ type: 'inspect_result', id: 'nope', ok: true })).not.toThrow()
  })

  it('resolves selectors in one batch and drops bad anchors', async () => {
    const { client, socket } = connect()
    const anchors = client.resolveSelectors([{ noteId: 1, selector: '#a' }, { noteId: 2, selector: '#b' }])
    const request = socket.parsed().find((message) => message.type === 'resolve_selectors') as { id: string }
    socket.deliver({
      type: 'resolve_selectors_result',
      id: request.id,
      ok: true,
      anchors: [
        { noteId: 1, rect: { x: 1, y: 2, width: 3, height: 4 } },
        { noteId: 2, rect: { x: 1, y: 2, width: 0, height: 4 } },
      ],
    })
    await expect(anchors).resolves.toEqual([{ noteId: 1, rect: { x: 1, y: 2, width: 3, height: 4 } }])
  })

  it('never asks the daemon about an empty batch', async () => {
    const { client, socket } = connect()
    await expect(client.resolveSelectors([])).resolves.toEqual([])
    expect(socket.sent).toHaveLength(0)
  })

  it('fails an in-flight request when the stream closes', async () => {
    const { client, socket } = connect()
    const result = client.inspect(1, 1, 'click')
    socket.shutdown(1006, 'socket hang up')
    await expect(result).rejects.toThrow('The tile stream closed.')
    client.stop()
  })
})

describe('stream state', () => {
  it('reaches streaming on the first frame and mirrors the pending queue', () => {
    const { client, socket } = connect()
    socket.deliver({ type: 'frame', data: 'AAAA', metadata: { deviceWidth: 390, deviceHeight: 640 } })
    socket.deliver({
      type: 'pending',
      revision: 2,
      notes: [{ id: 1, selector: '#a', tag: 'div', rect: { x: 0, y: 0, width: 1, height: 1 }, comment: 'fix' }],
      knownUpTo: 1,
      dropped: 0,
    })
    expect(client.getState()).toMatchObject({
      phase: 'streaming',
      frame: 'AAAA',
      pending: { revision: 2, knownUpTo: 1 },
    })
    client.stop()
  })

  it('stops for good when the daemon says the engine is unavailable', () => {
    const { client, socket } = connect()
    socket.deliver({ type: 'engine_error', message: 'Chromium is not installed' })
    socket.shutdown(4503, 'Chromium engine unavailable')
    expect(client.getState()).toMatchObject({
      phase: 'unavailable',
      detail: 'Chromium is not installed',
    })
    client.stop()
  })

  it('stops for good when the tile is closed on the host', () => {
    const { client, socket } = connect()
    socket.shutdown(4410, 'Web tile is no longer streamable')
    expect(client.getState().phase).toBe('gone')
    client.stop()
  })

  it('schedules a reconnect for any other close', () => {
    const { client, socket, states } = connect()
    socket.shutdown(1006, 'socket hang up')
    expect(states[states.length - 1]).toMatchObject({ phase: 'closed' })
    expect(client.getState().detail).toContain('retrying in')
    client.stop()
  })
})
