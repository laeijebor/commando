import { create } from 'zustand'
import { normalizeSessionIdentities, type SessionIdentities } from '@commando/session-identity'
import { daemonFetch } from '../hosts/api'
import type { Host } from '../hosts/types'
import type { ServerMessage } from '@commando/protocol'
import type { DaemonClient } from '../daemon/client'

type Preferences = { identities: Record<string, SessionIdentities>; seen: Record<string, Record<string, number>>; refresh: (host: Host) => Promise<void>; ingest: (hostId: string, message: ServerMessage) => void; visit: (hostId: string, paneId: string, client?: Pick<DaemonClient, 'send'>) => void }
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

  },
  ingest: (hostId, message) => {
    if (message.type !== 'pane_seen') return
    set({ seen: { ...get().seen, [hostId]: message.snapshot ? message.seen : { ...get().seen[hostId], ...message.seen } } })
  },
  visit: (_hostId, paneId, client) => {
    client?.send({ type: 'mark_panes_seen', paneIds: [paneId] })
  },
}))
