// @vitest-environment jsdom
import { useEffect, useState } from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RemoteHost } from '../shared/hosts'
import { ACTIVE_HOST_STORAGE_KEY, HostProvider, HostWorkspace, useHost } from './HostContext'
import { HostDialog, HostSwitcher, HostsSettings } from './HostSwitcher'
import { hostErrorMessage } from './hostsApi'
import { Thumbnail } from './chat/ChatImages'

const hosts: RemoteHost[] = ['online', 'offline', 'unauthorized'].map((state, index) => ({
  id: `host-${index}`, name: ['Hub', 'Mini', 'Studio'][index], baseUrl: 'http://hub.ts.net:4310', addedAt: 1,
  health: { state: state as RemoteHost['health']['state'], checkedAt: 1 },
}))
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status })
beforeEach(() => {
  localStorage.clear()
  vi.stubGlobal('fetch', vi.fn(async () => json({ hosts })))
})
afterEach(() => { cleanup(); localStorage.clear(); vi.unstubAllGlobals() })

function Workspace({ onUnmount }: { onUnmount?: () => void }) {
  const { activeHost, daemonFetch } = useHost()
  const [selection, setSelection] = useState('nothing')
  useEffect(() => onUnmount, [onUnmount])
  return <><HostSwitcher token="owner" /><output>{activeHost}: {selection}</output>
    <button onClick={() => setSelection('%1')}>Select pane</button>
    <button onClick={() => void daemonFetch('/api/snapshot')}>Snapshot</button>
  </>
}

describe('host switcher', () => {
  it('lists health, switches, persists and remounts pane/session state', async () => {
    const unmount = vi.fn()
    const view = render(<HostProvider><HostWorkspace><Workspace onUnmount={unmount} /></HostWorkspace></HostProvider>)
    const select = await screen.findByRole('combobox', { name: 'Active host' })
    await screen.findByRole('option', { name: /Hub · online/ })
    expect(within(select).getByRole('option', { name: /This Mac/ })).toBeInTheDocument()
    expect(within(select).getByRole('option', { name: /Mini · offline/ })).toBeInTheDocument()
    expect(within(select).getByRole('option', { name: /Studio · unauthorized/ })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Select pane' }))
    expect(screen.getByRole('status')).toHaveTextContent('local: %1')
    fireEvent.change(select, { target: { value: 'host-0' } })
    expect(screen.getByRole('status')).toHaveTextContent('host-0: nothing')
    expect(unmount).toHaveBeenCalledOnce()
    expect(localStorage.getItem(ACTIVE_HOST_STORAGE_KEY)).toBe('host-0')
    fireEvent.click(screen.getByRole('button', { name: 'Snapshot' }))
    await waitFor(() => expect(fetch).toHaveBeenCalledWith('/h/host-0/api/snapshot', expect.anything()))
    view.unmount()
    render(<HostProvider><HostWorkspace><Workspace /></HostWorkspace></HostProvider>)
    expect(screen.getByRole('combobox')).toHaveValue('host-0')
  })
  it('aborts old requests when switching and keeps the registry on This Mac', async () => {
    render(<HostProvider><HostWorkspace><Workspace /></HostWorkspace></HostProvider>)
    await screen.findByRole('option', { name: /Hub · online/ })
    fireEvent.click(screen.getByRole('button', { name: 'Snapshot' }))
    const [, init] = vi.mocked(fetch).mock.calls.find(([input]) => input === '/api/snapshot')!
    expect(init?.signal?.aborted).toBe(false)
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'host-0' } })
    expect(init?.signal?.aborted).toBe(true)
    await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/hosts', expect.anything()))
    expect(vi.mocked(fetch).mock.calls.some(([input]) => String(input).includes('/h/host-0/api/hosts'))).toBe(false)
  })
  it('opens Add host from the switcher and sends the credential only in the POST body', async () => {
    vi.mocked(fetch).mockImplementation(async (_input, init) => init?.method === 'POST' ? json({ host: hosts[0] }, 201) : json({ hosts: [] }))
    render(<HostProvider><Workspace /></HostProvider>)
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '__add' } })
    const dialog = screen.getByRole('dialog', { name: 'Add host' })
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Hub' } })
    fireEvent.change(within(dialog).getByLabelText('URL'), { target: { value: hosts[0].baseUrl } })
    fireEvent.change(within(dialog).getByLabelText('Token'), { target: { value: 'secret' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add host' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(fetch).toHaveBeenCalledWith('/api/hosts', expect.objectContaining({ method: 'POST', body: JSON.stringify({ name: 'Hub', baseUrl: hosts[0].baseUrl, token: 'secret' }) }))
    expect(localStorage.getItem(ACTIVE_HOST_STORAGE_KEY)).toBeNull()
    expect(localStorage.length).toBe(0)
  })
  it.each(['invalid_host', 'host_unreachable', 'host_unauthorized'] as const)('explains the daemon’s %s error', async (code) => {
    vi.mocked(fetch).mockResolvedValue(json({ code }, 502))
    render(<HostProvider><HostDialog token="owner" onClose={vi.fn()} /></HostProvider>)
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Hub' } })
    fireEvent.change(screen.getByLabelText('URL'), { target: { value: 'http://hub.ts.net' } })
    fireEvent.change(screen.getByLabelText('Token'), { target: { value: 'secret' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add host' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(hostErrorMessage(code))
  })
  it('edits hosts using the local registry while viewing a remote host', async () => {
    localStorage.setItem(ACTIVE_HOST_STORAGE_KEY, 'host-0')
    vi.mocked(fetch).mockImplementation(async (_input, init) => init?.method === 'PATCH' ? json({ host: { ...hosts[0], name: 'Hub renamed' } }) : json({ hosts }))
    render(<HostProvider><HostSwitcher token="owner" /><HostsSettings token="owner" /></HostProvider>)
    await screen.findByRole('option', { name: /Hub · online/ })
    fireEvent.click(screen.getAllByRole('button', { name: 'Edit' })[0])
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Hub renamed' } })
    fireEvent.change(screen.getByLabelText(/Replace token/), { target: { value: 'replacement' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save host' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(fetch).toHaveBeenCalledWith('/api/hosts/host-0', expect.objectContaining({ method: 'PATCH', body: '{"name":"Hub renamed","token":"replacement"}' }))
  })
  it('removes the viewed host through the local registry and switches back to This Mac', async () => {
    localStorage.setItem(ACTIVE_HOST_STORAGE_KEY, 'host-0')
    vi.stubGlobal('confirm', vi.fn(() => true))
    vi.mocked(fetch).mockImplementation(async (_input, init) => init?.method === 'DELETE' ? new Response(null, { status: 204 }) : json({ hosts }))
    render(<HostProvider><HostSwitcher token="owner" /><HostsSettings token="owner" /></HostProvider>)
    await screen.findByRole('option', { name: /Hub · online/ })
    fireEvent.click(screen.getAllByRole('button', { name: 'Remove' })[0])
    await waitFor(() => expect(screen.getByRole('combobox')).toHaveValue('local'))
    expect(fetch).toHaveBeenCalledWith('/api/hosts/host-0', expect.objectContaining({ method: 'DELETE' }))
    expect(localStorage.getItem(ACTIVE_HOST_STORAGE_KEY)).toBe('local')
  })
  it('never renders remote stored media against local image IDs', () => {
    localStorage.setItem(ACTIVE_HOST_STORAGE_KEY, 'host-0')
    render(<HostProvider><Thumbnail src="/chat-images/remote-id" name="remote image" onOpen={vi.fn()} /></HostProvider>)
    expect(screen.queryByRole('img')).toBeNull()
    expect(screen.getByText('Only on this Mac for now')).toBeInTheDocument()
  })
})
