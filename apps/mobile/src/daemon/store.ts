import { create } from 'zustand'

import type { ServerMessage } from '@commando/protocol'

import {
  applyServerMessage,
  EMPTY_HOST_STATE,
  type ConnectionPhase,
  type HostDaemonState,
} from './state'

type DaemonStoreState = {
  byHost: Record<string, HostDaemonState>
  ingest: (hostId: string, message: ServerMessage) => void
  setPhase: (hostId: string, phase: ConnectionPhase, detail: string, attempt?: number) => void
  reset: (hostId: string) => void
}

export const useDaemonStore = create<DaemonStoreState>((set, get) => ({
  byHost: {},

  ingest: (hostId, message) => {
    const current = get().byHost[hostId] ?? EMPTY_HOST_STATE
    const next = applyServerMessage(current, message)
    if (next === current) return
    set({ byHost: { ...get().byHost, [hostId]: next } })
  },

  setPhase: (hostId, phase, detail, attempt) => {
    const current = get().byHost[hostId] ?? EMPTY_HOST_STATE
    if (current.phase === phase && current.detail === detail && attempt === undefined) return
    set({
      byHost: {
        ...get().byHost,
        [hostId]: { ...current, phase, detail, attempt: attempt ?? current.attempt },
      },
    })
  },

  reset: (hostId) => {
    const byHost = { ...get().byHost }
    delete byHost[hostId]
    set({ byHost })
  },
}))

export function hostState(hostId: string | undefined): HostDaemonState {
  if (!hostId) return EMPTY_HOST_STATE
  return useDaemonStore.getState().byHost[hostId] ?? EMPTY_HOST_STATE
}

/** Selector hook — components re-render only when their host's slice changes. */
export function useHostState(hostId: string | undefined): HostDaemonState {
  return useDaemonStore((state) => (hostId ? state.byHost[hostId] : undefined) ?? EMPTY_HOST_STATE)
}
