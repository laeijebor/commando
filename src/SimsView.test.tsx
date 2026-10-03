// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SimWallDevice } from '../shared/protocol'
import { SimsView } from './SimsView'
import { simsCache } from './simsApi'

vi.mock('./SimLiveView', () => ({
  SimLiveView: ({ udid, token }: { udid: string; token: string }) => <div data-testid="live-view" data-udid={udid} data-token={token} />,
}))

const A = 'AAAAAAAA-1111-1111-1111-111111111111'
const B = 'BBBBBBBB-2222-2222-2222-222222222222'
const VIEW_STORAGE_KEY = 'commando.sims-view'
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
async function flush() {
  await act(async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve()
    // localStorage writes enqueue jsdom's zero-delay storage notification.
    await vi.advanceTimersByTimeAsync(0)
  })
}
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
  simsCache.listing = undefined
  simsCache.pool = undefined
  simsCache.snapshots.clear()
  window.localStorage.clear()
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
  it('shows a muted pool chip and free/total pill, preserves them on remount and hides an empty pool', async () => {
    sims = [device({ pool: true, poolProjects: ['gizmo', 'commando'] }), device({ udid: B, lease: null })]
    let pool = { size: 3, free: 1 }
    fetcher.mockImplementation(async () => new Response(JSON.stringify({ sims, pool })))
    const mounted = render(<SimsView token="" />); await flush()
    expect(screen.getByText('pool')).toHaveClass('pool')
    expect(screen.getByText('pool')).toHaveAttribute('title', 'used by: gizmo, commando')
    expect(screen.getByText('pool 1 free / 3')).toBeVisible()
    mounted.unmount()
    fetcher.mockImplementation(() => new Promise<Response>(() => {}))
    const remounted = render(<SimsView token="" />)
    expect(screen.getByText('pool 1 free / 3')).toBeVisible()
    expect(screen.getByText('pool')).toBeVisible()
    expect(screen.getByText('pool')).toHaveAttribute('title', 'used by: gizmo, commando')
    remounted.unmount()
    pool = { size: 0, free: 0 }
    fetcher.mockImplementation(async () => new Response(JSON.stringify({ sims, pool })))
    render(<SimsView token="" />); await flush()
    expect(screen.queryByText(/pool \d+ free/)).toBeNull()
  })

  it('shows legacy or unused pool chips without a project tooltip', async () => {
    sims = [device({ pool: true })]
    render(<SimsView token="" />); await flush()
    expect(screen.getByText('pool')).not.toHaveAttribute('title')
    sims = [device({ pool: true, poolProjects: [] })]
    await tick(5000)
    expect(screen.getByText('pool')).not.toHaveAttribute('title')
  })

  it('duplicates ended sims in former and No lease groups, counts each device once and includes history in filters', async () => {
    vi.setSystemTime(60 * 60 * 1000)
    sims.push(device({ udid: B, name: 'Ended phone', lease: null, endedLease: {
      sessionName: 'Review UI', task: 'Old purpose', label: 'Review UI · Old purpose', repo,
      endedAt: Date.now() - 12 * 60 * 1000, reason: 'pane-closed',
    } }))
    render(<SimsView token="" />); await flush()
    expect(screen.getByText('2 booted')).toBeVisible()
    expect(screen.getByText('2 unslimmed')).toBeVisible()
    expect(screen.getByText('1 leased · 1 ended')).toBeVisible()
    expect(within(screen.getByRole('region', { name: 'widgets' })).getAllByRole('article')).toHaveLength(2)
    expect(within(screen.getByRole('region', { name: 'No lease' })).getAllByRole('article')).toHaveLength(1)
    expect(screen.getAllByRole('article')).toHaveLength(3)
    expect(screen.getByText('lease ended')).toBeVisible()
    expect(screen.getByText('ended 12m ago')).toBeVisible()
    expect(screen.getByText('last: Review UI · Old purpose')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Session' }))
    expect(within(screen.getByRole('region', { name: 'Review UI' })).getAllByRole('article')).toHaveLength(2)
    fireEvent.click(screen.getByRole('button', { name: 'Review UI (2)' }))
    expect(screen.getAllByRole('article')).toHaveLength(3)
    fireEvent.click(screen.getByRole('button', { name: 'No lease (1)' }))
    expect(screen.getAllByRole('article')).toHaveLength(2)
    expect(screen.getByText('1 ended')).toBeVisible()
    expect(screen.getByText('last: Review UI · Old purpose')).toBeVisible()
    expect(screen.queryByText('1 leased · 1 ended')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'All' }))
    fireEvent.click(screen.getByRole('button', { name: 'None' }))
    expect(screen.getAllByRole('article')).toHaveLength(2)
    expect(screen.getByText('lease ended')).toBeVisible()
    expect(screen.getByText('last: Review UI · Old purpose')).toBeVisible()
  })

  it('omits an empty historical task, shows ended-only session counts and preserves the current active lease', async () => {
    const endedLease = { sessionName: 'Former', task: '', label: 'Former', repo, endedAt: Date.now(), reason: 'released' as const }
    sims = [device({ lease: null, endedLease }), device({ udid: B, endedLease })]
    render(<SimsView token="" />); await flush()
    expect(screen.getByRole('button', { name: 'Former (1)' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'Review UI (1)' })).toBeVisible()
    expect(screen.getByText('last: Former')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Former (1)' }))
    expect(screen.getAllByRole('article')).toHaveLength(2)
    expect(screen.getByText('1 ended')).toBeVisible()
    expect(screen.queryByText('Check spacing')).toBeNull()
  })

  it('shares one snapshot fetch and URL between ended copies and hands polling to the visible card', async () => {
    sims = [device({ lease: null, endedLease: { sessionName: 'Former', task: 'review', label: 'Former · review', repo, endedAt: Date.now(), reason: 'pane-closed' } })]
    render(<SimsView token="" />); await flush()
    await intersect(true, 0); await intersect(true, 1)
    expect(snapshotCalls()).toHaveLength(1)
    await loaded()
    expect(screen.getAllByRole('img').map((image) => image.getAttribute('src'))).toEqual(['blob:snapshot-1', 'blob:snapshot-1'])
    await tick(2000)
    expect(snapshotCalls()).toHaveLength(2)
    await loaded()
    expect(screen.getAllByRole('img').map((image) => image.getAttribute('src'))).toEqual(['blob:snapshot-2', 'blob:snapshot-2'])
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1)
    await intersect(false, 0)
    const afterHandoff = snapshotCalls().length
    expect(afterHandoff).toBe(3)
    await loaded()
    await tick(2000)
    expect(snapshotCalls()).toHaveLength(afterHandoff + 1)
    await loaded()
    await intersect(false, 1)
    const beforeOffscreen = snapshotCalls().length
    await tick(4000)
    expect(snapshotCalls()).toHaveLength(beforeOffscreen)
    await intersect(true, 1)
    expect(snapshotCalls()).toHaveLength(beforeOffscreen + 1)
    await loaded()
    const beforeHidden = snapshotCalls().length
    await changeVisibility('hidden'); await tick(4000)
    expect(snapshotCalls()).toHaveLength(beforeHidden)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('aborts the polling owner on unmount and starts one fetch when regrouping ended copies', async () => {
    sims = [device({ lease: null, endedLease: { sessionName: 'Former', task: '', label: 'Former', repo, endedAt: Date.now(), reason: 'released' } })]
    render(<StrictMode><SimsView token="" /></StrictMode>); await flush()
    const active = observers.map((observer, index) => ({ observer, index })).filter(({ observer }) => !observer.disconnect.mock.calls.length)
    await intersect(true, active[0].index); await intersect(true, active[1].index)
    expect(snapshotCalls()).toHaveLength(1)
    await loaded()
    fireEvent.click(screen.getByRole('button', { name: 'None' })); await flush()
    expect(snapshotCalls()[0][1]?.signal?.aborted).toBe(true)
    await intersect(true, observers.length - 1)
    expect(snapshotCalls()).toHaveLength(2)
    expect(screen.getByRole('img')).toHaveAttribute('src', 'blob:snapshot-1')
  })

  const filters = () => within(screen.getByRole('group', { name: 'Filter simulators by session' }))
  const grouping = () => within(screen.getByRole('group', { name: 'Group by' }))
  const sizes = () => within(screen.getByRole('group', { name: 'Size' }))
  const mixedSims = () => [
    device({ udid: B, name: 'Stray phone', slim: 'slim', lease: null }),
    device(),
    device({ udid: 'C', lease: { ...device().lease!, sessionName: 'Build UI', paneId: '%2' } }),
    device({ udid: 'D', lease: { ...device().lease!, paneId: '%3', repo: { ...repo, root: '/tools', name: 'tools' } } }),
  ]

  it('paints cached counts and snapshots immediately on remount and keeps frames through filter, group and size changes', async () => {
    sims.push(device({ udid: B, name: 'Stray phone', lease: null }))
    const first = render(<SimsView token="" />)
    await flush()
    await intersect(true, 0); await intersect(true, 1)
    await loaded(0); await loaded(1)
    first.unmount()
    expect(URL.revokeObjectURL).not.toHaveBeenCalled()
    fetcher.mockImplementation(() => new Promise(() => {}))
    render(<SimsView token="" />)
    expect(screen.getByText('2 booted')).toBeVisible()
    expect(screen.getByText('Updating…')).toBeVisible()
    expect(screen.queryByText('Loading simulators…')).toBeNull()
    expect(screen.getAllByRole('img').map((img) => img.getAttribute('src'))).toEqual(['blob:snapshot-1', 'blob:snapshot-2'])
    fireEvent.click(filters().getByRole('button', { name: 'Review UI (1)' }))
    fireEvent.click(filters().getByRole('button', { name: 'All' }))
    fireEvent.click(grouping().getByRole('button', { name: 'None' }))
    fireEvent.click(sizes().getByRole('button', { name: 'L' }))
    expect(screen.getAllByRole('img').map((img) => img.getAttribute('src'))).toEqual(['blob:snapshot-1', 'blob:snapshot-2'])
    expect(screen.queryByText('Waiting for snapshot…')).toBeNull()
    expect(snapshotCalls()).toHaveLength(2)
    expect(URL.revokeObjectURL).not.toHaveBeenCalled()
  })

  it('paints the saved listing after page reload before a delayed fetch completes, then replaces it', async () => {
    const first = render(<SimsView token="" />)
    await flush()
    first.unmount()
    simsCache.listing = undefined // A reload loses module state but preserves localStorage.
    let finish!: (response: Response) => void
    fetcher.mockImplementation(() => new Promise((resolve) => { finish = resolve }))
    render(<SimsView token="" />)
    expect(screen.getByText('1 booted')).toBeVisible()
    expect(screen.getByRole('article', { name: 'Review UI' })).toBeVisible()
    expect(screen.getByText('Updating…')).toBeVisible()
    expect(screen.queryByText('Loading simulators…')).toBeNull()
    finish(new Response(JSON.stringify({ sims: [] })))
    await flush()
    expect(screen.getByText('No booted iOS simulators.')).toBeVisible()
    expect(screen.queryByText('Updating…')).toBeNull()
  })

  it('shows capture age after 15 seconds and removes the chip only when a newer image has loaded', async () => {
    vi.setSystemTime(120_000)
    const normal = fetcher.getMockImplementation()!
    let captureAt = 0
    fetcher.mockImplementation(async (url, options) => String(url).endsWith('/snapshot.jpg')
      ? new Response('jpeg', { headers: { 'X-Commando-Snapshot-At': String(captureAt) } }) : normal(url, options))
    render(<SimsView token="" />)
    await flush(); await intersect(); await loaded()
    expect(screen.getByText('2m ago')).toBeVisible()
    await tick(2000)
    expect(preloads).toHaveLength(1) // Receiving the same cached frame needs no new URL or decode.
    captureAt = Date.now()
    await tick(2000)
    expect(screen.getByText('2m ago')).toBeVisible()
    await loaded()
    expect(screen.queryByText('2m ago')).toBeNull()
    await intersect(false)
    await tick(13_000)
    expect(screen.queryByText('15s ago')).toBeNull()
    await tick(1000)
    expect(screen.getByText('16s ago')).toBeVisible()
    await changeVisibility('hidden')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('revokes URLs for removed devices, including frames belonging to filtered-out cards', async () => {
    sims.push(device({ udid: B, name: 'Stray phone', lease: null }))
    render(<SimsView token="" />)
    await flush(); await intersect(true, 0); await intersect(true, 1)
    await loaded(0); await loaded(1)
    fireEvent.click(filters().getByRole('button', { name: 'Review UI (1)' }))
    sims = sims.filter((sim) => sim.udid !== B)
    await tick(5000)
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:snapshot-2')
    expect(simsCache.snapshots.has(B)).toBe(false)
    expect(simsCache.snapshots.has(A)).toBe(true)
    sims = []
    await tick(5000)
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:snapshot-1')
    expect(simsCache.snapshots.size).toBe(0)
  })

  it.each(['{broken', '[null]', '[{"udid":"bad"}]', '{}'])('ignores a malformed saved listing: %s', async (stored) => {
    window.localStorage.setItem('commando.sims-listing', stored)
    render(<SimsView token="" />)
    expect(screen.getByText('Loading simulators…')).toBeVisible()
    await flush()
    expect(screen.getByText('1 booted')).toBeVisible()
  })

  it('derives one filter pill per leased session across panes and repositories, with counts and All selected', async () => {
    sims = mixedSims()
    render(<SimsView token="" />)
    await flush()
    const pills = filters().getAllByRole('button')
    expect(pills.map((pill) => pill.textContent)).toEqual(['All', 'Build UI (1)', 'Review UI (2)', 'No lease (1)'])
    expect(pills.map((pill) => pill.getAttribute('aria-pressed'))).toEqual(['true', 'false', 'false', 'false'])
    for (const pill of pills) {
      expect(pill).toHaveAttribute('type', 'button')
      expect(pill.tabIndex).toBe(0)
    }
    pills[1].focus()
    expect(pills[1]).toHaveFocus()
  })

  it('filters to a session or No lease while header counts and available pills describe all sims', async () => {
    sims = mixedSims()
    render(<SimsView token="" />)
    await flush()
    fireEvent.click(filters().getByRole('button', { name: 'Review UI (2)' }))
    expect(screen.getAllByRole('article').map((card) => card.getAttribute('aria-label'))).toEqual(['Review UI', 'Review UI'])
    expect(filters().getByRole('button', { name: 'Review UI (2)' })).toHaveAttribute('aria-pressed', 'true')
    expect(filters().getByRole('button', { name: 'All' })).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByText('4 booted')).toBeVisible()
    expect(screen.getByText('3 unslimmed')).toBeVisible()
    expect(filters().getAllByRole('button')).toHaveLength(4)
    fireEvent.click(grouping().getByRole('button', { name: 'Session' }))
    expect(screen.getAllByRole('heading', { level: 3 }).map((node) => node.textContent)).toEqual(['Review UI'])
    fireEvent.click(grouping().getByRole('button', { name: 'None' }))
    expect(screen.getAllByRole('article')).toHaveLength(2)
    fireEvent.click(filters().getByRole('button', { name: 'No lease (1)' }))
    expect(screen.getAllByRole('article').map((card) => card.getAttribute('aria-label'))).toEqual(['Stray phone'])
    expect(filters().getByRole('button', { name: 'Review UI (2)' })).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(filters().getByRole('button', { name: 'All' }))
    expect(screen.getAllByRole('article')).toHaveLength(4)
  })

  it.each(['session', 'no-lease'])('falls back to All when the selected %s disappears and stays on All if it returns', async (selection) => {
    sims = mixedSims()
    const original = sims
    render(<SimsView token="" />)
    await flush()
    fireEvent.click(filters().getByRole('button', { name: selection === 'session' ? 'Review UI (2)' : 'No lease (1)' }))
    sims = original.filter((sim) => selection === 'session' ? sim.lease?.sessionName !== 'Review UI' : sim.lease)
    await tick(5000)
    expect(filters().getByRole('button', { name: 'All' })).toHaveAttribute('aria-pressed', 'true')
    expect(filters().queryByRole('button', { name: selection === 'session' ? 'Review UI (2)' : 'No lease (1)' })).toBeNull()
    expect(screen.getAllByRole('article')).toHaveLength(sims.length)
    sims = original
    await tick(5000)
    expect(filters().getByRole('button', { name: 'All' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getAllByRole('article')).toHaveLength(4)
  })

  it('switches between repository groups, session groups, and a flat grid with leased sims first', async () => {
    sims = mixedSims()
    render(<SimsView token="" />)
    await flush()
    const headings = () => screen.queryAllByRole('heading', { level: 3 }).map((node) => node.textContent)
    expect(grouping().getByRole('button', { name: 'Repo' })).toHaveAttribute('aria-pressed', 'true')
    expect(headings()).toEqual(['tools', 'widgets', 'No lease'])
    fireEvent.click(grouping().getByRole('button', { name: 'Session' }))
    expect(headings()).toEqual(['Build UI', 'Review UI', 'No lease'])
    expect(within(screen.getByRole('region', { name: 'Review UI' })).getAllByRole('article')).toHaveLength(2)
    expect(grouping().getByRole('button', { name: 'Repo' })).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(grouping().getByRole('button', { name: 'None' }))
    expect(grouping().getByRole('button', { name: 'None' })).toHaveAttribute('aria-pressed', 'true')
    expect(headings()).toEqual([])
    const wall = screen.getByRole('region', { name: 'Simulators' })
    expect(wall.querySelectorAll('.sims-grid')).toHaveLength(1)
    expect(screen.getAllByRole('article').map((card) => card.getAttribute('aria-label'))).toEqual(['Review UI', 'Build UI', 'Review UI', 'Stray phone'])
    fireEvent.click(grouping().getByRole('button', { name: 'Repo' }))
    expect(headings()).toEqual(['tools', 'widgets', 'No lease'])
  })

  it('defaults to M and applies the selected size class for S, L and M', async () => {
    render(<SimsView token="" />)
    await flush()
    const wall = screen.getByRole('region', { name: 'Simulators' })
    expect(wall).toHaveClass('sims-size-m')
    for (const size of ['S', 'L', 'M']) {
      fireEvent.click(sizes().getByRole('button', { name: size }))
      expect(wall).toHaveClass(`sims-size-${size.toLowerCase()}`)
      expect(sizes().getAllByRole('button').filter((button) => button.getAttribute('aria-pressed') === 'true')).toEqual([sizes().getByRole('button', { name: size })])
    }
  })

  it('persists grouping and size together and restores them on remount, without persisting the filter', async () => {
    sims = mixedSims()
    const { unmount } = render(<SimsView token="" />)
    await flush()
    fireEvent.click(grouping().getByRole('button', { name: 'Session' }))
    fireEvent.click(sizes().getByRole('button', { name: 'L' }))
    fireEvent.click(filters().getByRole('button', { name: 'Review UI (2)' }))
    expect(JSON.parse(window.localStorage.getItem(VIEW_STORAGE_KEY)!)).toEqual({ groupBy: 'session', size: 'l' })
    expect(window.localStorage.length).toBe(2)
    unmount()
    render(<SimsView token="" />)
    await flush()
    expect(grouping().getByRole('button', { name: 'Session' })).toHaveAttribute('aria-pressed', 'true')
    expect(sizes().getByRole('button', { name: 'L' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('region', { name: 'Simulators' })).toHaveClass('sims-size-l')
    expect(filters().getByRole('button', { name: 'All' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getAllByRole('article')).toHaveLength(4)
  })

  it.each([
    ['{broken', 'Repo', 'M'],
    ['null', 'Repo', 'M'],
    ['[]', 'Repo', 'M'],
    ['"session"', 'Repo', 'M'],
    ['{}', 'Repo', 'M'],
    ['{"groupBy":"invalid","size":240}', 'Repo', 'M'],
    ['{"groupBy":"none"}', 'None', 'M'],
    ['{"groupBy":null,"size":"s"}', 'Repo', 'S'],
  ])('uses sensible defaults for stored preferences %s', async (stored, groupBy, size) => {
    window.localStorage.setItem(VIEW_STORAGE_KEY, stored)
    render(<SimsView token="" />)
    await flush()
    expect(grouping().getByRole('button', { name: groupBy })).toHaveAttribute('aria-pressed', 'true')
    expect(sizes().getByRole('button', { name: size })).toHaveAttribute('aria-pressed', 'true')
  })

  it('continues to work when storage reads and writes throw', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('Storage blocked') })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Storage blocked') })
    render(<SimsView token="" />)
    await flush()
    expect(grouping().getByRole('button', { name: 'Repo' })).toHaveAttribute('aria-pressed', 'true')
    expect(sizes().getByRole('button', { name: 'M' })).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(grouping().getByRole('button', { name: 'None' }))
    fireEvent.click(sizes().getByRole('button', { name: 'L' }))
    expect(grouping().getByRole('button', { name: 'None' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('region', { name: 'Simulators' })).toHaveClass('sims-size-l')
  })

  it('unmounts filtered-out cards, aborts their snapshots and stops polling until they render and intersect again', async () => {
    sims.push(device({ udid: B, name: 'Stray phone', lease: null }))
    render(<SimsView token="" />)
    await flush()
    await intersect(true, 0)
    await intersect(true, 1)
    await loaded(0) // Leave the stray's image decode pending.
    const straySignal = snapshotCalls()[1][1]!.signal!
    fireEvent.click(filters().getByRole('button', { name: 'Review UI (1)' }))
    await flush()
    expect(screen.queryByRole('article', { name: 'Stray phone' })).toBeNull()
    expect(observers[1].disconnect).toHaveBeenCalled()
    expect(straySignal.aborted).toBe(true)
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:snapshot-2')
    const before = snapshotCalls().length
    await tick(6000)
    expect(snapshotCalls().slice(before).map(([url]) => url)).toEqual([`/api/sims/${A}/snapshot.jpg`])
    fireEvent.click(filters().getByRole('button', { name: 'No lease (1)' }))
    await flush()
    expect(observers[0].disconnect).toHaveBeenCalled()
    expect(snapshotCalls().at(-1)![1]!.signal!.aborted).toBe(true)
    const filteredCount = snapshotCalls().length
    await tick(4000)
    expect(snapshotCalls()).toHaveLength(filteredCount)
    await intersect(true, 2)
    expect(snapshotCalls().at(-1)![0]).toBe(`/api/sims/${B}/snapshot.jpg`)
  })

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
    expect(URL.revokeObjectURL).not.toHaveBeenCalledWith('blob:snapshot-2')
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

it('loads the listing and first snapshot without waiting for a poll when effects re-run', async () => {
  // StrictMode mounts, cancels, and remounts effects: the cancelled fetch must not block the next one.
  render(<StrictMode><SimsView token="token" /></StrictMode>)
  await flush()
  expect(screen.queryByText('Loading simulators…')).not.toBeInTheDocument()
  expect(screen.getByText('Review UI')).toBeInTheDocument()
  await intersect(true, observers.length - 1)
  expect(snapshotCalls().length).toBeGreaterThan(0)
})

it('asks again within a second when the daemon answered from cache, instead of waiting a full poll', async () => {
  let stale = true
  fetcher.mockImplementation(async (url) => url === '/api/sims'
    ? new Response(JSON.stringify({ sims, stale }), { headers: { 'Content-Type': 'application/json' } })
    : new Response('jpeg'))
  render(<SimsView token="token" />)
  await flush()
  expect(listingCalls()).toHaveLength(1)
  expect(screen.getByText('Updating…')).toBeInTheDocument()
  stale = false
  await tick(1_000)
  expect(listingCalls()).toHaveLength(2)
  expect(screen.queryByText('Updating…')).not.toBeInTheDocument()
})
