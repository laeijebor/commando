// @vitest-environment jsdom

import { act, cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { PanePrList, PrList, PrsApiClient, PrScope } from './prsApi'
import { refreshPrCommentStatus, usePanePrs, useRepoPrs } from './prStore'

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
