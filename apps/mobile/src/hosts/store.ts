import { create } from 'zustand'

import { disconnectHost } from '../daemon/client'
import { useDaemonStore } from '../daemon/store'
import { usePushStore } from '../notifications/store'
import { probeHost } from './api'
import { createHostId, loadHosts, saveHosts } from './storage'
import { normaliseBaseUrl, type Host, type HostAuth, type HostReachability } from './types'

type HostsState = {
  hosts: Host[]
  hydrated: boolean
  reachability: Record<string, HostReachability>
  /** Session cookie captured at sign-in, for sockets that skip the cookie jar. */
  cookies: Record<string, string>
  hydrate: () => Promise<void>
  addHost: (input: { name: string; baseUrl: string; auth?: HostAuth }) => Promise<Host>
  updateHost: (id: string, patch: Partial<Omit<Host, 'id'>>) => Promise<void>
  removeHost: (id: string) => Promise<void>
  setCookie: (id: string, cookie: string | null) => void
  refreshReachability: (id: string) => Promise<void>
  refreshAll: () => Promise<void>
}

export const useHostsStore = create<HostsState>((set, get) => ({
  hosts: [],
  hydrated: false,
  reachability: {},
  cookies: {},

  hydrate: async () => {
    const hosts = await loadHosts()
    set({ hosts, hydrated: true })
    await get().refreshAll()
  },

  addHost: async ({ name, baseUrl, auth }) => {
    const host: Host = {
      id: createHostId(),
      name: name.trim() || new URL(normaliseBaseUrl(baseUrl)).hostname,
      baseUrl: normaliseBaseUrl(baseUrl),
      auth: auth ?? { kind: 'session' },
    }
    const hosts = [...get().hosts, host]
    set({ hosts })
    await saveHosts(hosts)
    void get().refreshReachability(host.id)
    return host
  },

  updateHost: async (id, patch) => {
    const hosts = get().hosts.map((host) => (host.id === id ? { ...host, ...patch } : host))
    set({ hosts })
    await saveHosts(hosts)
  },

  removeHost: async (id) => {
    // The socket outlives the screen that opened it, so a removed host would
    // otherwise keep reconnecting to an address the owner has deleted.
    disconnectHost(id)
    useDaemonStore.getState().reset(id)
    await usePushStore.getState().forgetHost(id)
    const hosts = get().hosts.filter((host) => host.id !== id)
    const reachability = { ...get().reachability }
    const cookies = { ...get().cookies }
    delete reachability[id]
    delete cookies[id]
    set({ hosts, reachability, cookies })
    await saveHosts(hosts)
  },

  setCookie: (id, cookie) => {
    const cookies = { ...get().cookies }
    if (cookie) cookies[id] = cookie
    else delete cookies[id]
    set({ cookies })
  },

  refreshReachability: async (id) => {
    const host = get().hosts.find((candidate) => candidate.id === id)
    if (!host) return
    set({ reachability: { ...get().reachability, [id]: { state: 'checking' } } })
    const result = await probeHost(host)
    if (!get().hosts.some((candidate) => candidate.id === id)) return
    set({ reachability: { ...get().reachability, [id]: result } })
  },

  refreshAll: async () => {
    await Promise.all(get().hosts.map((host) => get().refreshReachability(host.id)))
  },
}))

export function selectHost(hosts: readonly Host[], hostId: string | undefined): Host | undefined {
  return hostId ? hosts.find((host) => host.id === hostId) : undefined
}
