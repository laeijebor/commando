import { useSyncExternalStore } from 'react'
import { CURSOR_CLOUD_AGENTS_ROUTE, type CursorCloudAgentsResponse } from '../shared/cursor-cloud-agents'

export type CursorCloudAgentsApi = {
  list: (refresh: boolean) => Promise<CursorCloudAgentsResponse>
  open: (agentId: string) => Promise<string>
}
export function createCursorCloudAgentsApi(token: string, fetcher: typeof fetch = fetch): CursorCloudAgentsApi {
  async function request(path: string, method = 'GET') {
    const response = await fetcher(path, { method, credentials: 'same-origin',
      headers: { Accept: 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) } })
    const body = await response.json() as CursorCloudAgentsResponse & { error?: string; paneId?: string }
    if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`)
    return body
  }
  return {
    list: (refresh) => request(`${CURSOR_CLOUD_AGENTS_ROUTE}${refresh ? '?refresh=1' : ''}`),
    open: async (id) => {
      const body = await request(`${CURSOR_CLOUD_AGENTS_ROUTE}/${encodeURIComponent(id)}/open`, 'POST')
      if (!body.paneId) throw new Error('The daemon did not report the new chat pane.')
      return body.paneId
    },
  }
}

type Snapshot = CursorCloudAgentsResponse & { loading: boolean; loaded: boolean }
export class CursorCloudAgentsStore {
  private snapshot: Snapshot = { login: 'ok', agents: [], more: false, loading: false, loaded: false }
  private readonly listeners = new Set<() => void>()
  private timer?: ReturnType<typeof setInterval>
  private flight?: Promise<void>
  constructor(readonly api: CursorCloudAgentsApi) {}
  getSnapshot = (): Snapshot => this.snapshot
  private update(patch: Partial<Snapshot>) {
    this.snapshot = { ...this.snapshot, ...patch }
    this.listeners.forEach((listener) => listener())
  }
  private focus = () => { if (document.visibilityState !== 'hidden') void this.refresh() }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    if (this.listeners.size === 1) {
      void this.refresh()
      this.timer = setInterval(this.focus, 30_000)
      window.addEventListener('focus', this.focus)
      document.addEventListener('visibilitychange', this.focus)
    }
    return () => {
      this.listeners.delete(listener)
      if (!this.listeners.size) {
        clearInterval(this.timer)
        window.removeEventListener('focus', this.focus)
        document.removeEventListener('visibilitychange', this.focus)
      }
    }
  }
  refresh(manual = false): Promise<void> {
    if (this.flight) return this.flight
    this.update({ loading: true })
    this.flight = this.api.list(manual).then((response) => this.update({ ...response, error: response.error, loaded: true }),
      () => this.update({ error: 'Unable to load Cursor cloud agents. Refresh to retry.', loaded: true }))
      .finally(() => { this.flight = undefined; this.update({ loading: false }) })
    return this.flight
  }
  async open(id: string): Promise<string> {
    const paneId = await this.api.open(id)
    this.update({ agents: this.snapshot.agents.map((agent) => agent.agentId === id ? { ...agent, openPaneId: paneId } : agent) })
    return paneId
  }
}
export function useCursorCloudAgents(store: CursorCloudAgentsStore) {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
}
