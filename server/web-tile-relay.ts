import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocket, WebSocketServer, type RawData } from 'ws'
import {
  parseTileInputEvent,
  parseTileInspectRequest,
  parseTileSelectorResolveRequest,
  parseTileSelectionRequest,
  type ChromiumEngine,
} from './chromium-engine.js'
import type { WebPaneService } from './web-panes.js'
import type { WebPanePendingSnapshot } from '../shared/protocol.js'

const WEB_TILE_PATH = /^\/ws\/web-tiles\/(w-[0-9a-f]{8})$/
const MAX_CLIENT_MESSAGE_BYTES = 16 * 1024

function isRetryableScreencastStart(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return message.includes('Page.startScreencast') || message.includes('Not attached to an active page')
}

/** Extracts the web pane id from a tile-stream upgrade path, if it is one. */
export function webTilePathId(pathname: string): string | null {
  return WEB_TILE_PATH.exec(pathname)?.[1] ?? null
}

type RelayDependencies = {
  engine: ChromiumEngine
  service: WebPaneService
  /** Current queued-but-unsent review notes for a tile, for connect-time hydration. */
  pendingNotes: (webPaneId: string) => WebPanePendingSnapshot
}

/**
 * Bridges chromium tiles to clients over `/ws/web-tiles/:id` (owner-only —
 * the upgrade handler authenticates before handing the socket over):
 * screencast frames flow out as JSON, validated input/viewport/reload
 * messages flow back into the engine.
 */
export class WebTileRelay {
  private readonly webSocketServer = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_CLIENT_MESSAGE_BYTES,
    perMessageDeflate: false,
  })
  private readonly subscribers = new Map<string, Set<WebSocket>>()

  constructor(private readonly dependencies: RelayDependencies) {}

  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer, webPaneId: string): void {
    const mode = new URL(request.url ?? '/', 'http://127.0.0.1').searchParams.get('mode')
    const reviewOnly = mode === 'review'
    this.webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
      this.connect(webSocket, webPaneId, reviewOnly)
    })
  }

  /** Closes streams for tiles that are gone, pending, or engine-switched. */
  dropStale(liveIds: ReadonlySet<string>): void {
    for (const webPaneId of [...this.subscribers.keys()]) {
      if (!liveIds.has(webPaneId)) this.dropTile(webPaneId)
    }
  }

  dropTile(webPaneId: string): void {
    const sockets = this.subscribers.get(webPaneId)
    if (!sockets) return
    this.subscribers.delete(webPaneId)
    for (const socket of sockets) socket.close(4410, 'Web tile is no longer streamable')
  }

  /**
   * Pushes the tile's full pending-note queue to its viewers. The daemon's
   * pending store is the source of truth — viewers replace, never merge, so
   * a missed push heals on the next one (or on reconnect).
   */
  broadcastPending(webPaneId: string, snapshot: WebPanePendingSnapshot): void {
    this.dependencies.engine.updatePendingSnapshot(webPaneId, snapshot)
    const sockets = this.subscribers.get(webPaneId)
    if (!sockets) return
    const message = JSON.stringify({ type: 'pending', ...snapshot })
    for (const socket of sockets) {
      if (socket.readyState === WebSocket.OPEN) socket.send(message)
    }
  }

  close(): void {
    for (const sockets of this.subscribers.values()) {
      for (const socket of sockets) socket.terminate()
    }
    this.subscribers.clear()
    this.webSocketServer.close()
  }

  private connect(socket: WebSocket, webPaneId: string, reviewOnly: boolean): void {
    const pane = this.dependencies.service.get(webPaneId)
    if (!pane || pane.engine !== 'chromium' || pane.status !== 'open') {
      socket.close(4404, 'No streamable chromium tile with this id')
      return
    }
    let sockets = this.subscribers.get(webPaneId)
    if (!sockets) {
      sockets = new Set()
      this.subscribers.set(webPaneId, sockets)
    }
    sockets.add(socket)

    const pending = this.dependencies.pendingNotes(webPaneId)
    // Seed before target subscription so the initial navigation can hydrate
    // the page even when the full replacement is empty.
    if (!reviewOnly) this.dependencies.engine.updatePendingSnapshot(webPaneId, pending)

    // Hydrate the viewer's pill queue immediately — answers queued while no
    // viewer was connected (or while another session was focused) must
    // reappear without waiting for the stream to come up.
    if ((pending.notes.length > 0 || pending.dropped > 0) && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'pending', ...pending }))
    }

    let unsubscribe: (() => void) | null = null
    let closed = false
    const cleanup = (): void => {
      if (closed) return
      closed = true
      unsubscribe?.()
      unsubscribe = null
      const remaining = this.subscribers.get(webPaneId)
      if (remaining) {
        remaining.delete(socket)
        if (remaining.size === 0) this.subscribers.delete(webPaneId)
      }
    }

    socket.on('message', (data: RawData) => {
      if (!reviewOnly) this.receive(socket, webPaneId, data)
    })
    socket.on('close', cleanup)
    socket.on('error', cleanup)

    if (reviewOnly) return

    const subscribe = () => this.dependencies.engine.subscribeScreencast(webPaneId, pane.url, (frame) => {
      if (socket.readyState !== WebSocket.OPEN) return
      socket.send(JSON.stringify({
        type: 'frame',
        data: frame.data,
        format: frame.format,
        metadata: frame.metadata,
      }))
    })

    subscribe()
      .catch((error: unknown) => {
        // Chrome can create and navigate a target while rejecting its first
        // screencast attach. Re-subscribing reuses that now-live target, which
        // is the same recovery the tile's manual Retry previously performed.
        if (closed || !isRetryableScreencastStart(error)) throw error
        return subscribe()
      })
      .then((stop) => {
        if (closed) {
          stop()
          return
        }
        unsubscribe = stop
        if (socket.readyState !== WebSocket.OPEN) return
        socket.send(JSON.stringify({ type: 'ready' }))
      })
      .catch((error: unknown) => {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({
            type: 'engine_error',
            message: error instanceof Error ? error.message : 'Chromium engine failed',
          }))
        }
        socket.close(4503, 'Chromium engine unavailable')
      })
  }

  private receive(socket: WebSocket, webPaneId: string, data: RawData): void {
    let message: Record<string, unknown>
    try {
      message = JSON.parse(data.toString()) as Record<string, unknown>
    } catch {
      return
    }
    if (typeof message !== 'object' || message === null) return
    const pane = this.dependencies.service.get(webPaneId)
    if (!pane || pane.engine !== 'chromium' || pane.status !== 'open') return

    if (message.type === 'input') {
      const event = parseTileInputEvent(message.event)
      if (event) this.dependencies.engine.dispatchInput(webPaneId, event)
      return
    }
    if (message.type === 'viewport') {
      const { width, height, deviceScaleFactor } = message
      if (
        typeof width === 'number' &&
        typeof height === 'number' &&
        typeof deviceScaleFactor === 'number'
      ) {
        void this.dependencies.engine
          .setViewport(webPaneId, { width, height, deviceScaleFactor })
          .catch(() => undefined)
      }
      return
    }
    if (message.type === 'reload') {
      void this.dependencies.engine.reload(webPaneId, pane.url).catch(() => undefined)
      return
    }
    if (message.type === 'inspect') {
      const request = parseTileInspectRequest(message)
      if (!request) return
      void this.dependencies.engine
        .inspectAt(webPaneId, request.x, request.y, request.grade)
        .catch((error: unknown) => ({
          ok: false as const,
          error: error instanceof Error ? error.message : 'Inspect failed',
        }))
        .then((result) => {
          if (socket.readyState !== WebSocket.OPEN) return
          socket.send(JSON.stringify({ type: 'inspect_result', id: request.id, ...result }))
        })
      return
    }
    if (message.type === 'resolve_selectors') {
      const request = parseTileSelectorResolveRequest(message)
      if (!request) return
      void this.dependencies.engine
        .resolveSelectors(webPaneId, request.items)
        .then((anchors) => ({ ok: true as const, anchors }))
        .catch(() => ({ ok: false as const, anchors: [] }))
        .then((result) => {
          if (socket.readyState !== WebSocket.OPEN) return
          socket.send(JSON.stringify({ type: 'resolve_selectors_result', id: request.id, ...result }))
        })
      return
    }
    if (message.type === 'selection') {
      const request = parseTileSelectionRequest(message)
      if (!request) return
      void this.dependencies.engine
        .readSelection(webPaneId)
        .catch(() => ({ ok: false as const, error: 'Could not read the page selection' }))
        .then((result) => {
          if (socket.readyState !== WebSocket.OPEN) return
          socket.send(JSON.stringify({ type: 'selection_result', id: request.id, ...result }))
        })
    }
  }
}
