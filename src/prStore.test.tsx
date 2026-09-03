// @vitest-environment jsdom

import { act, cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { PanePrList } from './prsApi'
import { usePanePrs } from './prStore'

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
