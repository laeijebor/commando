import type { WebPanePendingSnapshot } from '../shared/protocol'

type PendingSocketMessage = {
  type?: string
  revision?: unknown
  notes?: unknown
  knownUpTo?: unknown
  dropped?: unknown
}

const RECONNECT_BASE_MS = 250
const RECONNECT_MAX_MS = 5_000

/** Subscribes to queue snapshots without starting the Chromium screencast. */
export function subscribeWebTilePending(
  webPaneId: string,
  wsToken: string,
  listener: (snapshot: WebPanePendingSnapshot) => void,
): () => void {
  const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  const query = new URLSearchParams({ mode: 'review' })
  if (wsToken) query.set('token', wsToken)
  const socketUrl = `${wsProtocol}//${window.location.host}/ws/web-tiles/${webPaneId}?${query.toString()}`
  let socket: WebSocket | null = null
  let reconnectTimer: number | undefined
  let reconnectAttempt = 0
  let stopped = false
  let detachSocketListeners: (() => void) | undefined

  const connect = () => {
    if (stopped) return
    let nextSocket: WebSocket
    try {
      nextSocket = new WebSocket(socketUrl)
    } catch {
      scheduleReconnect()
      return
    }
    socket = nextSocket
    let settled = false
    const receive = (event: MessageEvent) => {
      if (typeof event.data !== 'string') return
      let message: PendingSocketMessage
      try {
        message = JSON.parse(event.data) as PendingSocketMessage
      } catch {
        return
      }
      if (
        message.type !== 'pending' ||
        !Array.isArray(message.notes) ||
        typeof message.knownUpTo !== 'number' ||
        typeof message.dropped !== 'number'
      ) return
      listener({
        ...(typeof message.revision === 'number' ? { revision: message.revision } : {}),
        notes: message.notes,
        knownUpTo: message.knownUpTo,
        dropped: message.dropped,
      })
    }
    const opened = () => {
      reconnectAttempt = 0
    }
    const detach = () => {
      nextSocket.removeEventListener('open', opened)
      nextSocket.removeEventListener('message', receive)
      nextSocket.removeEventListener('close', disconnect)
      nextSocket.removeEventListener('error', disconnect)
      if (detachSocketListeners === detach) detachSocketListeners = undefined
    }
    const disconnect = (event: Event) => {
      if (settled) return
      settled = true
      detach()
      if (socket === nextSocket) socket = null
      if (event.type === 'error') nextSocket.close()
      scheduleReconnect()
    }
    nextSocket.addEventListener('open', opened)
    nextSocket.addEventListener('message', receive)
    nextSocket.addEventListener('close', disconnect)
    nextSocket.addEventListener('error', disconnect)
    detachSocketListeners = detach
  }

  function scheduleReconnect(): void {
    if (stopped || reconnectTimer !== undefined) return
    const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * (2 ** reconnectAttempt))
    reconnectAttempt = Math.min(reconnectAttempt + 1, 5)
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = undefined
      connect()
    }, delay)
  }

  connect()
  return () => {
    if (stopped) return
    stopped = true
    if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer)
    reconnectTimer = undefined
    const activeSocket = socket
    socket = null
    detachSocketListeners?.()
    activeSocket?.close()
  }
}
