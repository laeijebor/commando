import { create } from 'zustand'
import { normalizeSessionIdentities, type SessionIdentities } from '@commando/session-identity'
import { daemonFetch } from '../hosts/api'
import type { Host } from '../hosts/types'
import { readPreference, writePreference } from '../prefs'

type Preferences = { identities: Record<string, SessionIdentities>; seen: Record<string, Record<string, number>>; refresh: (host: Host) => Promise<void>; visit: (hostId: string, paneId: string) => void }
export const useSessionPreferences = create<Preferences>((set, get) => ({
  identities: {}, seen: {},
  refresh: async (host) => {
    try {
      const response = await daemonFetch(host, '/api/session-management/preferences')
      if (response.ok) {
        const body = await response.json() as { preferences?: { sessionIdentities?: unknown } }
        set({ identities: { ...get().identities, [host.id]: normalizeSessionIdentities(body.preferences?.sessionIdentities) } })
      }
    } catch { /* Name-derived identities remain usable offline. */ }
    const stored = await readPreference(`commando.chats.seen.${host.id}`)
    try {
      const parsed = JSON.parse(stored ?? '{}') as Record<string, unknown>
      const valid = Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, number] => typeof entry[1] === 'number' && Number.isFinite(entry[1])))
      set({ seen: { ...get().seen, [host.id]: { ...valid, ...get().seen[host.id] } } })
    } catch { /* Ignore old or corrupt local preferences. */ }
  },
  visit: (hostId, paneId) => {
    const seen = { ...get().seen[hostId], [paneId]: Date.now() }
    set({ seen: { ...get().seen, [hostId]: seen } })
    void writePreference(`commando.chats.seen.${hostId}`, JSON.stringify(seen))
  },
}))
