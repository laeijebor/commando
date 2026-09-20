import { useEffect, useMemo, useRef, useState } from 'react'

import { useHostsStore } from '../hosts/store'
import type { Host } from '../hosts/types'
import { INITIAL_TILE_STATE, TileRelayClient, type TileRelayState } from './relay'

/**
 * Keeps one tile stream open for as long as the tile screen is mounted.
 * Unlike the `/ws` client this one is *not* shared: a tile stream costs the
 * daemon a CDP screencast, so it stops the moment the screen goes away.
 */
export function useTileRelay(
  host: Host | undefined,
  webPaneId: string | undefined,
  options: { enabled?: boolean } = {},
): { state: TileRelayState; client: TileRelayClient | null } {
  const cookie = useHostsStore((store) => (host ? store.cookies[host.id] : undefined))
  const [state, setState] = useState<TileRelayState>(INITIAL_TILE_STATE)
  const clientRef = useRef<TileRelayClient | null>(null)
  const enabled = options.enabled !== false

  // Every identity the socket depends on: an edited address, a changed token
  // or a fresh session cookie must reopen the stream, as the /ws client does.
  const auth = host?.auth.kind === 'token' ? `token:${host.auth.token}` : 'session'
  const key = host && webPaneId && enabled
    ? `${host.id}:${host.baseUrl}:${auth}:${webPaneId}:${cookie ?? ''}`
    : null

  useEffect(() => {
    if (!key || !host || !webPaneId) {
      setState(INITIAL_TILE_STATE)
      return
    }
    const client = new TileRelayClient({ host, webPaneId, cookie: cookie ?? null })
    clientRef.current = client
    setState(client.getState())
    const unsubscribe = client.subscribe(setState)
    client.start()
    return () => {
      unsubscribe()
      client.stop()
      if (clientRef.current === client) clientRef.current = null
      setState(INITIAL_TILE_STATE)
    }
    // `key` folds every identity the socket depends on into one dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  return useMemo(() => ({ state, client: clientRef.current }), [state])
}
