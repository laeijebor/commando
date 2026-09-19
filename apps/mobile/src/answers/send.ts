import type { AgentInteractionAnswer, ServerMessage } from '@commando/protocol'

import { clientForHost, nextRequestId, type OutgoingMessage } from '../daemon/client'
import { daemonFetch } from '../hosts/api'
import type { Host } from '../hosts/types'

/** What the daemon's answer path can complain about (`server/agent-request-answers.ts`). */
export type AnswerErrorCode =
  | 'request_unavailable'
  | 'invalid_answer'
  | 'invalid_pane'
  | 'timeout'
  | 'unreachable'
  | 'http_error'

export type AnswerChannel = 'socket' | 'http'

export type AnswerResult =
  | { ok: true; via: AnswerChannel; changed: boolean }
  | { ok: false; via: AnswerChannel; code: AnswerErrorCode; message: string }

/** The slice of `DaemonClient` an answer needs, so tests can hand in a double. */
export type AnswerSocket = {
  isOpen: boolean
  send: (message: OutgoingMessage) => string | null
  subscribe: (listener: (message: ServerMessage) => void) => () => void
}

export type SendAnswerOptions = {
  host: Host
  paneId: string
  interactionId: string
  answer: AgentInteractionAnswer
  /** Defaults to the live client for `host.id`; pass `null` to force HTTP. */
  socket?: AnswerSocket | null
  /** Doubles as the HTTP `idempotencyKey`, so a retry cannot answer twice. */
  requestId?: string
  timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 12_000

export function answerErrorText(code: AnswerErrorCode, message?: string): string {
  switch (code) {
    case 'request_unavailable':
      return 'That request is no longer pending — someone or something else answered it.'
    case 'invalid_answer':
      return 'The daemon refused this answer: it does not match the pending request.'
    case 'invalid_pane':
      return 'That pane is gone, so there is nothing left to answer.'
    case 'timeout':
      return 'The daemon did not confirm the answer in time.'
    case 'unreachable':
      return message ?? 'The daemon is unreachable.'
    default:
      return message ?? 'The daemon refused the answer.'
  }
}

function errorCode(code: string): AnswerErrorCode {
  if (code === 'request_unavailable' || code === 'invalid_answer' || code === 'invalid_pane') {
    return code
  }
  return 'http_error'
}

/** The route percent-encodes the pane id, because tmux ids start with `%`. */
export function answerRoutePath(paneId: string, interactionId: string): string {
  return `/api/agent-requests/${encodeURIComponent(paneId)}/${encodeURIComponent(interactionId)}/answer`
}

/**
 * Sends `answer_agent_request` and waits for this request's
 * `agent_request_answered` (or the `error` that carries the same `requestId`).
 */
export function answerOverSocket(
  socket: AnswerSocket,
  options: { paneId: string; interactionId: string; answer: AgentInteractionAnswer; requestId: string; timeoutMs?: number },
): Promise<AnswerResult> {
  return new Promise<AnswerResult>((resolve) => {
    let settled = false
    let unsubscribe: () => void = () => undefined
    let timer: ReturnType<typeof setTimeout> | null = null

    const settle = (result: AnswerResult): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      unsubscribe()
      resolve(result)
    }

    unsubscribe = socket.subscribe((message) => {
      if (message.type === 'agent_request_answered' && message.requestId === options.requestId) {
        settle({ ok: true, via: 'socket', changed: message.changed })
        return
      }
      if (message.type === 'error' && message.requestId === options.requestId) {
        settle({
          ok: false,
          via: 'socket',
          code: errorCode(message.code),
          message: message.message,
        })
      }
    })

    const sent = socket.send({
      type: 'answer_agent_request',
      paneId: options.paneId,
      interactionId: options.interactionId,
      answer: options.answer,
      requestId: options.requestId,
    })
    if (sent === null) {
      settle({ ok: false, via: 'socket', code: 'unreachable', message: 'The socket is not open' })
      return
    }

    timer = setTimeout(() => {
      settle({ ok: false, via: 'socket', code: 'timeout', message: 'No answer confirmation' })
    }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  })
}

/**
 * `POST /api/agent-requests/:paneId/:interactionId/answer` — the same broker
 * behind the socket, used when no socket is up (a notification action in the
 * background, a phone that has not reconnected yet).
 */
export async function answerOverHttp(
  host: Host,
  paneId: string,
  interactionId: string,
  answer: AgentInteractionAnswer,
  idempotencyKey: string,
): Promise<AnswerResult> {
  let response: Response
  try {
    response = await daemonFetch(host, answerRoutePath(paneId, interactionId), {
      method: 'POST',
      body: { answer, idempotencyKey },
    })
  } catch (error) {
    return {
      ok: false,
      via: 'http',
      code: 'unreachable',
      message: error instanceof Error ? error.message : 'The daemon is unreachable',
    }
  }

  let payload: { ok?: boolean; changed?: boolean; error?: string } = {}
  try {
    payload = (await response.json()) as typeof payload
  } catch {
    // A body-less answer is still judged by its status.
  }

  if (response.ok) return { ok: true, via: 'http', changed: payload.changed !== false }

  const code: AnswerErrorCode = response.status === 409
    ? 'request_unavailable'
    : response.status === 404
      ? 'invalid_pane'
      : response.status === 400
        ? 'invalid_answer'
        : 'http_error'
  return {
    ok: false,
    via: 'http',
    code,
    message: payload.error ?? `The daemon answered ${response.status}`,
  }
}

/**
 * Prefers the live socket — it is the channel the spec's decision 7 added for
 * owner clients — and falls back to the HTTP route with the same id as the
 * idempotency key when the socket is closed or refuses the send.
 */
export async function sendAgentAnswer(options: SendAnswerOptions): Promise<AnswerResult> {
  const requestId = options.requestId ?? nextRequestId()
  const socket = options.socket === undefined ? clientForHost(options.host.id) ?? null : options.socket

  if (socket && socket.isOpen) {
    const result = await answerOverSocket(socket, {
      paneId: options.paneId,
      interactionId: options.interactionId,
      answer: options.answer,
      requestId,
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    })
    // Only a socket that could not carry the message at all falls through;
    // a daemon that answered "no" has decided, and retrying over HTTP would
    // just ask the same broker the same question.
    if (result.ok || result.code !== 'unreachable') return result
  }

  return answerOverHttp(
    options.host,
    options.paneId,
    options.interactionId,
    options.answer,
    requestId,
  )
}
