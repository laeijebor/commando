// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SimLogsPanel } from './SimLogsPanel'
import { SimPermissionsPanel } from './SimPermissionsPanel'
import { createSimsApi } from './simsApi'

const U = 'AAAAAAAA-1111-1111-1111-111111111111'
const apps = [{ bundleId: 'com.example.app', name: 'Example', type: 'user' }, { bundleId: 'com.example.other', name: 'Other', type: 'user' },
  { bundleId: 'com.apple.settings', name: 'Settings', type: 'system' }]
class Socket {
  static instances: Socket[] = []
  onmessage: ((event: { data: unknown }) => void) | null = null
  onerror: (() => void) | null = null
  onclose: ((event: { reason: string }) => void) | null = null
  close = vi.fn()
  constructor(readonly url: string, readonly protocols: string[]) { Socket.instances.push(this) }
  line(message: string, level = 'info') { this.onmessage?.({ data: JSON.stringify({ t: 'now', level, process: '/Example', message }) }) }
}
const flush = async () => { await act(async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }) }
const advance = async (ms = 100) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms) }) }
let fetcher: ReturnType<typeof vi.fn<typeof fetch>>
let copy: ReturnType<typeof vi.fn>
beforeEach(() => {
  vi.useFakeTimers(); Socket.instances = []; vi.stubGlobal('WebSocket', Socket)
  fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, options) => new Response(JSON.stringify(options?.method === 'POST' ? { ok: true } : { apps })))
  copy = vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: copy } })
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers() })
const api = () => createSimsApi('token/value &', fetcher)

describe('Logs panel', () => {
  it.each([['App filter', 'com.example.app'], ['Level', 'debug']])('clears rendered and queued lines when %s changes', async (label, value) => {
    render(<SimLogsPanel api={api()} udid={U} token="" onClose={vi.fn()} />); await flush()
    const old = Socket.instances[0]
    act(() => old.line('old displayed line')); await advance()
    expect(screen.getByText('old displayed line')).toBeInTheDocument()
    act(() => old.line('old queued line'))
    fireEvent.change(screen.getByLabelText(label), { target: { value } })
    expect(screen.queryByText('old displayed line')).not.toBeInTheDocument()
    expect(old.onmessage).toBeNull()
    act(() => Socket.instances[1].line('new filtered line')); await advance()
    expect(screen.queryByText('old queued line')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Copy visible' })); await flush()
    expect(copy).toHaveBeenLastCalledWith('now info /Example new filtered line')
  })

  it('uses authenticated sockets, suggests user apps, and reconnects only for server filters', async () => {
    const { unmount } = render(<SimLogsPanel api={api()} udid={U} token="token/value &" onClose={vi.fn()} />); await flush()
    expect(Socket.instances[0].url).toContain(`/ws/api/sims/${U}/logs?level=info`)
    expect(Socket.instances[0].protocols).toEqual(['commando-live', 'commando-auth.token%2Fvalue%20%26'])
    expect(document.querySelectorAll('datalist option')).toHaveLength(2)
    fireEvent.change(screen.getByLabelText('Text filter'), { target: { value: 'error' } }); expect(Socket.instances).toHaveLength(1)
    fireEvent.change(screen.getByLabelText('Level'), { target: { value: 'debug' } })
    expect(Socket.instances[0].close).toHaveBeenCalledOnce(); expect(Socket.instances[1].url).toContain('level=debug')
    fireEvent.change(screen.getByLabelText('App filter'), { target: { value: 'com.example.app' } })
    expect(Socket.instances[1].close).toHaveBeenCalledOnce(); expect(Socket.instances[2].url).toContain('bundle=com.example.app')
    fireEvent.change(screen.getByLabelText('App filter'), { target: { value: 'invalid/id' } })
    expect(Socket.instances[2].close).toHaveBeenCalledOnce(); expect(screen.getByRole('alert')).toHaveTextContent('valid app bundle id')
    expect(Socket.instances).toHaveLength(3)
    fireEvent.change(screen.getByLabelText('App filter'), { target: { value: '' } })
    unmount(); expect(Socket.instances[3].close).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0)
  })

  it('batches at 100ms, discards while paused, caps at 2000 and copies only visible lines', async () => {
    render(<SimLogsPanel api={api()} udid={U} token="" onClose={vi.fn()} />); await flush()
    const socket = Socket.instances[0]
    act(() => { socket.line('first'); socket.line('fault message', 'Fault') })
    expect(screen.queryByText('first')).toBeNull(); await advance(99); expect(screen.queryByText('first')).toBeNull()
    await advance(1); expect(screen.getByText('first')).toBeInTheDocument()
    expect(screen.getByText('fault message').parentElement).toHaveClass('is-error')
    fireEvent.click(screen.getByRole('button', { name: 'Pause' })); act(() => socket.line('paused')); await advance()
    expect(screen.queryByText('paused')).toBeNull(); fireEvent.click(screen.getByRole('button', { name: 'Resume' }))
    act(() => { for (let i = 0; i < 2001; i++) socket.line(`entry ${i}`) }); await advance()
    const list = screen.getByLabelText('Log lines')
    expect(list.children).toHaveLength(2000); expect(screen.queryByText('entry 0', { exact: true })).toBeNull()
    fireEvent.change(screen.getByLabelText('Text filter'), { target: { value: 'entry 2000' } })
    expect(list.children).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'Copy visible' })); await flush()
    expect(copy).toHaveBeenCalledWith('now info /Example entry 2000')
    expect(screen.getByRole('status')).toHaveTextContent('Copied')
    act(() => socket.line('queued'))
    fireEvent.click(screen.getByRole('button', { name: 'Clear' })); await advance()
    expect(list.children).toHaveLength(0)
  })

  it('auto-scrolls only at the bottom, preserves memoized rows and shows close reasons', async () => {
    render(<SimLogsPanel api={api()} udid={U} token="" onClose={vi.fn()} />); await flush()
    const list = screen.getByLabelText('Log lines'), socket = Socket.instances[0]
    Object.defineProperties(list, { scrollHeight: { configurable: true, value: 1000 }, clientHeight: { configurable: true, value: 100 } })
    act(() => socket.line('one')); await advance(); expect(list.scrollTop).toBe(1000)
    const first = list.children[0]
    list.scrollTop = 100; fireEvent.scroll(list)
    act(() => socket.line('two')); await advance(); expect(list.scrollTop).toBe(100); expect(list.children[0]).toBe(first)
    list.scrollTop = 900; fireEvent.scroll(list)
    act(() => socket.line('three')); await advance(); expect(list.scrollTop).toBe(1000)
    act(() => socket.onclose?.({ reason: 'Baguette is not installed' }))
    expect(screen.getByRole('alert')).toHaveTextContent('Baguette is not installed')
  })
})

describe('Permissions panel', () => {
  it('picks user apps first and sends grant, deny, reset and reset-all actions with per-app history', async () => {
    render(<SimPermissionsPanel api={api()} udid={U} onClose={vi.fn()} />); await flush()
    expect(screen.getByLabelText('App')).toHaveValue('com.example.app')
    expect(screen.getByText('Some changes quit the running app.')).toBeInTheDocument()
    const row = within(screen.getByRole('group', { name: 'microphone' }))
    for (const [label, operation, history] of [['Grant', 'grant', 'Granted'], ['Deny', 'revoke', 'Denied'], ['Reset', 'reset', 'Reset']]) {
      fireEvent.click(row.getByRole('button', { name: label })); await flush()
      expect(fetcher).toHaveBeenLastCalledWith(`/api/sims/${U}/action`, expect.objectContaining({ body: JSON.stringify({ action: 'privacy', operation, service: 'microphone', bundleId: 'com.example.app' }) }))
      expect(row.getByText(`Last action: ${history}`)).toBeInTheDocument()
    }
    fireEvent.change(screen.getByLabelText('App'), { target: { value: 'com.example.other' } })
    expect(row.getByText('No action this session')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('App'), { target: { value: 'com.example.app' } })
    expect(row.getByText('Last action: Reset')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Reset all for this app' })); await flush()
    expect(fetcher).toHaveBeenLastCalledWith(`/api/sims/${U}/action`, expect.objectContaining({ body: JSON.stringify({ action: 'privacy', operation: 'reset', service: 'all', bundleId: 'com.example.app' }) }))
    expect(screen.getAllByText('Last action: Reset')).toHaveLength(13)
  })

  it('disables the pending row, prevents overlapping reset-all and shows failures', async () => {
    render(<SimPermissionsPanel api={api()} udid={U} onClose={vi.fn()} />); await flush()
    let reject!: (error: Error) => void
    fetcher.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail }))
    const row = within(screen.getByRole('group', { name: 'photos' }))
    fireEvent.click(row.getByRole('button', { name: 'Grant' }))
    for (const button of row.getAllByRole('button')) expect(button).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Reset all for this app' })).toBeDisabled()
    expect(within(screen.getByRole('group', { name: 'motion' })).getByRole('button', { name: 'Grant' })).toBeEnabled()
    act(() => reject(new Error('Privacy failed'))); await flush()
    expect(screen.getByRole('alert')).toHaveTextContent('Privacy failed')
    expect(row.getByRole('button', { name: 'Grant' })).toBeEnabled(); expect(row.getByText('No action this session')).toBeInTheDocument()
  })
})
