import { useCallback, useEffect, useEffectEvent, useRef, useState } from 'react'

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

    const connect = (isReconnect: boolean) => {
      if (cancelled) return

      setConnection({
        phase: isReconnect ? 'reconnecting' : 'connecting',
        detail: isReconnect ? `Reconnecting to local daemon (attempt ${attempt})` : 'Opening live channel',
        attempt,
      })

      const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
      const tokenQuery = token ? `?token=${encodeURIComponent(token)}` : ''
      const socket = new WebSocket(`${wsProtocol}//${window.location.host}/ws${tokenQuery}`)
      socketRef.current = socket

      socket.addEventListener('open', () => {
        if (cancelled) return
        attempt = 0
        setConnection({
          phase: 'live',
          detail: 'Authenticated local stream',
          attempt: 0,
        })
      })

      socket.addEventListener('message', (event) => {
        if (typeof event.data !== 'string') return
        try {
          receiveMessage(JSON.parse(event.data) as ServerMessage)
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

        if (event.code === 4401 || event.code === 4403) {
          setConnection({
            phase: 'unauthorized',
            detail: 'The daemon rejected this session token',
            attempt,
          })
          return
        }

        const assessAndReconnect = async () => {
          if (event.code === 1006) {
            try {
              const response = await fetch('/api/health', {
                credentials: 'same-origin',
                headers: token ? { Authorization: `Bearer ${token}` } : undefined,
                signal: abortController.signal,
              })
              if (response.status === 401 || response.status === 403) {
                setConnection({
                  phase: 'unauthorized',
                  detail: 'The restarted daemon requires a new session token',
                  attempt,
                })
                return
              }
            } catch {
              // The daemon may still be offline; the bounded reconnect loop handles it.
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
        const response = await fetch('/api/snapshot', {
          credentials: 'same-origin',
          headers: {
            Accept: 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          signal: abortController.signal,
        })

        if (response.status === 401 || response.status === 403) {
          setConnection({
            phase: 'unauthorized',
            detail: 'The daemon rejected this session token',
            attempt: 0,
          })
          return
        }
        if (!response.ok) throw new Error(`Snapshot request returned ${response.status}`)

        const snapshot = snapshotFromResponse(await response.json())
        if (!snapshot) throw new Error('Snapshot response did not match the protocol')
        receiveMessage({ type: 'snapshot', snapshot })
        connect(false)
      } catch (error) {
        if (cancelled || abortController.signal.aborted) return
        setConnection({
          phase: 'connecting',
          detail: error instanceof Error ? error.message : 'Snapshot request failed',
          attempt: 0,
        })
        connect(false)
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
  }, [sessionAuthenticated, token])

  const send = useCallback((message: ClientMessage) => {
    const socket = socketRef.current
    if (!socket || socket.readyState !== WebSocket.OPEN) return false
    socket.send(JSON.stringify(message))
    return true
  }, [])

  return { connection, send }
}
