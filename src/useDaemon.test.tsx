// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useDaemon } from './useDaemon'
import { subscribeCanvasSpotlights, publishCanvasSpotlights, subscribeCanvasChanges, subscribeCanvasThreads, subscribeCanvasPending, subscribeCanvasRefresh } from './webPanesApi'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })
it('routes canvas changes from the existing daemon socket to mounted subscribers', async () => {
  const sockets: EventTarget[] = []
  vi.stubGlobal('WebSocket', class extends EventTarget { constructor() { super(); sockets.push(this) } close() {} })
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ revision: 1, sessions: [], windows: [], panes: [], ports: [] }) })))
  const receive = vi.fn(), changed = vi.fn(), unsubscribe = subscribeCanvasChanges(changed)
  const hook = renderHook(() => useDaemon('owner', false, receive))
  await waitFor(() => expect(sockets).toHaveLength(1))
  const change = { type: 'canvas_changed', artifactId: '0123456789abcdef', changed: ['Settings.html'] }
  act(() => sockets[0].dispatchEvent(new MessageEvent('message', { data: JSON.stringify(change) })))
  expect(changed).toHaveBeenCalledWith(change)
  expect(receive).not.toHaveBeenCalledWith(change)
  const threads = vi.fn(), pending = vi.fn()
  const unthreads = subscribeCanvasThreads(threads), unpending = subscribeCanvasPending(pending)
  act(() => {
    sockets[0].dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'canvas_threads_changed', webPaneId: 'w-12345678' }) }))
    sockets[0].dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'canvas_pending_changed', webPaneId: 'w-12345678' }) }))
  })
  expect(threads).toHaveBeenCalledExactlyOnceWith('w-12345678')
  expect(pending).toHaveBeenCalledExactlyOnceWith('w-12345678')
  const spotlight = vi.fn(), unspotlight = subscribeCanvasSpotlights(spotlight)
  spotlight.mockClear()
  const message = { type: 'web_panes', webPanes: [], spotlightRequests: { 'w-12345678': { id: 'sr-12345678', label: 'Row', requestedAt: 1 } } }
  act(() => sockets[0].dispatchEvent(new MessageEvent('message', { data: JSON.stringify(message) })))
  expect(spotlight).toHaveBeenCalledExactlyOnceWith(message.spotlightRequests)
  expect(receive).toHaveBeenCalledWith(message)
  unspotlight(); publishCanvasSpotlights({})
  const refreshed = vi.fn(), unrefresh = subscribeCanvasRefresh(refreshed)
  act(() => sockets[0].dispatchEvent(new Event('open')))
  expect(refreshed).toHaveBeenCalledOnce()
  unrefresh()
  unthreads(); unpending()
  unsubscribe()
  act(() => sockets[0].dispatchEvent(new MessageEvent('message', { data: JSON.stringify(change) })))
  expect(changed).toHaveBeenCalledOnce()
  hook.unmount()
})
