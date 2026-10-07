// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createPrsApi, type PanePrList, type PrList, type PrsApiClient, type PrScope, type PrSummary } from './prsApi'
import { markPrMerged, refreshPrCommentStatus, usePanePrs, useRepoPrs } from './prStore'
import { SessionPrCount } from './SessionPrCount'

const emptyList: PanePrList = {
  targetId: 'target', totalCount: 0, pullRequests: [], truncated: false, fetchedAt: 1,
}

function Subscriber({ api, background = false }: {
  api: { pane: (paneId: string) => Promise<PanePrList> }
  background?: boolean
}) {
  usePanePrs('%12', api, { background })
  return null
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('PR store', () => {
  const pr: PrSummary = { number: 12, title: 'Widgets', url: 'https://github.com/acme/widgets/pull/12', state: 'open', isDraft: false,
    author: 'leo', bodyExcerpt: '', additions: 10, deletions: 2, changedFiles: 1, commitCount: 1,
    unresolvedThreads: 0, unansweredThreads: 0, threadsTruncated: false, reviewDecision: null, reviews: [], requestedReviewers: [],
    conflicting: false, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', checks: null, createdAt: '', updatedAt: '',
    headRefName: 'feature', baseRefName: 'main', headRefOid: '', baseRefOid: '',
    viewerIsAuthor: true, viewerReviewRequested: false, commandoMarker: null }
  function repoList(summary = pr, fetchedAt = 1): PrList {
    return { repo: 'acme/widgets', filter: 'open', viewer: 'leo', totalCount: 1, pullRequests: [summary], truncated: false, mineTruncated: false, fetchedAt }
  }
  function paneList(summary = pr, fetchedAt = 1): PanePrList {
    return { ...emptyList, fetchedAt, totalCount: 1, pullRequests: [{ ...summary, repo: 'acme/widgets', preview: summary }] }
  }
  function StatusViews({ api, paneApi = api }: { api: PrsApiClient; paneApi?: PrsApiClient }) {
    const hud = useRepoPrs('acme/widgets', 'open', api)
    const sidebar = usePanePrs('%12', paneApi, { background: true })
    return <>
      <output data-testid="hud">{hud.list?.pullRequests[0]?.conflicting ? 'conflict' : 'clear'}</output>
      <output data-testid="sidebar">{sidebar?.pullRequests[0]?.conflicting ? 'conflict' : 'clear'}</output>
      <button onClick={() => { void hud.refresh() }}>Refresh HUD</button>
      <SessionPrCount paneIds={['%12']} api={paneApi} enabled sessionName="work" />
    </>
  }

  it('updates sidebar, session readiness, and HUD through a shared authenticated store across API instances', async () => {
    let conflicting = false
    let at = 1
    const fetcher = vi.fn(async (input: RequestInfo | URL) => new Response(JSON.stringify({ list: String(input).includes('/pane?')
      ? paneList() : repoList({ ...pr, conflicting, mergeable: conflicting ? 'CONFLICTING' : 'MERGEABLE' }, ++at) })))
    const api = createPrsApi('token', fetcher)
    const paneApi = createPrsApi('token', fetcher)
    render(<StatusViews api={api} paneApi={paneApi} />)
    await act(async () => { await Promise.resolve() })
    expect(fetcher).toHaveBeenCalledTimes(2)
    conflicting = true
    fireEvent.click(screen.getByText('Refresh HUD'))
    await act(async () => { await Promise.resolve() })
    expect(screen.getByTestId('hud').textContent).toBe('conflict')
    expect(screen.getByTestId('sidebar').textContent).toBe('conflict')
    expect(screen.getByRole('img', { name: 'PR #12 in work: Merge conflicts' })).toBeTruthy()
    expect(fetcher).toHaveBeenCalledTimes(3)
    await act(async () => { markPrMerged(api, 'ACME/Widgets', 12) })
    expect(screen.queryByRole('img')).toBeNull()
  })

  it('isolates stores with different auth tokens or transports', () => {
    const fetcher = vi.fn()
    expect(createPrsApi('a', fetcher).storeKey).toBe(createPrsApi('a', fetcher).storeKey)
    expect(createPrsApi('a', fetcher).storeKey).not.toBe(createPrsApi('b', fetcher).storeKey)
    expect(createPrsApi('a', fetcher).storeKey).not.toBe(createPrsApi('a', vi.fn()).storeKey)
  })

  it('keeps a late old pane read from overwriting a newer HUD response', async () => {
    let finish!: (value: PanePrList) => void
    const api = { pane: vi.fn(() => new Promise<PanePrList>((resolve) => { finish = resolve })),
      list: vi.fn().mockResolvedValue(repoList({ ...pr, conflicting: true }, 20)) } as unknown as PrsApiClient
    render(<StatusViews api={api} />)
    await act(async () => { await Promise.resolve() })
    await act(async () => { finish(paneList(pr, 10)) })
    expect(screen.getByTestId('sidebar').textContent).toBe('conflict')
    expect(screen.getByTestId('hud').textContent).toBe('conflict')
  })

  it('deduplicates requests from subscribers to the same pane key', async () => {
    let resolveRequest: ((list: PanePrList) => void) | undefined
    const api = { pane: vi.fn(() => new Promise<PanePrList>((resolve) => { resolveRequest = resolve })) }
    render(<><Subscriber api={api} /><Subscriber api={api} /></>)

    expect(api.pane).toHaveBeenCalledTimes(1)
    await act(async () => { resolveRequest?.(emptyList) })
  })

  it('refreshes background-only pane keys every five minutes, not every 30 seconds', async () => {
    vi.useFakeTimers()
    const api = { pane: vi.fn().mockResolvedValue(emptyList) }
    render(<Subscriber api={api} background />)
    await act(async () => { await Promise.resolve() })
    expect(api.pane).toHaveBeenCalledTimes(1)

    await act(async () => { await vi.advanceTimersByTimeAsync(4 * 60_000 + 30_000) })
    expect(api.pane).toHaveBeenCalledTimes(1)
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
    expect(api.pane).toHaveBeenCalledTimes(2)
  })

  it('pauses refresh while hidden and resumes when visibility returns', async () => {
    vi.useFakeTimers()
    let visibility: DocumentVisibilityState = 'visible'
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility)
    const api = { pane: vi.fn().mockResolvedValue(emptyList) }
    render(<Subscriber api={api} />)
    await act(async () => { await Promise.resolve() })
    expect(api.pane).toHaveBeenCalledTimes(1)

    visibility = 'hidden'
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
    expect(api.pane).toHaveBeenCalledTimes(1)
    visibility = 'visible'
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); await Promise.resolve() })
    expect(api.pane).toHaveBeenCalledTimes(2)
  })
})

describe('PR store backpressure', () => {
  function RepoSubscriber({ api, scope }: { api: { list: PrsApiClient['list'] }; scope: PrScope }) {
    useRepoPrs('acme/widgets', 'open', api, { scope })
    return null
  }
  const emptyRepoList: PrList = {
    repo: 'acme/widgets', filter: 'open', viewer: 'leo', totalCount: 0, pullRequests: [], truncated: false, mineTruncated: false, fetchedAt: 1,
  }

  it('refreshes repository and linked pane pills after a comment write, including in-flight old reads', async () => {
    const linked: PanePrList = { ...emptyList, pullRequests: [{ repo: 'acme/widgets', number: 12 }] as PanePrList['pullRequests'] }
    const api = { list: vi.fn().mockResolvedValue(emptyRepoList), pane: vi.fn().mockResolvedValue(linked) }
    render(<><RepoSubscriber api={api} scope="mine" /><RepoSubscriber api={api} scope="everyone" /><Subscriber api={api} background /></>)
    await act(async () => { await Promise.resolve() })
    expect(api.list).toHaveBeenCalledTimes(2)
    expect(api.pane).toHaveBeenCalledTimes(1)
    await act(async () => { await refreshPrCommentStatus(api, 'ACME/Widgets') })
    expect(api.list).toHaveBeenCalledTimes(4)
    expect(api.pane).toHaveBeenCalledTimes(2)
    expect(api.pane).toHaveBeenLastCalledWith('%12', { refresh: true })

    let finish!: (value: PrList) => void
    api.list.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    let before!: Promise<void>
    await act(async () => { before = refreshPrCommentStatus(api, 'acme/widgets'); await Promise.resolve() })
    let after!: Promise<void>
    await act(async () => { after = refreshPrCommentStatus(api, 'acme/widgets'); await Promise.resolve() })
    await act(async () => { finish(emptyRepoList); await Promise.all([before, after]) })
    expect(api.list).toHaveBeenCalledTimes(8)
  })

  it('surfaces a failed status refresh so a successful reply is not silently left with stale pills', async () => {
    const api = { list: vi.fn().mockResolvedValue(emptyRepoList), pane: vi.fn() }
    render(<RepoSubscriber api={api} scope="mine" />)
    await act(async () => { await Promise.resolve() })
    api.list.mockRejectedValueOnce(new Error('Status refresh offline'))
    await act(async () => { await expect(refreshPrCommentStatus(api, 'acme/widgets')).rejects.toThrow('Status refresh offline') })
  })

  it("refreshes Everyone's every ten minutes", async () => {
    vi.useFakeTimers()
    const api = { list: vi.fn().mockResolvedValue(emptyRepoList) }
    render(<RepoSubscriber api={api} scope="everyone" />)
    await act(async () => { await Promise.resolve() })
    expect(api.list).toHaveBeenCalledTimes(1)

    await act(async () => { await vi.advanceTimersByTimeAsync(9 * 60_000 + 30_000) })
    expect(api.list).toHaveBeenCalledTimes(1)
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
    expect(api.list).toHaveBeenCalledTimes(2)
  })

  it('waits for retryAt after a rate-limited response', async () => {
    vi.useFakeTimers()
    const limited = Object.assign(new Error('GitHub rate limit is low'), { code: 'rate_limited', retryAt: Date.now() + 3 * 60_000 })
    const api = { pane: vi.fn().mockRejectedValueOnce(limited).mockResolvedValue(emptyList) }
    render(<Subscriber api={api} />)
    await act(async () => { await Promise.resolve() })
    expect(api.pane).toHaveBeenCalledTimes(1)

    await act(async () => { await vi.advanceTimersByTimeAsync(2 * 60_000 + 30_000) })
    expect(api.pane).toHaveBeenCalledTimes(1)
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
    expect(api.pane).toHaveBeenCalledTimes(2)
  })
})
