import { create } from 'zustand'
import { readPreference, writePreference } from '../prefs'

import { DEMO_ORIGIN, autoDemoEnabled, demoHost, isDemoHost } from '../demo/flags'
import { disconnectHost } from '../daemon/client'
import { useDaemonStore } from '../daemon/store'
import { usePushStore } from '../notifications/store'
import { probeHost } from './api'
import { createHostId, loadHosts, saveHosts } from './storage'
import { normaliseBaseUrl, type Host, type HostAuth, type HostReachability } from './types'

export const SELECTED_HOST_KEY = 'commando.hosts.selection'

type HostsState = {
  hosts: Host[]
  hydrated: boolean
  selectedHostId: string | null
  /** Consumed once by the root screen; returning to Hosts must never redirect. */
  initialHostId: string | null
  rememberHost: (id: string | null) => void
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
  selectedHostId: null,
  initialHostId: null,
  reachability: {},
  cookies: {},

  hydrate: async () => {
    if (get().hydrated) return
    const [saved, remembered] = await Promise.all([loadHosts(), readPreference(SELECTED_HOST_KEY)])
    if (get().hydrated) return
    const hosts = saved.filter((host) => __DEV__ || host.baseUrl !== DEMO_ORIGIN)
    if (autoDemoEnabled() && !hosts.some(isDemoHost)) hosts.unshift(demoHost())
    const initialHostId = autoDemoEnabled() && saved.length === 0 && !remembered ? hosts.find(isDemoHost)?.id ?? null : null
    set({ hosts, hydrated: true, initialHostId, selectedHostId: hosts.some((host) => host.id === remembered) ? remembered : null })
    if (hosts.length !== saved.length) await saveHosts(hosts)
    await get().refreshAll()
  },

  rememberHost: (id) => {
    if (id === get().selectedHostId && !get().initialHostId) return
    set({ selectedHostId: id, initialHostId: null })
    void writePreference(SELECTED_HOST_KEY, id ?? 'hosts')
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
    if (get().selectedHostId === id) get().rememberHost(null)
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
