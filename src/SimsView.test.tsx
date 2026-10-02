// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SimWallDevice } from '../shared/protocol'
import { SimsView } from './SimsView'

vi.mock('./SimLiveView', () => ({
  SimLiveView: ({ udid, token }: { udid: string; token: string }) => <div data-testid="live-view" data-udid={udid} data-token={token} />,
}))

const A = 'AAAAAAAA-1111-1111-1111-111111111111'
const B = 'BBBBBBBB-2222-2222-2222-222222222222'
const repo = { root: '/repo', name: 'widgets', branch: 'feature', isWorktree: true }
const device = (overrides: Partial<SimWallDevice> = {}): SimWallDevice => ({
  udid: A, name: 'Device name', runtime: 'iOS 26.5', deviceModel: 'iPhone 17 Pro', slim: 'unslimmed',
  lease: { sessionName: 'Review UI', task: 'Check spacing', label: 'Review UI · Check spacing', repo, paneId: '%1', idle: true }, ...overrides,
})
let sims: SimWallDevice[]
let visibility: DocumentVisibilityState
let fetcher: ReturnType<typeof vi.fn<typeof fetch>>
let preloads: HTMLImageElement[]
let observers: Array<{ callback: IntersectionObserverCallback; node?: Element; disconnect: ReturnType<typeof vi.fn> }>
async function flush() { await act(async () => { for (let i = 0; i < 20; i++) await Promise.resolve() }) }
async function tick(ms: number) { await act(async () => { await vi.advanceTimersByTimeAsync(ms) }); await flush() }
async function intersect(value = true, index = 0) {
  act(() => {
    const observer = observers[index]
    observer.callback([{ isIntersecting: value, target: observer.node } as IntersectionObserverEntry], {} as IntersectionObserver)
  })
  await flush()
}
async function changeVisibility(value: DocumentVisibilityState) {
  visibility = value
  fireEvent(document, new Event('visibilitychange'))
  await flush()
}
async function loaded(index = preloads.length - 1) {
  act(() => fireEvent.load(preloads[index]))
  await flush()
}
const snapshotCalls = () => fetcher.mock.calls.filter(([url]) => String(url).endsWith('/snapshot.jpg'))
const listingCalls = () => fetcher.mock.calls.filter(([url]) => url === '/api/sims')

beforeEach(() => {
  vi.useFakeTimers()
  sims = [device()]
  visibility = 'visible'
  preloads = []
  observers = []
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility)
  vi.stubGlobal('IntersectionObserver', vi.fn(function (callback: IntersectionObserverCallback) {
    const observer = { callback, node: undefined as Element | undefined, disconnect: vi.fn() }
    observers.push(observer)
    return { observe: (node: Element) => { observer.node = node }, disconnect: observer.disconnect }
  }))
  vi.stubGlobal('Image', vi.fn(function () {
    const image = document.createElement('img')
    preloads.push(image)
    return image
  }))
  let urlNumber = 0
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => `blob:snapshot-${++urlNumber}`) })
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() })
  fetcher = vi.fn<typeof fetch>(async (url) => url === '/api/sims'
    ? new Response(JSON.stringify({ sims }), { headers: { 'Content-Type': 'application/json' } })
    : new Response('jpeg'))
  vi.stubGlobal('fetch', fetcher)
})
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('SimsView', () => {
  it('renders counts, repo groups then No lease, lease labels, task and state/model chips', async () => {
    sims.push(device({ udid: B, name: 'Stray phone', slim: 'slim', lease: null }))
    render(<SimsView token="browser-token" />)
    await flush()
    expect(screen.getByText('2 booted')).toBeVisible()
    expect(screen.getByText('1 unslimmed')).toBeVisible()
    expect(screen.getAllByRole('heading', { level: 3 }).map((node) => node.textContent)).toEqual(['widgets', 'No lease'])
    const leased = screen.getByRole('article', { name: 'Review UI' })
    expect(within(leased).getByText('Check spacing')).toBeVisible()
    expect(within(leased).getByText('idle')).toHaveClass('idle')
    expect(within(leased).getByText('unslimmed')).toHaveClass('unslimmed')
    expect(within(leased).getByText('iPhone 17 Pro')).toBeVisible()
    const stray = screen.getByRole('article', { name: 'Stray phone' })
    expect(within(stray).queryByText('idle')).toBeNull()
    expect(within(stray).queryByRole('button', { name: 'Slim' })).toBeNull()
    expect(snapshotCalls()).toHaveLength(0)
    expect(fetcher).toHaveBeenCalledWith('/api/sims', expect.objectContaining({ credentials: 'same-origin', headers: { Authorization: 'Bearer browser-token' } }))
  })

  it('groups worktrees by repository root and keeps leases without repo metadata', async () => {
    sims.push(device({ udid: B, lease: { ...sims[0].lease!, paneId: '%2', repo: { ...repo, worktreeRoot: '/other' } } }))
    sims.push(device({ udid: 'C', slim: 'unknown', lease: { ...sims[0].lease!, repo: undefined } }))
    render(<SimsView token="" />)
    await flush()
    expect(screen.getAllByRole('heading', { level: 3 }).map((node) => node.textContent)).toEqual(['Unknown repository', 'widgets'])
    expect(screen.getByText('2 leased')).toBeVisible()
    expect(screen.getByText('slim unknown')).toBeVisible()
    expect(fetcher.mock.calls[0][1]?.headers).toEqual({})
  })

  it('shows an empty state, polls listings every five seconds, and cleans up on unmount', async () => {
    sims = []
    const { unmount } = render(<SimsView token="" />)
    await flush()
    expect(screen.getByText('No booted iOS simulators.')).toBeVisible()
    await tick(4999)
    expect(listingCalls()).toHaveLength(1)
    await tick(1)
    expect(listingCalls()).toHaveLength(2)
    unmount()
    expect(vi.getTimerCount()).toBe(0)
    await tick(10000)
    expect(listingCalls()).toHaveLength(2)
  })

  it('only refreshes intersecting snapshots every two seconds and preserves the old image until load', async () => {
    const { unmount } = render(<SimsView token="token" />)
    await flush()
    await intersect()
    expect(snapshotCalls()).toHaveLength(1)
    expect(screen.queryByRole('img')).toBeNull()
    await loaded()
    expect(screen.getByRole('img')).toHaveAttribute('src', 'blob:snapshot-1')
    await tick(2000)
    expect(snapshotCalls()).toHaveLength(2)
    expect(screen.getByRole('img')).toHaveAttribute('src', 'blob:snapshot-1')
    // Slow image loading counts as an in-flight refresh too.
    await tick(4000)
    expect(snapshotCalls()).toHaveLength(2)
    await loaded()
    expect(screen.getByRole('img')).toHaveAttribute('src', 'blob:snapshot-2')
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:snapshot-1')
    await intersect(false)
    await tick(6000)
    expect(snapshotCalls()).toHaveLength(2)
    unmount()
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:snapshot-2')
    expect(observers[0].disconnect).toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('stops all timers and aborts pending work when hidden, then resumes on visibility', async () => {
    render(<SimsView token="" />)
    await flush()
    await intersect()
    const signal = snapshotCalls()[0][1]!.signal!
    await changeVisibility('hidden')
    expect(signal.aborted).toBe(true)
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:snapshot-1')
    expect(vi.getTimerCount()).toBe(0)
    const count = fetcher.mock.calls.length
    await tick(10000)
    expect(fetcher).toHaveBeenCalledTimes(count)
    await changeVisibility('visible')
    expect(listingCalls()).toHaveLength(2)
    expect(snapshotCalls()).toHaveLength(2)
    await loaded()
    await tick(2000)
    expect(snapshotCalls()).toHaveLength(3)
  })

  it('does no work when initially hidden', async () => {
    visibility = 'hidden'
    render(<SimsView token="" />)
    await tick(10000)
    expect(fetcher).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    await changeVisibility('visible')
    expect(listingCalls()).toHaveLength(1)
  })

  it('never overlaps a pending listing or snapshot fetch and aborts both on unmount', async () => {
    let finishSnapshot!: (response: Response) => void
    let finishListing!: (response: Response) => void
    const normal = fetcher.getMockImplementation()!
    fetcher.mockImplementation((url, options) => String(url).endsWith('/snapshot.jpg')
      ? new Promise((resolve) => { finishSnapshot = resolve }) : normal(url, options))
    const { unmount } = render(<SimsView token="" />)
    await flush()
    await intersect()
    fetcher.mockImplementation((url) => url === '/api/sims'
      ? new Promise((resolve) => { finishListing = resolve }) : new Promise((resolve) => { finishSnapshot = resolve }))
    await tick(15000)
    expect(snapshotCalls()).toHaveLength(1)
    expect(listingCalls()).toHaveLength(2)
    const snapshotSignal = snapshotCalls()[0][1]!.signal!
    const listingSignal = listingCalls()[1][1]!.signal!
    unmount()
    expect(snapshotSignal.aborted).toBe(true)
    expect(listingSignal.aborted).toBe(true)
    finishSnapshot(new Response('jpeg'))
    finishListing(new Response(JSON.stringify({ sims })))
    await flush()
    expect(URL.createObjectURL).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('confirms slimming, displays progress, refreshes afterward, and opens via POST', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    let finish!: (response: Response) => void
    const normal = fetcher.getMockImplementation()!
    fetcher.mockImplementation((url, options) => String(url).endsWith('/slim')
      ? new Promise((resolve) => { finish = resolve }) : normal(url, options))
    render(<SimsView token="owner" />)
    await flush()
    fireEvent.click(screen.getByRole('button', { name: 'Slim' }))
    expect(confirm).toHaveBeenCalledWith('Slimming reboots this simulator')
    expect(fetcher.mock.calls.some(([url]) => String(url).endsWith('/slim'))).toBe(false)
    confirm.mockReturnValue(true)
    fireEvent.click(screen.getByRole('button', { name: 'Slim' }))
    expect(screen.getByRole('button', { name: 'Slimming…' })).toBeDisabled()
    expect(fetcher).toHaveBeenCalledWith(`/api/sims/${A}/slim`, expect.objectContaining({ method: 'POST', headers: { Authorization: 'Bearer owner' } }))
    finish(new Response('{}'))
    await flush()
    expect(screen.getByRole('button', { name: 'Slim' })).toBeEnabled()
    expect(listingCalls()).toHaveLength(2)
    fireEvent.click(screen.getByRole('button', { name: 'Open in Simulator' }))
    await flush()
    expect(fetcher).toHaveBeenCalledWith(`/api/sims/${A}/open`, expect.objectContaining({ method: 'POST' }))
  })

  it('keeps the previous image on refresh failures and surfaces action and listing errors', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    render(<SimsView token="" />)
    await flush()
    await intersect()
    await loaded()
    fetcher.mockImplementation(async () => new Response(JSON.stringify({ error: 'Tool unavailable' }), { status: 500 }))
    await tick(2000)
    expect(screen.getByRole('img')).toHaveAttribute('src', 'blob:snapshot-1')
    expect(screen.getByRole('status')).toHaveTextContent('Tool unavailable')
    fireEvent.click(screen.getByRole('button', { name: 'Slim' }))
    await flush()
    expect(screen.getByRole('alert')).toHaveTextContent('Tool unavailable')
    await tick(3000)
    expect(screen.getAllByRole('alert')).toHaveLength(2)
  })
})


it('opens one focused wall overlay, pauses only its card, switches sims, and closes with Escape or the close button', async () => {
  sims.push(device({ udid: B, name: 'Stray phone', lease: null }))
  render(<SimsView token="owner" />); await flush(); await intersect(true, 0); await intersect(true, 1)
  await loaded(0); await loaded(1)
  const trigger = screen.getByRole('button', { name: 'View Review UI live' })
  trigger.focus(); fireEvent.click(trigger); await flush()
  expect(screen.getAllByRole('dialog')).toHaveLength(1)
  expect(screen.getByTestId('live-view')).toHaveAttribute('data-udid', A)
  expect(screen.getByTestId('live-view')).toHaveAttribute('data-token', 'owner')
  const before = snapshotCalls().length; await tick(2000)
  expect(snapshotCalls().slice(before).map(([url]) => url)).toEqual([`/api/sims/${B}/snapshot.jpg`])
  fireEvent.click(screen.getByRole('button', { name: 'View Stray phone live' })); await flush()
  expect(screen.getAllByRole('dialog')).toHaveLength(1)
  expect(screen.getByTestId('live-view')).toHaveAttribute('data-udid', B)
  fireEvent.keyDown(document, { key: 'Escape' }); await flush()
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(screen.getByRole('button', { name: 'View Stray phone live' })).toHaveFocus()
  fireEvent.click(trigger); await flush(); fireEvent.click(screen.getByRole('button', { name: 'Close live view' })); await flush()
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(trigger).toHaveFocus()
})
