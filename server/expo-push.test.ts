import { describe, expect, it, vi } from 'vitest'

import { ExpoPushSender, chunkPushMessages, type ExpoPushMessage } from './expo-push.js'

function message(overrides: Partial<ExpoPushMessage> = {}): ExpoPushMessage {
  return {
    to: 'ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]',
    title: 'Claude needs input · island',
    body: 'Which branch should I use?',
    data: { paneId: '%1', kind: 'needs_input' },
    categoryId: 'needs_input',
    ...overrides,
  }
}

function okResponse(count: number): Response {
  return new Response(
    JSON.stringify({ data: Array.from({ length: count }, () => ({ status: 'ok', id: 'ticket' })) }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  )
}

const silent = { warn: () => undefined }

describe('expo push sender', () => {
  it('posts the standard message shape to the Expo push API', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse(1))
    const sender = new ExpoPushSender({ fetch: fetchMock as unknown as typeof fetch, logger: silent })

    const outcome = await sender.send([message({ channelId: 'agents' })])

    expect(outcome).toEqual({ accepted: 1, rejected: 0, unregisteredTokens: [] })
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://exp.host/--/api/v2/push/send')
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json')
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined()
    expect(init.signal).toBeInstanceOf(AbortSignal)
    expect(JSON.parse(init.body as string)).toEqual([{
      to: 'ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]',
      title: 'Claude needs input · island',
      body: 'Which branch should I use?',
      data: { paneId: '%1', kind: 'needs_input' },
      categoryId: 'needs_input',
      sound: 'default',
      priority: 'high',
      channelId: 'agents',
    }])
  })

  it('sends the EXPO_ACCESS_TOKEN as a bearer when configured', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse(1))
    const sender = new ExpoPushSender({
      fetch: fetchMock as unknown as typeof fetch,
      accessToken: 'secret-token',
      logger: silent,
    })

    await sender.send([message()])

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer secret-token')
  })

  it('splits sends into batches of at most 100 messages', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(okResponse(100))
      .mockResolvedValueOnce(okResponse(50))
    const sender = new ExpoPushSender({ fetch: fetchMock as unknown as typeof fetch, logger: silent })
    const messages = Array.from({ length: 150 }, (_, index) => message({
      to: `ExponentPushToken[token${index.toString().padStart(16, '0')}]`,
    }))

    const outcome = await sender.send(messages)

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string)).toHaveLength(100)
    expect(JSON.parse(fetchMock.mock.calls[1][1].body as string)).toHaveLength(50)
    expect(outcome.accepted).toBe(150)
    expect(chunkPushMessages(messages).map((batch) => batch.length)).toEqual([100, 50])
  })

  it('prunes devices Expo reports as DeviceNotRegistered', async () => {
    const stale = 'ExponentPushToken[staleaaaaaaaaaaaaaaaa]'
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: [
        { status: 'ok', id: 'ticket' },
        { status: 'error', message: 'not registered', details: { error: 'DeviceNotRegistered' } },
      ],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    const onDeviceNotRegistered = vi.fn().mockResolvedValue(undefined)
    const sender = new ExpoPushSender({
      fetch: fetchMock as unknown as typeof fetch,
      onDeviceNotRegistered,
      logger: silent,
    })

    const outcome = await sender.send([message(), message({ to: stale })])

    expect(outcome).toEqual({ accepted: 1, rejected: 1, unregisteredTokens: [stale] })
    expect(onDeviceNotRegistered).toHaveBeenCalledExactlyOnceWith(stale)
  })

  it('logs and survives transport failures, HTTP errors and junk responses', async () => {
    const warn = vi.fn()
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce(new Response('nope', { status: 502 }))
      .mockResolvedValueOnce(new Response('{"nonsense":true}', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))
    const sender = new ExpoPushSender({ fetch: fetchMock as unknown as typeof fetch, logger: { warn } })

    await expect(sender.send([message()])).resolves.toMatchObject({ accepted: 0, rejected: 1 })
    await expect(sender.send([message()])).resolves.toMatchObject({ accepted: 0, rejected: 1 })
    await expect(sender.send([message()])).resolves.toMatchObject({ accepted: 0, rejected: 1 })
    expect(warn).toHaveBeenCalledTimes(3)
  })
})
