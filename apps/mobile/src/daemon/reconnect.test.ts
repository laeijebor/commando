import { useDaemonStore } from './store'
import { useSessionPreferences } from '../ui/sessionPreferences'

class FakeSocket {
  static all: FakeSocket[] = []
  readyState = 0
  onopen: (() => void) | null = null
  onclose: ((event: { code?: number; reason?: string }) => void) | null = null
  onmessage: ((event: { data?: unknown }) => void) | null = null
  onerror: (() => void) | null = null
  sent: string[] = []
  constructor(readonly url: string) { FakeSocket.all.push(this) }
  send(data: string) { this.sent.push(data) }
  close() { this.readyState = 3 }
  open() { this.readyState = 1; this.onopen?.() }
  drop(code = 1013, reason = 'Client is not consuming output') { this.readyState = 3; this.onclose?.({ code, reason }) }
}

// The client captures the WebSocket constructor when it loads, so the fake goes in first.
const realWebSocket = globalThis.WebSocket
globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { CHAT_HISTORY_BYTES, DaemonClient, STABLE_CONNECTION_MS } = require('./client') as typeof import('./client')
const HOST = { id: 'h1', name: 'studio', baseUrl: 'http://studio:4310', auth: { kind: 'token' as const, token: 'secret' } }

beforeEach(() => {
  FakeSocket.all = []
  jest.spyOn(useSessionPreferences.getState(), 'refresh').mockResolvedValue(undefined as never)
  jest.useFakeTimers()
})
afterEach(() => {
  jest.useRealTimers()
  jest.restoreAllMocks()
})
afterAll(() => {
  globalThis.WebSocket = realWebSocket
})

/** The delay before the next socket appears, in ms. */
function nextOpenAfter(): number {
  const before = FakeSocket.all.length
  let waited = 0
  while (FakeSocket.all.length === before && waited < 60_000) {
    jest.advanceTimersByTime(100)
    waited += 100
  }
  return waited
}

describe('reconnecting to the daemon', () => {
  it('asks for a bounded chat replay', () => {
    const client = new DaemonClient({ host: HOST })
    expect(client.url).toBe(`ws://studio:4310/ws?chatHistory=${CHAT_HISTORY_BYTES}&token=secret`)
  })

  it('backs off when sockets keep dying right after they open, and resets after a stable one', () => {
    const client = new DaemonClient({ host: HOST })
    client.start()
    const delays: number[] = []
    for (let round = 0; round < 4; round += 1) {
      FakeSocket.all.at(-1)!.open()
      jest.advanceTimersByTime(3_000)
      FakeSocket.all.at(-1)!.drop()
      delays.push(nextOpenAfter())
    }
    expect(delays).toEqual([500, 1_000, 2_000, 4_000])

    FakeSocket.all.at(-1)!.open()
    jest.advanceTimersByTime(STABLE_CONNECTION_MS)
    FakeSocket.all.at(-1)!.drop(1006, '')
    expect(nextOpenAfter()).toBe(500)
    client.stop()
  })

  it('ignores the close of a socket it already replaced', () => {
    const client = new DaemonClient({ host: HOST })
    client.start()
    const first = FakeSocket.all[0]!
    first.open()
    client.reconfigure({ ...HOST, auth: { kind: 'token', token: 'rotated' } }, null)
    const second = FakeSocket.all[1]!
    second.open()
    first.drop()
    jest.advanceTimersByTime(30_000)
    expect(FakeSocket.all).toHaveLength(2)
    expect(useDaemonStore.getState().byHost.h1?.phase).toBe('live')
    client.stop()
  })
})
