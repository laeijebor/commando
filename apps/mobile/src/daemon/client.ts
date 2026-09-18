import type { ClientMessage, ServerMessage, SpecialKey } from '@commando/protocol'

import type { Host } from '../hosts/types'
import { webSocketBase } from '../hosts/types'
import { inputFits, MAX_INPUT_BYTES, MAX_PASTE_BYTES, pasteFits } from './limits'
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

/** A pane stream message the pane screen renders: `pane_reset` or `pane_data`. */
export type PaneStreamMessage = Extract<ServerMessage, { type: 'pane_reset' | 'pane_data' }>

export type PaneStreamHandler = (message: PaneStreamMessage) => void
export type ServerMessageListener = (message: ServerMessage) => void

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
  /**
   * `subscribe` replaces the daemon's whole set for this socket, so the client
   * — not the screen — owns the union of what every mounted screen wants.
   */
  private readonly paneHandlers = new Map<string, Set<PaneStreamHandler>>()
  /** Panes this socket currently holds a resize lease on. */
  private readonly resizeLeases = new Set<string>()
  private readonly listeners = new Set<ServerMessageListener>()

  constructor(options: DaemonClientOptions) {
    this.host = options.host
    this.hostId = options.host.id
    this.cookie = options.cookie ?? null
  }

  /** True while the socket can carry a message right now. */
  get isOpen(): boolean {
    return this.socket?.readyState === 1
  }

  /**
   * Every parsed message, after the store has folded it in. Screens that need
   * a reply to one request they sent (an answered agent request, an `error`
   * carrying their `requestId`) listen here rather than polling the store.
   */
  subscribe(listener: ServerMessageListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
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
    this.resizeLeases.clear()
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

  /**
   * Composer sends: a bracketed paste followed by Enter, which is what keeps a
   * multi-line prompt intact for Claude Code. Oversized payloads are refused
   * here rather than bounced by the daemon.
   */
  paste(paneId: string, data: string): string | null {
    if (!pasteFits(data)) {
      throw new RangeError(`A paste must stay under ${MAX_PASTE_BYTES} bytes`)
    }
    return this.send({ type: 'paste', paneId, data })
  }

  input(paneId: string, data: string): string | null {
    if (!inputFits(data)) {
      throw new RangeError(`Keystroke input must stay under ${MAX_INPUT_BYTES} bytes`)
    }
    return this.send({ type: 'input', paneId, data })
  }

  key(paneId: string, key: SpecialKey): string | null {
    return this.send({ type: 'key', paneId, key })
  }

  /**
   * Streams one pane into `handler` for as long as the returned disposer is
   * uncalled. Subscribing re-sends the union of every subscribed pane, which
   * is also how unsubscribing works: the daemon is told the remaining set.
   */
  subscribePane(paneId: string, handler: PaneStreamHandler): () => void {
    const handlers = this.paneHandlers.get(paneId)
    if (handlers) handlers.add(handler)
    else this.paneHandlers.set(paneId, new Set([handler]))
    this.syncSubscriptions()

    let disposed = false
    return () => {
      if (disposed) return
      disposed = true
      const current = this.paneHandlers.get(paneId)
      if (!current) return
      current.delete(handler)
      if (current.size === 0) {
        this.paneHandlers.delete(paneId)
        this.releaseResize(paneId)
      }
      this.syncSubscriptions()
    }
  }

  get subscribedPaneIds(): string[] {
    return [...this.paneHandlers.keys()]
  }

  /** Asks the daemon to seed the pane again — used after a queue overflow. */
  requestPaneReset(paneId: string): string | null {
    return this.send({ type: 'request_pane_reset', paneId })
  }

  /**
   * Takes the resize lease for "Fit to phone". The daemon resizes the real
   * tmux pane, so this is opt-in and always paired with `releaseResize`.
   */
  resizePane(paneId: string, cols: number, rows: number): string | null {
    const requestId = this.send({ type: 'resize_pane', paneId, cols, rows })
    if (requestId !== null) this.resizeLeases.add(paneId)
    return requestId
  }

  releaseResize(paneId: string): string | null {
    if (!this.resizeLeases.delete(paneId)) return null
    return this.send({ type: 'release_resize', paneId })
  }

  holdsResizeLease(paneId: string): boolean {
    return this.resizeLeases.has(paneId)
  }

  private syncSubscriptions(): void {
    // Subscribing to a pane that has since died is a protocol violation, and
    // eight of those close the socket — so a pane the snapshot no longer knows
    // about is left out rather than asked for again on every reconnect.
    const snapshot = useDaemonStore.getState().byHost[this.hostId]?.snapshot
    const paneIds = snapshot
      ? this.subscribedPaneIds.filter((paneId) => (
          snapshot.panes.some((pane) => pane.id === paneId)
        ))
      : this.subscribedPaneIds
    this.send({ type: 'subscribe', paneIds })
  }

  private dispatchPaneMessage(message: PaneStreamMessage): void {
    const handlers = this.paneHandlers.get(message.paneId)
    if (!handlers) return
    for (const handler of handlers) handler(message)
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
      // A new socket subscribes to nothing, so the panes on screen have to be
      // re-subscribed; the daemon answers each one with a fresh `pane_reset`.
      if (this.paneHandlers.size > 0) this.syncSubscriptions()
    }

    socket.onmessage = (event: { data?: unknown }) => {
      const message = parseServerMessage(event.data)
      if (!message) return
      if (message.type === 'pane_reset' || message.type === 'pane_data') {
        // Pane bytes are hot and the store has no use for them; they go
        // straight to whichever screen asked for that pane.
        this.dispatchPaneMessage(message)
        return
      }
      useDaemonStore.getState().ingest(this.hostId, message)
      for (const listener of [...this.listeners]) listener(message)
    }

    socket.onerror = () => {
      // `onclose` always follows; the close handler owns the retry decision.
    }

    socket.onclose = (event: { code?: number; reason?: string }) => {
      if (this.socket === socket) this.socket = null
      // The daemon drops every lease held by a socket that goes away, so the
      // bookkeeping is cleared rather than sent: there is nothing to send it
      // down. A screen with "Fit to phone" still on re-takes it on reconnect.
      this.resizeLeases.clear()
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
