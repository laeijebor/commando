// @vitest-environment jsdom
import { renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { PanePrSummary, PrsApiClient } from '../prsApi'
import { useRichLinkServices } from './useRichLinkServices'

const linked = { repo: 'Acme/Widgets', number: 12, title: 'fix: loop', url: 'https://github.com/acme/widgets/pull/12', state: 'open', isDraft: true, createdAt: '', updatedAt: '' } as unknown as PanePrSummary

describe('rich link services for a chat', () => {
  it('reuses the pane PR list for summaries and Quick Look, fetching only unknown PRs', async () => {
    const pane = vi.fn().mockResolvedValue({ targetId: 't', totalCount: 1, truncated: false, fetchedAt: Date.now(), pullRequests: [linked] })
    const summary = vi.fn().mockResolvedValue({ title: 'other', state: 'open' })
    const prsApi = { pane, summary, list: vi.fn() } as unknown as PrsApiClient
    const onOpenPr = vi.fn()
    const { result, rerender } = renderHook((props: { onOpenPr: typeof onOpenPr }) => useRichLinkServices({ prsApi, paneId: '%1', connected: true, onOpenPr: props.onOpenPr }), { initialProps: { onOpenPr } })
    await waitFor(() => expect(result.current.hasQuickLook?.('acme/widgets', 12)).toBe(true))
    expect(result.current.hasQuickLook?.('acme/widgets', 13)).toBe(false)
    expect(await result.current.prSummary!('acme/widgets', 12)).toEqual({ title: 'fix: loop', state: 'draft' })
    expect(summary).not.toHaveBeenCalled()
    expect(await result.current.prSummary!('acme/widgets', 13)).toEqual({ title: 'other', state: 'open' })
    expect(summary).toHaveBeenCalledWith('acme/widgets', 13)

    // A new callback each render keeps the loader, so chips don't refetch.
    const loader = result.current.prSummary
    const next = vi.fn()
    rerender({ onOpenPr: next })
    expect(result.current.prSummary).toBe(loader)
    result.current.openPr?.('acme/widgets', 12, 'Checks')
    expect(next).toHaveBeenCalledWith('acme/widgets', 12, 'Checks')
  })

  it('offers no PR services without the PR API or a Quick Look handler', () => {
    const { result } = renderHook(() => useRichLinkServices({ paneId: '%1', connected: true }))
    expect(result.current).toEqual({})
  })
})
