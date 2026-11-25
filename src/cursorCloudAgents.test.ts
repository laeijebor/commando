// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createCursorCloudAgentsApi, CursorCloudAgentsStore, type CursorCloudAgentsApi } from './cursorCloudAgents'

const response = { login: 'ok' as const, agents: [], more: false }
function fixture() {
  const api = { list: vi.fn<CursorCloudAgentsApi['list']>().mockResolvedValue(response), open: vi.fn<CursorCloudAgentsApi['open']>().mockResolvedValue('%7') }
  return { api, store: new CursorCloudAgentsStore(api) }
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

describe('CursorCloudAgentsStore', () => {
  it('polls every 30 seconds while subscribed, refreshes on focus, and stops on unmount', async () => {
    vi.useFakeTimers()
    const { api, store } = fixture()
    const unsubscribe = store.subscribe(vi.fn())
    await store.refresh()
    expect(api.list).toHaveBeenCalledExactlyOnceWith(false)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(api.list).toHaveBeenCalledTimes(2)
    window.dispatchEvent(new Event('focus'))
    await store.refresh()
    expect(api.list).toHaveBeenCalledTimes(3)
    unsubscribe()
    await vi.advanceTimersByTimeAsync(60_000)
    window.dispatchEvent(new Event('focus'))
    expect(api.list).toHaveBeenCalledTimes(3)
  })
  it('pauses polling when hidden, resumes on visibility, and supports manual cache bypass', async () => {
    vi.useFakeTimers()
    const { api, store } = fixture()
    const unsubscribe = store.subscribe(vi.fn())
    await store.refresh()
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    await vi.advanceTimersByTimeAsync(30_000)
    expect(api.list).toHaveBeenCalledTimes(1)
    visibility.mockReturnValue('visible')
    document.dispatchEvent(new Event('visibilitychange'))
    await store.refresh()
    expect(api.list).toHaveBeenCalledTimes(2)
    await store.refresh(true)
    expect(api.list).toHaveBeenLastCalledWith(true)
    unsubscribe()
  })
  it('coalesces overlapping reads and exposes errors inline', async () => {
    const { api, store } = fixture()
    let resolve!: (value: typeof response) => void
    api.list.mockReturnValue(new Promise((done) => { resolve = done }))
    const first = store.refresh()
    expect(store.refresh()).toBe(first)
    expect(store.getSnapshot().loading).toBe(true)
    resolve(response); await first
    api.list.mockRejectedValue(new Error('unavailable'))
    await store.refresh()
    expect(store.getSnapshot()).toMatchObject({ loaded: true, loading: false, error: expect.stringMatching(/Unable to load/) })
    api.list.mockResolvedValue(response)
    await store.refresh()
    expect(store.getSnapshot().error).toBeUndefined()
  })
  it('keeps the opened pane in the snapshot', async () => {
    const { api, store } = fixture()
    api.list.mockResolvedValue({ ...response, agents: [{ agentId: 'bc-12345678', name: 'Cloud', lastModified: 0, webUrl: 'https://cursor.com/agents/bc-12345678', startedInCommando: true }] })
    await store.refresh()
    expect(await store.open('bc-12345678')).toBe('%7')
    expect(store.getSnapshot().agents[0].openPaneId).toBe('%7')
  })
})

describe('Cursor cloud agents HTTP client', () => {
  it('uses authenticated requests, refresh query and open pane response', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(JSON.stringify(response)))
      .mockResolvedValueOnce(new Response(JSON.stringify({ paneId: '%8' })))
    const api = createCursorCloudAgentsApi('owner-token', fetcher)
    await expect(api.list(true)).resolves.toEqual(response)
    expect(fetcher).toHaveBeenCalledWith('/api/cursor-cloud-agents?refresh=1', expect.objectContaining({ credentials: 'same-origin', headers: { Accept: 'application/json', Authorization: 'Bearer owner-token' } }))
    expect(await api.open('bc-12345678')).toBe('%8')
    expect(fetcher).toHaveBeenLastCalledWith('/api/cursor-cloud-agents/bc-12345678/open', expect.objectContaining({ method: 'POST' }))
  })
  it('returns daemon validation errors to the caller', async () => {
    const api = createCursorCloudAgentsApi('', vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ error: 'No local checkout' }), { status: 409 })))
    await expect(api.open('bc-12345678')).rejects.toThrow('No local checkout')
  })
})
