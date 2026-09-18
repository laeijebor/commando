import type { ServerMessage } from '@commando/protocol'

import type { Host } from '../hosts/types'
import { answerRoutePath, sendAgentAnswer, type AnswerSocket } from './send'

const HOST: Host = {
  id: 'host-1',
  name: 'studio',
  baseUrl: 'http://studio.tail-1a2b.ts.net:4310',
  auth: { kind: 'token', token: 'secret' },
}

type SentMessage = { type: string; requestId?: string; [key: string]: unknown }

function fakeSocket(options: {
  isOpen?: boolean
  reply?: (message: SentMessage) => ServerMessage | null
}): AnswerSocket & { sent: SentMessage[] } {
  const listeners = new Set<(message: ServerMessage) => void>()
  const sent: SentMessage[] = []
  return {
    sent,
    isOpen: options.isOpen ?? true,
    send: (message) => {
      const stamped = { ...message, requestId: message.requestId ?? 'generated' } as SentMessage
      sent.push(stamped)
      if (options.isOpen === false) return null
      const reply = options.reply?.(stamped)
      if (reply) setTimeout(() => listeners.forEach((listener) => listener(reply)), 0)
      return stamped.requestId ?? null
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('sending an agent answer', () => {
  beforeEach(() => {
    ;(globalThis.fetch as jest.Mock).mockClear()
  })

  it('prefers the socket and resolves on the matching agent_request_answered', async () => {
    const socket = fakeSocket({
      reply: (message) => ({
        type: 'agent_request_answered',
        paneId: '%14',
        interactionId: 'req-1',
        changed: true,
        requestId: String(message.requestId),
      }),
    })

    const result = await sendAgentAnswer({
      host: HOST,
      paneId: '%14',
      interactionId: 'req-1',
      answer: { action: 'answer', answers: [['Pairing QR']] },
      socket,
      requestId: 'm-1',
    })

    expect(result).toEqual({ ok: true, via: 'socket', changed: true })
    expect(socket.sent[0]).toMatchObject({
      type: 'answer_agent_request',
      paneId: '%14',
      interactionId: 'req-1',
      requestId: 'm-1',
      answer: { action: 'answer', answers: [['Pairing QR']] },
    })
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('reports the daemon error code carried by this request id', async () => {
    const socket = fakeSocket({
      reply: (message) => ({
        type: 'error',
        code: 'request_unavailable',
        message: 'The agent request is no longer pending',
        requestId: String(message.requestId),
      }),
    })

    const result = await sendAgentAnswer({
      host: HOST,
      paneId: '%14',
      interactionId: 'req-1',
      answer: { action: 'deny' },
      socket,
      requestId: 'm-2',
    })

    expect(result).toEqual({
      ok: false,
      via: 'socket',
      code: 'request_unavailable',
      message: 'The agent request is no longer pending',
    })
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('ignores a confirmation meant for another request', async () => {
    const socket = fakeSocket({
      reply: () => ({
        type: 'agent_request_answered',
        paneId: '%14',
        interactionId: 'req-9',
        changed: true,
        requestId: 'someone-else',
      }),
    })

    const result = await sendAgentAnswer({
      host: HOST,
      paneId: '%14',
      interactionId: 'req-1',
      answer: { action: 'allow_once' },
      socket,
      requestId: 'm-3',
      timeoutMs: 20,
    })

    expect(result).toMatchObject({ ok: false, via: 'socket', code: 'timeout' })
  })

  it('falls back to the HTTP route with the same id as the idempotency key', async () => {
    ;(globalThis.fetch as jest.Mock).mockResolvedValueOnce(jsonResponse(200, { ok: true, changed: true }))

    const result = await sendAgentAnswer({
      host: HOST,
      paneId: '%14',
      interactionId: 'req-1',
      answer: { action: 'allow_once' },
      socket: null,
      requestId: 'm-4',
    })

    expect(result).toEqual({ ok: true, via: 'http', changed: true })
    const [url, init] = (globalThis.fetch as jest.Mock).mock.calls[0] as [string, RequestInit]
    expect(url).toBe(`${HOST.baseUrl}/api/agent-requests/%2514/req-1/answer`)
    expect(init.method).toBe('POST')
    expect(JSON.parse(String(init.body))).toEqual({
      answer: { action: 'allow_once' },
      idempotencyKey: 'm-4',
    })
  })

  it('falls back to HTTP when the socket refuses the send', async () => {
    ;(globalThis.fetch as jest.Mock).mockResolvedValueOnce(jsonResponse(200, { ok: true, changed: true }))
    const socket = fakeSocket({ isOpen: false })

    const result = await sendAgentAnswer({
      host: HOST,
      paneId: '%14',
      interactionId: 'req-1',
      answer: { action: 'reject' },
      socket: { ...socket, isOpen: true, send: () => null },
      requestId: 'm-5',
    })

    expect(result).toEqual({ ok: true, via: 'http', changed: true })
    expect(globalThis.fetch).toHaveBeenCalledTimes(1)
  })

  it('maps the HTTP statuses onto the daemon error codes', async () => {
    ;(globalThis.fetch as jest.Mock)
      .mockResolvedValueOnce(jsonResponse(409, { error: 'The agent request is no longer pending' }))
      .mockResolvedValueOnce(jsonResponse(400, { error: 'Invalid agent request answer' }))

    const gone = await sendAgentAnswer({
      host: HOST,
      paneId: '%14',
      interactionId: 'req-1',
      answer: { action: 'deny' },
      socket: null,
      requestId: 'm-6',
    })
    const invalid = await sendAgentAnswer({
      host: HOST,
      paneId: '%14',
      interactionId: 'req-1',
      answer: { action: 'answer', answers: [[]] },
      socket: null,
      requestId: 'm-7',
    })

    expect(gone).toMatchObject({ ok: false, via: 'http', code: 'request_unavailable' })
    expect(invalid).toMatchObject({ ok: false, via: 'http', code: 'invalid_answer' })
  })

  it('percent-encodes the tmux pane id in the route', () => {
    expect(answerRoutePath('%14', 'req-1')).toBe('/api/agent-requests/%2514/req-1/answer')
  })
})
