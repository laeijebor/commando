import { EventEmitter } from 'node:events'
import { WebSocket, type RawData } from 'ws'
import { afterEach, expect, it, vi } from 'vitest'
import { HostWsForwarder } from './hosts-ws.js'
import { WS_BACKLOG_HARD_BYTES, WS_BACKLOG_SOFT_BYTES, WS_BACKLOG_STALL_MS, WS_FRAGMENT_BYTES } from './ws-backlog.js'

afterEach(() => { vi.useRealTimers() })

class Socket extends EventEmitter {
  readyState = WebSocket.OPEN as number
  bufferedAmount = 0
  readonly callbacks: Array<(error?: Error) => void> = []
  pause = vi.fn()
  resume = vi.fn()
  close = vi.fn()
  terminate = vi.fn()
  send = vi.fn((data: RawData, _options: { binary: boolean; fin?: boolean }, callback: (error?: Error) => void) => {
    this.bufferedAmount += Buffer.isBuffer(data) ? data.length : 1
    this.callbacks.push(callback)
  })
}
function setup() {
  const source = new Socket()
  const destination = new Socket()
  const forwarder = new HostWsForwarder(source as unknown as WebSocket, destination as unknown as WebSocket)
  return { source, destination, forwarder }
}

it('forwards a hub frame larger than 4 MiB without closing either side', () => {
  const { source, destination, forwarder } = setup()
  const data = Buffer.alloc(6 * 1024 * 1024)
  source.emit('message', data, true)
  expect(destination.send).toHaveBeenCalledTimes(data.length / WS_FRAGMENT_BYTES)
  for (const [index, [chunk, options]] of destination.send.mock.calls.entries()) {
    expect(Buffer.isBuffer(chunk)).toBe(true)
    const buffer = chunk as Buffer
    expect(buffer.buffer).toBe(data.buffer)
    expect(buffer.byteOffset).toBe(data.byteOffset + index * WS_FRAGMENT_BYTES)
    expect(buffer.length).toBe(WS_FRAGMENT_BYTES)
    expect(options).toEqual({ binary: true, fin: index === destination.send.mock.calls.length - 1 })
  }
  expect(source.close).not.toHaveBeenCalled(); expect(destination.close).not.toHaveBeenCalled()
  forwarder.stop()
})

it('preserves text message semantics when fragmenting a large replay', () => {
  const { source, destination, forwarder } = setup()
  source.emit('message', Buffer.alloc(WS_FRAGMENT_BYTES + 1), false)
  expect(destination.send.mock.calls.map(([, options]) => options)).toEqual([
    { binary: false, fin: false }, { binary: false, fin: true },
  ])
  expect((destination.send.mock.calls[1][0] as Buffer).length).toBe(1)
  forwarder.stop()
})

it('pauses above the high-water mark and resumes after send callbacks report draining below the low-water mark', () => {
  const { source, destination, forwarder } = setup()
  destination.bufferedAmount = WS_BACKLOG_SOFT_BYTES
  source.emit('message', Buffer.from('one'), false)
  source.emit('message', Buffer.from('two'), false) // already received before pause takes effect
  expect(source.pause).toHaveBeenCalledTimes(1)
  expect(forwarder.isPaused).toBe(true)
  destination.callbacks.shift()!()
  expect(source.resume).not.toHaveBeenCalled()
  destination.bufferedAmount = WS_BACKLOG_SOFT_BYTES / 2
  destination.callbacks.shift()!()
  expect(source.resume).toHaveBeenCalledTimes(1)
  expect(forwarder.isPaused).toBe(false)
  expect(source.close).not.toHaveBeenCalled(); expect(destination.close).not.toHaveBeenCalled()
  forwarder.stop()
})

it('bounds only an absolute backlog far above a legitimate replay frame', () => {
  const { source, destination, forwarder } = setup()
  destination.bufferedAmount = WS_BACKLOG_HARD_BYTES
  source.emit('message', Buffer.from('x'), false)
  expect(destination.send).not.toHaveBeenCalled()
  expect(source.close).toHaveBeenCalledWith(1013, expect.any(String))
  expect(destination.close).toHaveBeenCalledWith(1013, expect.any(String))
  forwarder.stop()
})

it('releases a paused receiver on close so the closing handshake can complete', () => {
  const { source, destination, forwarder } = setup()
  destination.bufferedAmount = WS_BACKLOG_SOFT_BYTES
  source.emit('message', Buffer.from('one'), false)
  destination.emit('close', 1000, Buffer.alloc(0))
  expect(source.resume).toHaveBeenCalledTimes(1)
  expect(forwarder.isPaused).toBe(false)
  destination.callbacks.shift()!()
  source.emit('message', Buffer.from('ignored'), false)
  expect(destination.send).toHaveBeenCalledTimes(1)
})

it('terminates both transports if sending fails', () => {
  const { source, destination, forwarder } = setup()
  source.emit('message', Buffer.from('x'), false)
  destination.callbacks.shift()!(new Error('Disconnected'))
  expect(source.terminate).toHaveBeenCalledOnce(); expect(destination.terminate).toHaveBeenCalledOnce()
  forwarder.stop()
})

it('keeps a paused bridge alive while the destination continues draining', async () => {
  vi.useFakeTimers()
  const { source, destination, forwarder } = setup()
  destination.bufferedAmount = WS_BACKLOG_SOFT_BYTES
  source.emit('message', Buffer.from('one'), false)
  for (let elapsed = 0; elapsed < 2 * WS_BACKLOG_STALL_MS; elapsed += 1_000) {
    destination.bufferedAmount -= 1_024
    await vi.advanceTimersByTimeAsync(1_000)
  }
  expect(forwarder.isPaused).toBe(true)
  expect(source.terminate).not.toHaveBeenCalled()
  expect(destination.terminate).not.toHaveBeenCalled()
  forwarder.stop()
  expect(vi.getTimerCount()).toBe(0)
})

it('terminates both sockets when a paused destination stops draining for the daemon stall interval', async () => {
  vi.useFakeTimers()
  const { source, destination } = setup()
  destination.bufferedAmount = WS_BACKLOG_SOFT_BYTES
  source.emit('message', Buffer.from('one'), false)
  await vi.advanceTimersByTimeAsync(WS_BACKLOG_STALL_MS - 1_000)
  expect(source.terminate).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1_000)
  expect(source.terminate).toHaveBeenCalledOnce()
  expect(destination.terminate).toHaveBeenCalledOnce()
  expect(vi.getTimerCount()).toBe(0)
})

it('restarts the stall interval after progress, including below the soft limit while still paused', async () => {
  vi.useFakeTimers()
  const { source, destination } = setup()
  destination.bufferedAmount = WS_BACKLOG_SOFT_BYTES
  source.emit('message', Buffer.from('one'), false)
  await vi.advanceTimersByTimeAsync(WS_BACKLOG_STALL_MS - 1_000)
  destination.bufferedAmount = WS_BACKLOG_SOFT_BYTES - 1_024
  await vi.advanceTimersByTimeAsync(WS_BACKLOG_STALL_MS)
  expect(source.terminate).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1_000)
  expect(source.terminate).toHaveBeenCalledOnce()
  expect(destination.terminate).toHaveBeenCalledOnce()
})

it('cancels the stall watch when a paused sender resumes', async () => {
  vi.useFakeTimers()
  const { source, destination, forwarder } = setup()
  destination.bufferedAmount = WS_BACKLOG_SOFT_BYTES
  source.emit('message', Buffer.from('one'), false)
  destination.bufferedAmount = WS_BACKLOG_SOFT_BYTES / 2
  destination.callbacks.shift()!()
  await vi.advanceTimersByTimeAsync(2 * WS_BACKLOG_STALL_MS)
  expect(forwarder.isPaused).toBe(false)
  expect(source.terminate).not.toHaveBeenCalled()
  expect(destination.terminate).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
  forwarder.stop()
})
