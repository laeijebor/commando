import { once } from 'node:events'
import { describe, expect, it } from 'vitest'
import { WebSocket, WebSocketServer } from 'ws'
import { WS_FRAGMENT_BYTES, WsBacklog, type WsSendTarget } from './ws-backlog.js'

const MB = 1024 * 1024

/**
 * Models a ws socket over a Node net.Socket: a string counts its UTF-16 code
 * units and a buffer its bytes, and a write only leaves `bufferedAmount` once
 * all of it has been sent.
 */
class FakeSocket implements WsSendTarget {
  writes: { units: number; left: number }[] = []
  frames: { fin: boolean }[] = []
  payloads: Buffer[] = []
  get bufferedAmount(): number {
    return this.writes.reduce((total, write) => total + write.units, 0)
  }
  send(data: string | Buffer, options: { fin?: boolean } = {}): void {
    const units = typeof data === 'string' ? data.length : data.length
    this.writes.push({ units, left: typeof data === 'string' ? Buffer.byteLength(data) : data.length })
    this.frames.push({ fin: options.fin ?? true })
    this.payloads.push(typeof data === 'string' ? Buffer.from(data) : data)
  }
  /** The link carries this many bytes. */
  drain(bytes: number): void {
    while (bytes > 0 && this.writes.length) {
      const head = this.writes[0]!
      const taken = Math.min(head.left, bytes)
      head.left -= taken
      bytes -= taken
      if (head.left === 0) this.writes.shift()
    }
  }
}

function setup() {
  let now = 0
  const backlog = new WsBacklog({ softBytes: 32 * MB, hardBytes: 256 * MB, stallMs: 30_000 }, () => now)
  const socket = new FakeSocket()
  const send = (text: string): string | null => {
    const verdict = backlog.check(socket.bufferedAmount)
    if (!verdict) backlog.write(socket, text)
    return verdict
  }
  return { backlog, socket, send, advance: (ms: number) => { now += ms } }
}

describe('the cockpit socket backlog', () => {
  it('keeps a client that is still downloading a replay larger than the soft limit', () => {
    // A 36 MB replay in one message: the case that closed every phone with 1013.
    const { socket, send, advance } = setup()
    expect(send('x'.repeat(36 * MB))).toBeNull()
    // A 4G link carries about 1.5 MB a second; the agent keeps streaming meanwhile.
    for (let second = 0; second < 40; second += 1) {
      advance(1_000)
      socket.drain(1.5 * MB)
      expect(send('{"type":"chat_items"}')).toBeNull()
    }
  })

  it('sends a large message as fragments that make up one text message', () => {
    const { socket, send } = setup()
    // Two UTF-8 bytes a character, so fragment edges split characters, as WebSocket allows.
    const text = 'é'.repeat(WS_FRAGMENT_BYTES + 1)
    send(text)
    expect(socket.frames.map((frame) => frame.fin)).toEqual([false, false, true])
    expect(Buffer.concat(socket.payloads).toString('utf8')).toBe(text)
  })

  it('drops a client whose backlog stops draining for the stall window', () => {
    const { send, advance } = setup()
    expect(send('x'.repeat(40 * MB))).toBeNull()
    expect(send('tick')).toBeNull()
    advance(29_000)
    expect(send('tick')).toBeNull()
    advance(1_000)
    expect(send('tick')).toBe('Client is not consuming output')
  })

  it('does not take non-ASCII output queued behind a stuck client for progress', () => {
    const { send, advance } = setup()
    expect(send('x'.repeat(40 * MB))).toBeNull()
    const verdicts: (string | null)[] = []
    for (let second = 1; second <= 31; second += 1) {
      advance(1_000)
      // Claude's output is full of ⏺, ⎿ and ─: three UTF-8 bytes, one UTF-16 unit.
      verdicts.push(send('⏺ ⎿ ─ '.repeat(500)))
    }
    expect(verdicts.slice(0, 29).every((verdict) => verdict === null)).toBe(true)
    expect(verdicts.at(-1)).toBe('Client is not consuming output')
  })

  it('restarts the stall window once the backlog falls under the soft limit', () => {
    const { socket, send, advance } = setup()
    send('x'.repeat(40 * MB))
    advance(20_000)
    socket.drain(40 * MB)
    expect(send('x'.repeat(40 * MB))).toBeNull()
    advance(20_000)
    expect(send('tick')).toBeNull()
    advance(9_000)
    expect(send('tick')).toBeNull()
  })

  it('drops any client past the hard limit, draining or not', () => {
    const { send } = setup()
    for (let index = 0; index < 9; index += 1) expect(send('x'.repeat(30 * MB))).toBeNull()
    expect(send('tick')).toBe('Client is not consuming output')
  })

  it('reaches a real ws client as one text message', async () => {
    const server = new WebSocketServer({ port: 0, host: '127.0.0.1' })
    await once(server, 'listening')
    const { port } = server.address() as { port: number }
    const client = new WebSocket(`ws://127.0.0.1:${port}`)
    const [socket] = await once(server, 'connection') as [WebSocket]
    const text = JSON.stringify({ type: 'chat_snapshot', chats: ['─'.repeat(WS_FRAGMENT_BYTES * 2 + 7)] })
    const received = once(client, 'message')
    new WsBacklog().write(socket, text)
    const [data, isBinary] = await received as [Buffer, boolean]
    expect(isBinary).toBe(false)
    expect(data.toString('utf8')).toBe(text)
    client.close()
    server.close()
  })
})
