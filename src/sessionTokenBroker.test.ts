// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest'
import {
  MAX_SESSION_TOKEN_BYTES,
  SESSION_TOKEN_CHANNEL_NAME,
  SessionTokenBroker,
  type SessionTokenChannel,
  type SessionTokenChannelFactory,
} from './sessionTokenBroker'

type Listener = (event: { data: unknown }) => void

class TestChannel implements SessionTokenChannel {
  readonly listeners = new Set<Listener>()
  closed = false

  constructor(private readonly hub: TestChannelHub, readonly name: string) {}

  postMessage(message: unknown): void {
    if (this.closed) throw new Error('channel closed')
    this.hub.deliver(this, message)
  }

  addEventListener(_type: 'message', listener: Listener): void {
    this.listeners.add(listener)
  }

  removeEventListener(_type: 'message', listener: Listener): void {
    this.listeners.delete(listener)
  }

  close(): void {
    this.closed = true
    this.listeners.clear()
  }
}

class TestChannelHub {
  readonly channels: TestChannel[] = []
  readonly messages: unknown[] = []
  readonly factory: SessionTokenChannelFactory = (name) => {
    const channel = new TestChannel(this, name)
    this.channels.push(channel)
    return channel
  }

  deliver(sender: TestChannel, message: unknown): void {
    this.messages.push(message)
    for (const channel of this.channels) {
      if (channel === sender || channel.closed) continue
      for (const listener of channel.listeners) listener({ data: message })
    }
  }

  inject(message: unknown): void {
    for (const channel of this.channels) {
      for (const listener of channel.listeners) listener({ data: message })
    }
  }
}

function identifiers(prefix: string): () => string {
  let sequence = 0
  return () => `${prefix}-${String(++sequence).padStart(8, '0')}`
}

describe('session token broker', () => {
  it('shares a token only in response to a targeted peer request', async () => {
    const hub = new TestChannelHub()
    const holder = new SessionTokenBroker(hub.factory, identifiers('holder-peer'))
    const newcomer = new SessionTokenBroker(hub.factory, identifiers('new-peer-id'))
    expect(hub.channels.every((channel) => channel.name === SESSION_TOKEN_CHANNEL_NAME)).toBe(true)
    expect(holder.setToken('manual-token')).toBe(true)
    expect(hub.messages).toEqual([])

    await expect(newcomer.requestToken()).resolves.toBe('manual-token')

    expect(hub.messages).toHaveLength(2)
    expect(hub.messages).toEqual([
      expect.objectContaining({ type: 'request', senderId: 'new-peer-id-00000001' }),
      expect.objectContaining({
        type: 'response',
        senderId: 'holder-peer-00000001',
        targetId: 'new-peer-id-00000001',
        token: 'manual-token',
      }),
    ])
    holder.close()
    newcomer.close()
  })

  it('responds only while holding a token and propagates clear without echoing', async () => {
    const hub = new TestChannelHub()
    const holder = new SessionTokenBroker(hub.factory, identifiers('holder-peer'))
    const peer = new SessionTokenBroker(hub.factory, identifiers('second-peer'))
    const cleared = vi.fn()
    peer.onClear(cleared)
    holder.setToken('manual-token')
    await expect(peer.requestToken()).resolves.toBe('manual-token')
    peer.setToken('manual-token')
    hub.messages.length = 0

    holder.clear()

    expect(cleared).toHaveBeenCalledOnce()
    expect(holder.hasToken).toBe(false)
    expect(peer.hasToken).toBe(false)
    expect(hub.messages).toEqual([
      expect.objectContaining({ type: 'clear', senderId: 'holder-peer-00000001' }),
    ])
    await expect(peer.requestToken(5)).resolves.toBe('')
    holder.close()
    peer.close()
  })

  it('rejects malformed and oversized responses', async () => {
    vi.useFakeTimers()
    const hub = new TestChannelHub()
    const peer = new SessionTokenBroker(hub.factory, identifiers('request-peer'))
    const request = peer.requestToken(20)
    const requestMessage = hub.messages[0] as { requestId: string; senderId: string }

    hub.inject({
      version: 1,
      type: 'response',
      senderId: 'malicious-peer-00000001',
      targetId: requestMessage.senderId,
      requestId: requestMessage.requestId,
      token: 'x'.repeat(MAX_SESSION_TOKEN_BYTES + 1),
    })
    hub.inject({
      version: 1,
      type: 'response',
      senderId: 'malicious-peer-00000001',
      targetId: requestMessage.senderId,
      requestId: requestMessage.requestId,
      token: 'valid-looking-token',
      extra: true,
    })
    await vi.advanceTimersByTimeAsync(20)

    await expect(request).resolves.toBe('')
    expect(peer.hasToken).toBe(false)
    peer.close()
    vi.useRealTimers()
  })

  it('removes listeners, closes the channel, and resolves pending requests on cleanup', async () => {
    const hub = new TestChannelHub()
    const peer = new SessionTokenBroker(hub.factory, identifiers('cleanup-peer'))
    const cleared = vi.fn()
    peer.onClear(cleared)
    const pending = peer.requestToken(5_000)
    const channel = hub.channels[0]!

    peer.close()

    await expect(pending).resolves.toBe('')
    expect(channel.closed).toBe(true)
    expect(channel.listeners.size).toBe(0)
    hub.inject({ version: 1, type: 'clear', senderId: 'other-peer-00000001' })
    expect(cleared).not.toHaveBeenCalled()
  })
})
