import type { WebPanePendingSnapshot } from '../shared/protocol'

type PendingSocketMessage = {
  type?: string
  revision?: unknown
  notes?: unknown
  knownUpTo?: unknown
  dropped?: unknown
}

/** Subscribes to queue snapshots without starting the Chromium screencast. */
export function subscribeWebTilePending(
  webPaneId: string,
  wsToken: string,
  listener: (snapshot: WebPanePendingSnapshot) => void,
): () => void {
  const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  const query = new URLSearchParams({ mode: 'review' })
  if (wsToken) query.set('token', wsToken)
  const socket = new WebSocket(
    `${wsProtocol}//${window.location.host}/ws/web-tiles/${webPaneId}?${query.toString()}`,
  )
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
  socket.addEventListener('message', receive)
  return () => {
    socket.removeEventListener('message', receive)
    socket.close()
  }
}
