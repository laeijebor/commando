import { useEffect, useState } from 'react'

import { useHostsStore } from '../hosts/store'
import type { Host } from '../hosts/types'
import { connectHost, type DaemonClient } from './client'
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

/**
 * The same shared socket as `useDaemonConnection`, but handed back as the
 * client itself — the pane screen needs to send on it, not only read the store.
 */
export function useDaemonClient(host: Host | undefined): DaemonClient | undefined {
  const cookie = useHostsStore((state) => (host ? state.cookies[host.id] : undefined))
  const [client, setClient] = useState<DaemonClient | undefined>(undefined)

  useEffect(() => {
    if (!host) {
      setClient(undefined)
      return
    }
    setClient(connectHost(host, cookie ?? null))
  }, [host, cookie])

  return client
}
