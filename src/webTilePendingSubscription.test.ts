// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { subscribeWebTilePending } from './webTilePendingSubscription'

class FakeWebSocket {
  static instances: FakeWebSocket[] = []
  readonly url: string
  closeCount = 0
  private readonly listeners = new Map<string, Set<(event: Event) => void>>()

  constructor(url: string) {
    this.url = url
    FakeWebSocket.instances.push(this)
  }

  addEventListener(type: string, listener: EventListener): void {
    let listeners = this.listeners.get(type)
    if (!listeners) {
      listeners = new Set()
      this.listeners.set(type, listeners)
    }
    listeners.add(listener)
  }

  removeEventListener(type: string, listener: EventListener): void {
    this.listeners.get(type)?.delete(listener)
  }

  close(): void {
    this.closeCount += 1
  }

  dispatch(type: string): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(new Event(type))
  }

  message(value: unknown): void {
    const event = new MessageEvent('message', { data: JSON.stringify(value) })
    for (const listener of [...(this.listeners.get('message') ?? [])]) listener(event)
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  FakeWebSocket.instances = []
  vi.stubGlobal('WebSocket', FakeWebSocket)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('subscribeWebTilePending', () => {
  it('delivers snapshots and reconnects with backoff after close and error', () => {
    const listener = vi.fn()
    const stop = subscribeWebTilePending('w-abcd1234', 'owner token', listener)
    expect(FakeWebSocket.instances).toHaveLength(1)
    expect(FakeWebSocket.instances[0].url).toContain('mode=review')
    expect(FakeWebSocket.instances[0].url).toContain('token=owner+token')

    FakeWebSocket.instances[0].message({
      type: 'pending',
      revision: 3,
      notes: [],
      knownUpTo: 7,
      dropped: 1,
    })
    expect(listener).toHaveBeenCalledWith({ revision: 3, notes: [], knownUpTo: 7, dropped: 1 })

    FakeWebSocket.instances[0].dispatch('close')
    vi.advanceTimersByTime(249)
    expect(FakeWebSocket.instances).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(FakeWebSocket.instances).toHaveLength(2)

    FakeWebSocket.instances[1].dispatch('error')
    expect(FakeWebSocket.instances[1].closeCount).toBe(1)
    vi.advanceTimersByTime(499)
    expect(FakeWebSocket.instances).toHaveLength(2)
    vi.advanceTimersByTime(1)
    expect(FakeWebSocket.instances).toHaveLength(3)

    FakeWebSocket.instances[2].dispatch('open')
    FakeWebSocket.instances[2].dispatch('close')
    vi.advanceTimersByTime(250)
    expect(FakeWebSocket.instances).toHaveLength(4)
    stop()
  })

  it('cancels reconnects and removes active listeners when stopped', () => {
    const listener = vi.fn()
    const stop = subscribeWebTilePending('w-abcd1234', '', listener)
    const first = FakeWebSocket.instances[0]
    first.dispatch('close')

    stop()
    vi.advanceTimersByTime(10_000)

    expect(FakeWebSocket.instances).toHaveLength(1)
    first.message({ type: 'pending', notes: [], knownUpTo: 1, dropped: 0 })
    expect(listener).not.toHaveBeenCalled()
  })

  it('caps repeated reconnect delays', () => {
    const stop = subscribeWebTilePending('w-abcd1234', '', () => undefined)
    const delays = [250, 500, 1_000, 2_000, 4_000, 5_000, 5_000]

    for (const [index, delay] of delays.entries()) {
      FakeWebSocket.instances[index].dispatch('error')
      vi.advanceTimersByTime(delay - 1)
      expect(FakeWebSocket.instances).toHaveLength(index + 1)
      vi.advanceTimersByTime(1)
      expect(FakeWebSocket.instances).toHaveLength(index + 2)
    }

    stop()
  })
})
