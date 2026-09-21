import { create } from 'zustand'

type FocusStoreState = {
  /** The pane the cockpit is showing, per host, for this run of the app. */
  byHost: Record<string, string>
  focus: (hostId: string, paneId: string) => void
  clear: (hostId: string) => void
}

/**
 * Which pane each host's cockpit has focused. It is deliberately in memory
 * only: a pane id is meaningless after tmux restarts, and the fallback rules in
 * `chooseFocusedPane` pick a better pane than a stale one on a cold start.
 */
export const useFocusStore = create<FocusStoreState>((set, get) => ({
  byHost: {},

  focus: (hostId, paneId) => {
    if (get().byHost[hostId] === paneId) return
    set({ byHost: { ...get().byHost, [hostId]: paneId } })
  },

  clear: (hostId) => {
    if (!(hostId in get().byHost)) return
    const byHost = { ...get().byHost }
    delete byHost[hostId]
    set({ byHost })
  },
}))

export function useFocusedPaneId(hostId: string | undefined): string | undefined {
  return useFocusStore((state) => (hostId ? state.byHost[hostId] : undefined))
}
