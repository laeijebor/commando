// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useDaemon } from './useDaemon'
import { subscribeCanvasChanges } from './webPanesApi'

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
  unsubscribe()
  act(() => sockets[0].dispatchEvent(new MessageEvent('message', { data: JSON.stringify(change) })))
  expect(changed).toHaveBeenCalledOnce()
  hook.unmount()
})
