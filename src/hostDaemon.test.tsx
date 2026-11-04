// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ACTIVE_HOST_STORAGE_KEY, HostProvider, HostWorkspace, useHost } from './HostContext'
import { useDaemon } from './useDaemon'

class Socket extends EventTarget {
  static OPEN = 1
  static instances: Socket[] = []
  readyState = 1
  send = vi.fn()
  close = vi.fn()
  constructor(readonly url: string) { super(); Socket.instances.push(this) }
}
const snapshot = { revision: 1, sessions: [], windows: [], panes: [], ports: [] }
beforeEach(() => {
  localStorage.clear(); Socket.instances = []
  vi.stubGlobal('WebSocket', Socket)
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(snapshot))))
})
afterEach(() => { cleanup(); localStorage.clear(); vi.unstubAllGlobals() })
function Client({ onMessage = vi.fn() }) {
  const { switchHost } = useHost()
  const { connection } = useDaemon('owner', false, onMessage)
  return <><output>{connection.phase}</output><button onClick={() => switchHost('hub')}>Hub</button></>
}
it('hydrates and connects the remote socket, closing the old stream and ignoring its late messages', async () => {
  const onMessage = vi.fn()
  render(<HostProvider><HostWorkspace><Client onMessage={onMessage} /></HostWorkspace></HostProvider>)
  await waitFor(() => expect(Socket.instances).toHaveLength(1))
  const previous = Socket.instances[0]
  expect(previous.url).toBe(`ws://${window.location.host}/ws?token=owner`)
  fireEvent.click(screen.getByRole('button', { name: 'Hub' }))
  await waitFor(() => expect(Socket.instances).toHaveLength(2))
  expect(previous.close).toHaveBeenCalledWith(1000, 'Client reset')
  expect(fetch).toHaveBeenCalledWith('/h/hub/api/snapshot', expect.anything())
  expect(Socket.instances[1].url).toBe(`ws://${window.location.host}/h/hub/ws?token=owner`)
  const count = onMessage.mock.calls.length
  act(() => previous.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'snapshot', snapshot }) })))
  expect(onMessage).toHaveBeenCalledTimes(count)
  act(() => Socket.instances[1].dispatchEvent(new Event('open')))
  expect(screen.getByRole('status')).toHaveTextContent('live')
})
it.each([['host_unreachable', 'reconnecting'], ['host_unauthorized', 'unauthorized']] as const)('fails closed on %s without requesting local workspace data', async (code, phase) => {
  localStorage.setItem(ACTIVE_HOST_STORAGE_KEY, 'hub')
  vi.mocked(fetch).mockImplementation(async () => new Response(JSON.stringify({ code }), { status: 502 }))
  const onMessage = vi.fn()
  render(<HostProvider><HostWorkspace><Client onMessage={onMessage} /></HostWorkspace></HostProvider>)
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(phase))
  expect(Socket.instances).toHaveLength(0)
  expect(onMessage).not.toHaveBeenCalled()
  expect(vi.mocked(fetch).mock.calls.every(([path]) => path === '/h/hub/api/snapshot')).toBe(true)
})
