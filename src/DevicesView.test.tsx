// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, createEvent, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DevicesView, holderFlag, type DevicesSnapshot } from './DevicesView'

const NOW = 10 * 3_600_000
const snapshot = (overrides: Partial<DevicesSnapshot> = {}): DevicesSnapshot => ({
  now: NOW, paused: [], waitingFor: {}, idleSince: {},
  connections: { pixel: 'connected', iphone: 'missing', heavy: 'connected' },
  resources: [
    { id: 'pixel', name: 'Pixel 5', kind: 'android', serial: '25121FDD4S00H7', release: 'restore a2, log in NOTES.md' },
    { id: 'iphone', name: 'iPhone 15 Pro', kind: 'ios', serial: 'D7608D6B' },
    { id: 'heavy', name: 'Mac builds', kind: 'host', busyProcesses: ['xcodebuild'] },
  ],
  holders: [{ paneId: '%1', sessionName: 'battery', as: 'MASCOT', resourceId: 'pixel', task: 'Rive round', acquiredAt: NOW - 18 * 60_000, estimateMs: 25 * 60_000 }],
  queue: [
    { id: '11111111-1111-1111-1111-111111111111', paneId: '%2', sessionName: 'battery', as: 'LOTTIE', request: 'pixel', resourceIds: ['pixel'], task: 'Redraw', mode: 'notify', enqueuedAt: NOW - 6 * 60_000, position: 1 },
    { id: '22222222-2222-2222-2222-222222222222', paneId: '%3', sessionName: 'battery', as: 'SWEEP', request: 'pixel', resourceIds: ['pixel'], task: 'Brightness sweep', mode: 'wait', enqueuedAt: NOW - 11 * 60_000, position: 2, pid: 4242 },
  ],
  ...overrides,
})

function fakeApi(initial = snapshot()) {
  return {
    list: vi.fn(async () => initial),
    pause: vi.fn(async () => initial),
    release: vi.fn(async () => initial),
    move: vi.fn(async () => initial),
    remove: vi.fn(async () => initial),
  }
}
async function renderView(api = fakeApi(), onOpenPane = vi.fn()) {
  render(<DevicesView token="t" api={api} onOpenPane={onOpenPane} />)
  await act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve() })
  return { api, onOpenPane }
}
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('DevicesView', () => {
  it('shows each lock with its holder, queue and release steps', async () => {
    await renderView()
    const pixel = screen.getByRole('article', { name: 'Pixel 5' })
    expect(within(pixel).getByText('held')).toBeInTheDocument()
    expect(within(pixel).getByRole('region', { name: 'Held by MASCOT' })).toHaveTextContent('Rive round')
    expect(within(pixel).getAllByRole('listitem').map((item) => item.textContent)).toEqual([
      expect.stringContaining('LOTTIE'), expect.stringContaining('SWEEP'),
    ])
    expect(within(pixel).getByText('script · waiting')).toBeInTheDocument()
    expect(within(pixel).getByText('On release: restore a2, log in NOTES.md')).toBeInTheDocument()
    expect(screen.getByRole('article', { name: 'iPhone 15 Pro' })).toHaveTextContent('not connected')
    expect(screen.getByRole('article', { name: 'Mac builds' })).toHaveTextContent('Free. No one waiting.')
    expect(screen.getByText('2 waiting')).toBeInTheDocument()
  })

  it('reorders, removes, pauses and opens panes', async () => {
    const { api, onOpenPane } = await renderView()
    const pixel = screen.getByRole('article', { name: 'Pixel 5' })
    fireEvent.click(within(pixel).getByRole('button', { name: 'Move SWEEP up' }))
    expect(api.move).toHaveBeenCalledWith('22222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111')
    fireEvent.click(within(pixel).getByRole('button', { name: 'Remove LOTTIE from the queue' }))
    expect(api.remove).toHaveBeenCalledWith('11111111-1111-1111-1111-111111111111')
    fireEvent.click(within(pixel).getByRole('button', { name: /Pause queue/ }))
    expect(api.pause).toHaveBeenCalledWith('pixel', true)
    fireEvent.click(within(pixel).getByRole('button', { name: 'Open pane' }))
    expect(onOpenPane).toHaveBeenCalledWith('%1')
  })

  it('asks before releasing someone else’s lock', async () => {
    const { api } = await renderView()
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true)
    const release = within(screen.getByRole('article', { name: 'Pixel 5' })).getByRole('button', { name: 'Release' })
    fireEvent.click(release)
    expect(api.release).not.toHaveBeenCalled()
    fireEvent.click(release)
    expect(confirm).toHaveBeenLastCalledWith(expect.stringContaining('Release Pixel 5 from MASCOT?'))
    expect(api.release).toHaveBeenCalledWith('pixel')
  })

  it('drags a queued request above another', async () => {
    const { api } = await renderView()
    const [first, second] = within(screen.getByRole('article', { name: 'Pixel 5' })).getAllByRole('listitem')
    vi.spyOn(first, 'getBoundingClientRect').mockReturnValue({ top: 0, height: 40 } as DOMRect)
    fireEvent.dragStart(second, { dataTransfer: { effectAllowed: '' } })
    // jsdom has no DragEvent, so clientY must be set by hand.
    const over = createEvent.dragOver(first)
    Object.defineProperty(over, 'clientY', { value: 5 })
    fireEvent(first, over)
    fireEvent.drop(first)
    expect(api.move).toHaveBeenCalledWith('22222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111')
  })

  it('shows an offer with a skip button', async () => {
    const offered = snapshot({ holders: [], queue: [{ ...snapshot().queue[0], offer: { resourceId: 'pixel', at: NOW - 60_000 } }] })
    const { api } = await renderView(fakeApi(offered))
    const pixel = screen.getByRole('article', { name: 'Pixel 5' })
    expect(within(pixel).getByText('offered')).toBeInTheDocument()
    expect(within(pixel).getByText('must claim within 4m')).toBeInTheDocument()
    fireEvent.click(within(pixel).getByRole('button', { name: 'Skip to next' }))
    expect(api.remove).toHaveBeenCalledWith('11111111-1111-1111-1111-111111111111')
  })

  it('flags idle and long-running holders', () => {
    const holder = snapshot().holders[0]
    expect(holderFlag(holder, NOW)).toBeUndefined()
    expect(holderFlag(holder, NOW, NOW - 12 * 60_000)).toEqual({ tone: 'amber', text: 'agent idle 12m' })
    expect(holderFlag({ ...holder, acquiredAt: NOW - 80 * 60_000 }, NOW)).toEqual({ tone: 'red', text: '1h 20m held · est. 25m' })
  })

  it('explains how to add the first device', async () => {
    await renderView(fakeApi(snapshot({ resources: [], holders: [], queue: [] })))
    expect(screen.getByText(/No device locks yet/)).toBeInTheDocument()
  })
})
