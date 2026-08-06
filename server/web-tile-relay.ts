import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocket, WebSocketServer, type RawData } from 'ws'
import { parseTileInputEvent, parseTileInspectRequest, type ChromiumEngine } from './chromium-engine.js'
import type { WebPaneService } from './web-panes.js'

const WEB_TILE_PATH = /^\/ws\/web-tiles\/(w-[0-9a-f]{8})$/
const MAX_CLIENT_MESSAGE_BYTES = 16 * 1024

/** Extracts the web pane id from a tile-stream upgrade path, if it is one. */
export function webTilePathId(pathname: string): string | null {
  return WEB_TILE_PATH.exec(pathname)?.[1] ?? null
}

type RelayDependencies = {
  engine: ChromiumEngine
  service: WebPaneService
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
    this.webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
      this.connect(webSocket, webPaneId)
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

  close(): void {
    for (const sockets of this.subscribers.values()) {
      for (const socket of sockets) socket.terminate()
    }
    this.subscribers.clear()
    this.webSocketServer.close()
  }

  private connect(socket: WebSocket, webPaneId: string): void {
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

    this.dependencies.engine
      .subscribeScreencast(webPaneId, pane.url, (frame) => {
        if (socket.readyState !== WebSocket.OPEN) return
        socket.send(JSON.stringify({
          type: 'frame',
          data: frame.data,
          format: frame.format,
          metadata: frame.metadata,
        }))
      })
      .then((stop) => {
        if (closed) {
          stop()
          return
        }
        unsubscribe = stop
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: 'ready' }))
        }
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

    socket.on('message', (data: RawData) => this.receive(socket, webPaneId, data))
    socket.on('close', cleanup)
    socket.on('error', cleanup)
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
    }
  }
}
