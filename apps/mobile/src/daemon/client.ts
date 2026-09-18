import type { ClientMessage } from '@commando/protocol'

import type { Host } from '../hosts/types'
import { webSocketBase } from '../hosts/types'
import { parseServerMessage } from './state'
import { useDaemonStore } from './store'

/**
 * React Native's `WebSocket` accepts a third `options` argument with custom
 * headers; the DOM lib types shipped with Expo do not describe it, so the
 * constructor is re-typed here rather than sprinkling `any` at the call site.
 */
type NativeWebSocketConstructor = new (
  url: string,
  protocols?: string | string[] | null,
  options?: { headers?: Record<string, string> },
) => WebSocket

const NativeWebSocket = WebSocket as unknown as NativeWebSocketConstructor

const BASE_RETRY_MS = 500
const MAX_RETRY_MS = 15_000
const MAX_BACKOFF_STEPS = 5

export function retryDelay(attempt: number): number {
  const step = Math.min(Math.max(attempt - 1, 0), MAX_BACKOFF_STEPS)
  return Math.min(BASE_RETRY_MS * 2 ** step, MAX_RETRY_MS)
}

/** `Omit` collapses a union, so distribute it to keep every message variant. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

export type OutgoingMessage = DistributiveOmit<ClientMessage, 'requestId'> & {
  requestId?: string
}

let requestCounter = 0

export function nextRequestId(): string {
  requestCounter += 1
  return `m-${Date.now().toString(36)}-${requestCounter.toString(36)}`
}

export type DaemonClientOptions = {
  host: Host
  /** Session cookie captured at sign-in, replayed when the jar is not shared. */
  cookie?: string | null
}

/**
 * One socket per host. The client owns reconnection and hands every parsed
 * message to the shared zustand store; screens read the store, never the
 * socket.
 */
export class DaemonClient {
  readonly hostId: string

  private host: Host
  private cookie: string | null
  private socket: WebSocket | null = null
  private attempt = 0
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private stopped = false

  constructor(options: DaemonClientOptions) {
    this.host = options.host
    this.hostId = options.host.id
    this.cookie = options.cookie ?? null
  }

  get url(): string {
    const base = `${webSocketBase(this.host.baseUrl)}/ws`
    if (this.host.auth.kind === 'token') {
      return `${base}?token=${encodeURIComponent(this.host.auth.token)}`
    }
    return base
  }

  start(): void {
    this.stopped = false
    this.open(false)
  }

  stop(): void {
    this.stopped = true
    if (this.retryTimer) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
    const socket = this.socket
    this.socket = null
    socket?.close()
    this.setPhase('idle', 'Disconnected')
  }

  /** Stamps a `requestId` so callers only describe the message they want. */
  send(message: OutgoingMessage): string | null {
    const requestId = message.requestId ?? nextRequestId()
    const socket = this.socket
    if (!socket || socket.readyState !== 1) return null
    socket.send(JSON.stringify({ ...message, requestId }))
    return requestId
  }

  private setPhase(
    phase: Parameters<ReturnType<typeof useDaemonStore.getState>['setPhase']>[1],
    detail: string,
  ): void {
    useDaemonStore.getState().setPhase(this.hostId, phase, detail, this.attempt)
  }

  private open(isReconnect: boolean): void {
    if (this.stopped) return

    this.setPhase(
      isReconnect ? 'reconnecting' : 'connecting',
      isReconnect ? `Reconnecting (attempt ${this.attempt})` : `Connecting to ${this.host.name}`,
    )

    const headers: Record<string, string> = {}
    if (this.host.auth.kind === 'session' && this.cookie) headers.Cookie = this.cookie

    let socket: WebSocket
    try {
      socket = new NativeWebSocket(this.url, null, Object.keys(headers).length ? { headers } : undefined)
    } catch (error) {
      this.scheduleReconnect(error instanceof Error ? error.message : 'Could not open the socket')
      return
    }
    this.socket = socket

    socket.onopen = () => {
      if (this.stopped || this.socket !== socket) return
      this.attempt = 0
      this.setPhase('live', `Live · ${this.host.name}`)
      // The daemon only runs the usage refresh loop and holds agent hooks open
      // while a consumer asks for them, so opt in on every (re)connect.
      this.send({ type: 'watch_usage', enabled: true })
      this.send({ type: 'watch_interactions', enabled: true })
    }

    socket.onmessage = (event: { data?: unknown }) => {
      const message = parseServerMessage(event.data)
      if (!message) return
      useDaemonStore.getState().ingest(this.hostId, message)
    }

    socket.onerror = () => {
      // `onclose` always follows; the close handler owns the retry decision.
    }

    socket.onclose = (event: { code?: number; reason?: string }) => {
      if (this.socket === socket) this.socket = null
      if (this.stopped) return
      if (event.code === 4401 || event.code === 4403) {
        this.setPhase('unauthorized', 'The daemon rejected these credentials')
        return
      }
      this.scheduleReconnect(event.reason || 'The daemon closed the connection')
    }
  }

  private scheduleReconnect(detail: string): void {
    if (this.stopped) return
    this.attempt += 1
    const delay = retryDelay(this.attempt)
    this.setPhase('reconnecting', `${detail} · retrying in ${Math.round(delay / 1000)}s`)
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      this.open(true)
    }, delay)
  }
}

const clients = new Map<string, DaemonClient>()

/** One live client per host id, shared by every screen that mounts. */
export function connectHost(host: Host, cookie?: string | null): DaemonClient {
  const existing = clients.get(host.id)
  if (existing) return existing
  const client = new DaemonClient({ host, cookie })
  clients.set(host.id, client)
  client.start()
  return client
}

export function disconnectHost(hostId: string): void {
  const client = clients.get(hostId)
  if (!client) return
  client.stop()
  clients.delete(hostId)
}

export function clientForHost(hostId: string): DaemonClient | undefined {
  return clients.get(hostId)
}
