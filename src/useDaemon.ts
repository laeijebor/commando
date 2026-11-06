import { useHost } from './HostContext'
import { daemonWebSocketUrl } from './hostPaths'
import { useCallback, useEffect, useEffectEvent, useRef, useState } from 'react'

import { publishCanvasSpotlights, publishCanvasChange, publishGuideStateChanged, publishCanvasThreadsChanged, publishCanvasPendingChanged, publishCanvasRefresh } from './webPanesApi'
import type { ClientMessage, CommandoSnapshot, ServerMessage } from '../shared/protocol'

export type ConnectionPhase =
  | 'signed-out'
  | 'loading-snapshot'
  | 'connecting'
  | 'live'
  | 'reconnecting'
  | 'unauthorized'

export type ConnectionState = {
  phase: ConnectionPhase
  detail: string
  attempt: number
  retryAt?: number
  /** Which credential failed: this Mac's owner login, or the saved host token. */
  authSource?: 'local' | 'host'
}

const INITIAL_CONNECTION: ConnectionState = {
  phase: 'signed-out',
  detail: 'Sign in required',
  attempt: 0,
}

function isSnapshot(value: unknown): value is CommandoSnapshot {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<CommandoSnapshot>
  return (
    typeof candidate.revision === 'number' &&
    Array.isArray(candidate.sessions) &&
    Array.isArray(candidate.windows) &&
    Array.isArray(candidate.panes) &&
    Array.isArray(candidate.ports)
  )
}

function snapshotFromResponse(value: unknown): CommandoSnapshot | null {
  if (isSnapshot(value)) return value
  if (value && typeof value === 'object' && 'snapshot' in value) {
    const nested = (value as { snapshot: unknown }).snapshot
    return isSnapshot(nested) ? nested : null
  }
  return null
}

export function useDaemon(
  token: string,
  sessionAuthenticated: boolean,
  onMessage: (message: ServerMessage) => void,
) {
  const { activeHost, local, daemonFetch } = useHost()
  const [connection, setConnection] = useState<ConnectionState>(INITIAL_CONNECTION)
  const socketRef = useRef<WebSocket | null>(null)
  const receiveMessage = useEffectEvent(onMessage)

  useEffect(() => {
    if (!token && !sessionAuthenticated) {
      socketRef.current = null
      setConnection(INITIAL_CONNECTION)
      return
    }

    let cancelled = false
    let reconnectTimer: number | undefined
    let attempt = 0
    const abortController = new AbortController()

    const authFailure = async (response: Response): Promise<'local' | 'host' | null> => {
      if (response.ok) return null
      if (!local) {
        const body = await response.clone().json().catch(() => ({})) as { code?: string }
        if (body.code === 'host_unauthorized') return 'host'
        if (body.code === 'unauthorized') return 'local'
      }
      // Upstream 401/403 responses are normalized by the proxy. An unlabelled
      // rejection therefore requires refreshing this Mac's owner credentials.
      return response.status === 401 || response.status === 403 ? 'local' : null
    }
    const rejectAuth = (authSource: 'local' | 'host') => {
      if (cancelled) return
      setConnection({
        phase: 'unauthorized', authSource, attempt,
        detail: authSource === 'local' ? 'This Mac requires a new owner login or daemon token' : 'The remote host rejected its saved token',
      })
    }

    const connect = (isReconnect: boolean) => {
      if (cancelled) return

      setConnection({
        phase: isReconnect ? 'reconnecting' : 'connecting',
        detail: isReconnect ? `Reconnecting to ${local ? 'local' : 'remote'} daemon (attempt ${attempt})` : 'Opening live channel',
        attempt,
      })

      const socket = new WebSocket(daemonWebSocketUrl(activeHost, token))
      socketRef.current = socket

      socket.addEventListener('open', () => {
        if (cancelled) return
        attempt = 0
        if (local) publishCanvasRefresh()
        setConnection({
          phase: 'live',
          detail: local ? 'Authenticated local stream' : 'Authenticated remote stream',
          attempt: 0,
        })
      })

      socket.addEventListener('message', (event) => {
        if (cancelled || typeof event.data !== 'string') return
        try {
          const message = JSON.parse(event.data) as ServerMessage
          if (!local && (message.type.startsWith('canvas_') || message.type === 'guide_state_changed' || message.type === 'session_ides')) return
          if (message.type === 'canvas_pending_changed') publishCanvasPendingChanged(message.webPaneId)
          else if (message.type === 'canvas_threads_changed') publishCanvasThreadsChanged(message.webPaneId)
          else if (message.type === 'canvas_changed') publishCanvasChange(message)
          else if (message.type === 'guide_state_changed') publishGuideStateChanged(message)
          else {
            if (local && message.type === 'web_panes') publishCanvasSpotlights(message.spotlightRequests ?? {})
            receiveMessage(message)
          }
        } catch {
          setConnection((current) => ({
            ...current,
            detail: 'Live, but ignored a malformed daemon message',
          }))
        }
      })

      socket.addEventListener('close', (event) => {
        if (cancelled) return
        if (socketRef.current === socket) socketRef.current = null

        const authClose = event.code === 4401 || event.code === 4403
        if (local && authClose) {
          rejectAuth('local')
          return
        }
        if (!local) {
          setConnection({ phase: 'reconnecting', detail: 'Checking the closed remote stream', attempt })
        }

        const assessAndReconnect = async () => {
          if (event.code === 1006 || !local) {
            try {
              const response = await daemonFetch('/api/health', {
                credentials: 'same-origin',
                headers: token ? { Authorization: `Bearer ${token}` } : undefined,
                signal: abortController.signal,
              })
              const healthAuth = await authFailure(response)
              if (cancelled) return
              if (healthAuth) { rejectAuth(healthAuth); return }
              if (!local && response.ok) {
                // Health may be public on the hub. Probe a protected route too:
                // the browser cannot expose the body of a rejected WS upgrade.
                const protectedResponse = await daemonFetch('/api/snapshot', {
                  credentials: 'same-origin',
                  headers: token ? { Authorization: `Bearer ${token}` } : undefined,
                  signal: abortController.signal,
                })
                const snapshotAuth = await authFailure(protectedResponse)
                if (cancelled) return
                if (snapshotAuth) { rejectAuth(snapshotAuth); return }
                if (protectedResponse.ok && authClose) { rejectAuth('host'); return }
              }
            } catch {
              // Unreachable probes cannot identify a bad credential; retry the stream.
            }
          }

          if (cancelled) return
          attempt += 1
          const delay = Math.min(500 * 2 ** Math.min(attempt - 1, 5), 15_000)
          const retryAt = Date.now() + delay
          setConnection({
            phase: 'reconnecting',
            detail:
              event.code === 1008
                ? 'The daemon closed the stream because of a policy violation'
                : `Stream closed${event.reason ? `: ${event.reason}` : ''}`,
            attempt,
            retryAt,
          })
          reconnectTimer = window.setTimeout(() => connect(true), delay)
        }
        void assessAndReconnect()
      })
    }

    const hydrate = async () => {
      setConnection({
        phase: 'loading-snapshot',
        detail: 'Authenticating snapshot request',
        attempt: 0,
      })

      try {
        const response = await daemonFetch('/api/snapshot', {
          credentials: 'same-origin',
          headers: {
            Accept: 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          signal: abortController.signal,
        })

        if (cancelled) return
        const snapshotAuth = await authFailure(response)
        if (cancelled) return
        if (snapshotAuth) { rejectAuth(snapshotAuth); return }
        if (!response.ok) throw new Error(`Snapshot request returned ${response.status}`)

        const snapshot = snapshotFromResponse(await response.json())
        if (cancelled) return
        if (!snapshot) throw new Error('Snapshot response did not match the protocol')
        receiveMessage({ type: 'snapshot', snapshot })
        connect(false)
      } catch (error) {
        if (cancelled || abortController.signal.aborted) return
        setConnection({
          phase: local ? 'connecting' : 'reconnecting',
          detail: error instanceof Error ? error.message : 'Snapshot request failed',
          attempt: 0,
        })
        if (local) connect(false)
        else reconnectTimer = window.setTimeout(() => void hydrate(), 5_000)
      }
    }

    void hydrate()

    return () => {
      cancelled = true
      abortController.abort()
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer)
      const socket = socketRef.current
      socketRef.current = null
      socket?.close(1000, 'Client reset')
    }
  }, [sessionAuthenticated, token, activeHost, daemonFetch, local])

  const send = useCallback((message: ClientMessage) => {
    const socket = socketRef.current
    if (!socket || socket.readyState !== WebSocket.OPEN) return false
    socket.send(JSON.stringify(message))
    return true
  }, [])

  return { connection, send }
}
