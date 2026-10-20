import { ACCESS_REVOKED, onTokenRejected } from './access'
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
  addHost: (input: { name: string; baseUrl: string; auth?: HostAuth; requirePersistence?: boolean }) => Promise<Host>
  savePairedHost: (input: { name: string; baseUrl: string; token: string; pairing: NonNullable<Host['pairing']> }) => Promise<Host>
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

  addHost: async ({ name, baseUrl, auth, requirePersistence }) => {
    const host: Host = {
      id: createHostId(),
      name: name.trim() || new URL(normaliseBaseUrl(baseUrl)).hostname,
      baseUrl: normaliseBaseUrl(baseUrl),
      auth: auth ?? { kind: 'session' },
    }
    const hosts = [...get().hosts, host]
    if (requirePersistence) await saveHosts(hosts, true)
    set({ hosts })
    if (!requirePersistence) await saveHosts(hosts)
    void get().refreshReachability(host.id)
    return host
  },

  savePairedHost: async ({ name, baseUrl, token, pairing }) => {
    const urls = pairing.urls.map((url) => new URL(url).origin)
    const existing = get().hosts.find((host) => urls.includes(new URL(host.baseUrl).origin))
      ?? get().hosts.find((host) => host.pairing?.name === pairing.name && host.pairing.urls.some((url) => urls.includes(new URL(url).origin)))
    const host: Host = {
      ...existing,
      id: existing?.id ?? createHostId(),
      name: existing?.name ?? name,
      baseUrl: normaliseBaseUrl(baseUrl),
      auth: { kind: 'token', token },
      pairing: { name: pairing.name, urls },
    }
    const hosts = existing ? get().hosts.map((current) => current.id === host.id ? host : current) : [...get().hosts, host]
    // Do not publish replacement credentials until the keychain write succeeds.
    await saveHosts(hosts, true)
    disconnectHost(host.id)
    const cookies = { ...get().cookies }
    delete cookies[host.id]
    set({ hosts, cookies })
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
    if (get().hosts.find((candidate) => candidate.id === id) !== host) return
    set({ reachability: { ...get().reachability, [id]: result } })
  },

  refreshAll: async () => {
    await Promise.all(get().hosts.map((host) => get().refreshReachability(host.id)))
  },
}))

export function selectHost(hosts: readonly Host[], hostId: string | undefined): Host | undefined {
  return hostId ? hosts.find((host) => host.id === hostId) : undefined
}

// Ignore late responses from credentials that have already been replaced.
onTokenRejected((host) => {
  const current = useHostsStore.getState().hosts.find((candidate) => candidate.id === host.id)
  if (!current || current.auth.kind !== 'token' || host.auth.kind !== 'token' || current.auth.token !== host.auth.token) return
  disconnectHost(host.id)
  useDaemonStore.getState().setPhase(host.id, 'unauthorized', ACCESS_REVOKED)
  useHostsStore.setState((state) => ({ reachability: { ...state.reachability, [host.id]: { state: 'unauthorized', message: ACCESS_REVOKED, checkedAt: Date.now() } } }))
})
