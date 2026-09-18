import type { WebPanePendingNote, WebPanePendingSnapshot } from '@commando/protocol'

import type { Host } from '../hosts/types'
import { webSocketBase } from '../hosts/types'
import type { TileInputMessage } from './input'
import {
  parseTileInspectResult,
  parseTileSelectorAnchors,
  parseTileServerMessage,
  type TileClientMessage,
  type TileInspectGrade,
  type TileInspectResult,
  type TileSelectorAnchor,
  type TileSelectorResolveItem,
  type TileServerMessage,
} from './protocol'

/**
 * What the tile screen shows. `gone` and `unavailable` are terminal — the
 * daemon has told us this tile will not stream, so retrying on a timer would
 * only hammer it.
 */
export type TileStreamPhase =
  | 'idle'
  | 'connecting'
  | 'ready'
  | 'streaming'
  | 'closed'
  | 'gone'
  | 'unavailable'
  | 'error'

export type TileRelayState = {
  phase: TileStreamPhase
  detail: string
  /** Newest frame as base64 PNG, exactly as the daemon sent it. */
  frame: string | null
  /** Bumped per frame so a component can double-buffer without comparing blobs. */
  frameSeq: number
  /** Device-pixel size the frame was captured at, when the metadata carried it. */
  frameSize: { width: number; height: number } | null
  /** The daemon's pending queue. Replaced whole, never merged. */
  pending: WebPanePendingSnapshot
}

export const EMPTY_PENDING: WebPanePendingSnapshot = { notes: [], knownUpTo: 0, dropped: 0 }

export const INITIAL_TILE_STATE: TileRelayState = {
  phase: 'idle',
  detail: 'Not connected',
  frame: null,
  frameSeq: 0,
  frameSize: null,
  pending: EMPTY_PENDING,
}

/**
 * Folds one relay message into the tile's state. Pure, so the whole stream
 * contract can be exercised without a socket.
 */
export function reduceTileMessage(state: TileRelayState, message: TileServerMessage): TileRelayState {
  switch (message.type) {
    case 'frame': {
      if (typeof message.data !== 'string' || message.data.length === 0) return state
      const metadata = message.metadata
      const width = typeof metadata?.deviceWidth === 'number' ? metadata.deviceWidth : null
      const height = typeof metadata?.deviceHeight === 'number' ? metadata.deviceHeight : null
      return {
        ...state,
        // The first frame is proof the stream is live even if `ready` was missed.
        phase: 'streaming',
        detail: '',
        frame: message.data,
        frameSeq: state.frameSeq + 1,
        frameSize: width !== null && height !== null ? { width, height } : state.frameSize,
      }
    }

    case 'ready':
      // Chromium has attached but has not painted yet; a frame promotes this.
      return state.phase === 'streaming' ? state : { ...state, phase: 'ready', detail: '' }

    case 'engine_error':
      return {
        ...state,
        phase: 'error',
        detail: typeof message.message === 'string' && message.message
          ? message.message
          : 'Chromium engine failed',
      }

    case 'pending': {
      // The daemon's store is the source of truth: replace, never merge, so a
      // missed push heals on the next one or on reconnect.
      if (!Array.isArray(message.notes)) return state
      return {
        ...state,
        pending: {
          ...(typeof message.revision === 'number' ? { revision: message.revision } : {}),
          notes: message.notes as WebPanePendingNote[],
          knownUpTo: typeof message.knownUpTo === 'number' ? message.knownUpTo : 0,
          dropped: typeof message.dropped === 'number' ? message.dropped : 0,
        },
      }
    }

    default:
      // inspect_result / resolve_selectors_result / selection_result are
      // correlated replies the client routes to their caller, not state.
      return state
  }
}

/** Close codes the relay uses, turned into something the screen can say. */
export function tileCloseState(state: TileRelayState, code?: number, reason?: string): TileRelayState {
  if (code === 4404) {
    return { ...state, phase: 'gone', detail: 'This tile is not streaming — it may have been closed or is still awaiting confirmation.' }
  }
  if (code === 4410) {
    return { ...state, phase: 'gone', detail: 'The tile was closed on the host.' }
  }
  if (code === 4503) {
    // An `engine_error` normally arrives first and carries the real reason.
    return {
      ...state,
      phase: 'unavailable',
      detail: state.phase === 'error' && state.detail ? state.detail : 'Chromium engine unavailable',
    }
  }
  return { ...state, phase: 'closed', detail: reason || 'The stream closed.' }
}

/**
 * React Native's `WebSocket` takes a third `options` argument with headers;
 * the DOM lib types Expo ships do not describe it.
 */
type NativeWebSocketConstructor = new (
  url: string,
  protocols?: string | string[] | null,
  options?: { headers?: Record<string, string> },
) => WebSocket

const NativeWebSocket = WebSocket as unknown as NativeWebSocketConstructor

const REQUEST_TIMEOUT_MS = 6_000
const BASE_RETRY_MS = 700
const MAX_RETRY_MS = 10_000

export function tileRetryDelay(attempt: number): number {
  return Math.min(BASE_RETRY_MS * 2 ** Math.min(Math.max(attempt - 1, 0), 4), MAX_RETRY_MS)
}

export type TileRelayOptions = {
  host: Host
  webPaneId: string
  /** Session cookie captured at sign-in, for sockets that skip the cookie jar. */
  cookie?: string | null
  /** `review` opts out of the screencast and only receives pending snapshots. */
  mode?: 'review'
  /** Socket factory, so tests can drive the client without a network. */
  createSocket?: (url: string, headers?: Record<string, string>) => WebSocket
}

type PendingRequest = {
  resolve: (value: never) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
  route: (message: Record<string, unknown>) => void
}

let requestCounter = 0

function nextRequestId(): string {
  requestCounter += 1
  return `t${Date.now().toString(36)}${requestCounter.toString(36)}`
}

/**
 * One socket to one chromium tile. The client owns the connection, the
 * reconnect and the request correlation; the screen subscribes to state and
 * never touches the socket.
 */
export class TileRelayClient {
  private readonly options: TileRelayOptions
  private socket: WebSocket | null = null
  private state: TileRelayState = INITIAL_TILE_STATE
  private listeners = new Set<(state: TileRelayState) => void>()
  private requests = new Map<string, PendingRequest>()
  private viewport: { width: number; height: number; deviceScaleFactor: number } | null = null
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private attempt = 0
  private stopped = false

  constructor(options: TileRelayOptions) {
    this.options = options
  }

  get url(): string {
    const base = `${webSocketBase(this.options.host.baseUrl)}/ws/web-tiles/${encodeURIComponent(this.options.webPaneId)}`
    const query: string[] = []
    if (this.options.host.auth.kind === 'token') {
      query.push(`token=${encodeURIComponent(this.options.host.auth.token)}`)
    }
    if (this.options.mode === 'review') query.push('mode=review')
    return query.length ? `${base}?${query.join('&')}` : base
  }

  getState(): TileRelayState {
    return this.state
  }

  subscribe(listener: (state: TileRelayState) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  start(): void {
    this.stopped = false
    this.open()
  }

  stop(): void {
    this.stopped = true
    if (this.retryTimer) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
    this.failRequests('The tile stream closed.')
    const socket = this.socket
    this.socket = null
    socket?.close()
  }

  /** Reconnects a stream the owner asked to retry after a non-terminal close. */
  retry(): void {
    if (this.socket) return
    this.attempt = 0
    this.stopped = false
    this.open()
  }

  /**
   * Tells the daemon what to lay the page out at. Sent on every (re)connect
   * and whenever the view is measured again, because the daemon keeps the
   * last viewport it was given, not the one the phone currently shows.
   */
  setViewport(viewport: { width: number; height: number; deviceScaleFactor: number }): void {
    const rounded = {
      width: Math.max(1, Math.round(viewport.width)),
      height: Math.max(1, Math.round(viewport.height)),
      deviceScaleFactor: Math.min(4, Math.max(1, viewport.deviceScaleFactor || 1)),
    }
    const current = this.viewport
    if (
      current &&
      current.width === rounded.width &&
      current.height === rounded.height &&
      current.deviceScaleFactor === rounded.deviceScaleFactor
    ) return
    this.viewport = rounded
    this.send({ type: 'viewport', ...rounded })
  }

  sendInput(messages: readonly TileInputMessage[]): void {
    for (const event of messages) this.send({ type: 'input', event })
  }

  reload(): void {
    this.send({ type: 'reload' })
  }

  inspect(x: number, y: number, grade: TileInspectGrade): Promise<TileInspectResult> {
    return this.request<TileInspectResult>('inspect_result', (id) => ({
      type: 'inspect',
      id,
      x: Math.max(0, Math.round(x)),
      y: Math.max(0, Math.round(y)),
      grade,
    }), (message) => parseTileInspectResult(message))
  }

  resolveSelectors(items: readonly TileSelectorResolveItem[]): Promise<TileSelectorAnchor[]> {
    if (items.length === 0) return Promise.resolve([])
    return this.request<TileSelectorAnchor[]>('resolve_selectors_result', (id) => ({
      type: 'resolve_selectors',
      id,
      items: items.slice(0, 50) as TileSelectorResolveItem[],
    }), (message) => (message.ok === true ? parseTileSelectorAnchors(message.anchors) : []))
  }

  private request<T>(
    replyType: string,
    build: (id: string) => TileClientMessage,
    parse: (message: Record<string, unknown>) => T,
  ): Promise<T> {
    const socket = this.socket
    if (!socket || socket.readyState !== 1) {
      return Promise.reject(new Error('The tile stream is not connected'))
    }
    const id = nextRequestId()
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.requests.delete(`${replyType}:${id}`)
        reject(new Error('Chromium did not answer in time'))
      }, REQUEST_TIMEOUT_MS)
      this.requests.set(`${replyType}:${id}`, {
        resolve: resolve as (value: never) => void,
        reject,
        timer,
        route: (message) => resolve(parse(message)),
      })
      socket.send(JSON.stringify(build(id)))
    })
  }

  private send(message: TileClientMessage): void {
    const socket = this.socket
    if (!socket || socket.readyState !== 1) return
    socket.send(JSON.stringify(message))
  }

  private setState(next: TileRelayState): void {
    if (next === this.state) return
    this.state = next
    for (const listener of this.listeners) listener(next)
  }

  private failRequests(reason: string): void {
    for (const request of this.requests.values()) {
      clearTimeout(request.timer)
      request.reject(new Error(reason))
    }
    this.requests.clear()
  }

  private open(): void {
    if (this.stopped || this.socket) return
    this.setState({ ...this.state, phase: 'connecting', detail: 'Connecting to the tile…' })

    const headers: Record<string, string> = {}
    if (this.options.host.auth.kind === 'session' && this.options.cookie) {
      headers.Cookie = this.options.cookie
    }

    let socket: WebSocket
    try {
      socket = this.options.createSocket
        ? this.options.createSocket(this.url, Object.keys(headers).length ? headers : undefined)
        : new NativeWebSocket(this.url, null, Object.keys(headers).length ? { headers } : undefined)
    } catch (error) {
      this.scheduleRetry(error instanceof Error ? error.message : 'Could not open the tile stream')
      return
    }
    this.socket = socket

    socket.onopen = () => {
      if (this.socket !== socket) return
      this.attempt = 0
      // The daemon keeps the last viewport it was told about, so re-send ours.
      const viewport = this.viewport
      this.viewport = null
      if (viewport) this.setViewport(viewport)
    }

    socket.onmessage = (event: { data?: unknown }) => {
      if (this.socket !== socket) return
      const message = parseTileServerMessage(event.data)
      if (!message) return
      if (message.type === 'inspect_result' || message.type === 'resolve_selectors_result') {
        const key = `${message.type}:${String((message as { id?: unknown }).id ?? '')}`
        const request = this.requests.get(key)
        if (!request) return
        this.requests.delete(key)
        clearTimeout(request.timer)
        request.route(message as unknown as Record<string, unknown>)
        return
      }
      // Chromium attaches its target on `ready`; re-assert the viewport so a
      // target that came up after ours does not keep the engine's default.
      if (message.type === 'ready' && this.viewport) this.send({ type: 'viewport', ...this.viewport })
      this.setState(reduceTileMessage(this.state, message))
    }

    socket.onerror = () => {
      // `onclose` always follows and owns the retry decision.
    }

    socket.onclose = (event: { code?: number; reason?: string }) => {
      if (this.socket !== socket) return
      this.socket = null
      this.failRequests('The tile stream closed.')
      const next = tileCloseState(this.state, event.code, event.reason)
      this.setState(next)
      if (this.stopped) return
      // 4404 / 4410 / 4503 are the daemon saying "not this tile, not now".
      if (next.phase === 'gone' || next.phase === 'unavailable') return
      this.scheduleRetry(next.detail)
    }
  }

  private scheduleRetry(detail: string): void {
    if (this.stopped) return
    this.attempt += 1
    const delay = tileRetryDelay(this.attempt)
    this.setState({
      ...this.state,
      phase: 'closed',
      detail: `${detail} · retrying in ${Math.round(delay / 1_000)}s`,
    })
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      this.open()
    }, delay)
  }
}
