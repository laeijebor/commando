import { useEffect } from 'react'

import { useHostsStore } from '../hosts/store'
import type { Host } from '../hosts/types'
import { connectHost } from './client'
import { useHostState } from './store'
import type { HostDaemonState } from './state'

/**
 * Keeps a host's socket open for as long as a screen for that host is mounted
 * and returns its slice of the store. The socket itself is shared, so moving
 * between the sessions list and a pane does not tear it down.
 */
export function useDaemonConnection(host: Host | undefined): HostDaemonState {
  const cookie = useHostsStore((state) => (host ? state.cookies[host.id] : undefined))
  const state = useHostState(host?.id)

  useEffect(() => {
    if (!host) return
    connectHost(host, cookie ?? null)
  }, [host, cookie])

  return state
}
