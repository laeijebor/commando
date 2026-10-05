// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, expect, it, vi } from 'vitest'
import type { PanePrList, PanePrSummary, PrSummary, PrsApiClient } from './prsApi'
import { SessionPrCards, SessionPrCount } from './SessionPrCount'
import { usePanePrs } from './prStore'

afterEach(() => { cleanup(); vi.useRealTimers() })

function pr(number: number, state: PanePrSummary['state'] = 'open', repo = 'acme/app'): PanePrSummary {
  return { repo, number, state, title: `PR ${number}`, url: `https://github.com/${repo}/pull/${number}`, isDraft: number === 2,
    createdAt: '', updatedAt: '', additions: 0, deletions: 0, checks: null, conflicting: false,
    unresolvedThreads: 0, threadsTruncated: false, reviewDecision: null }
}
function list(pullRequests: PanePrSummary[]): PanePrList {
  return { targetId: 'target', totalCount: pullRequests.length, pullRequests, truncated: false, fetchedAt: Date.now() }
}

it('counts unique open PRs across panes, includes drafts, and isolates sessions', async () => {
  const api = { pane: vi.fn(async (id: string) => list(id === '%1'
    ? [pr(1), pr(2), pr(3, 'merged'), pr(4, 'closed')]
    : id === '%2' ? [pr(1, 'open', 'ACME/App'), pr(1, 'open', 'other/app')] : [])) }
  render(<>
    <SessionPrCount paneIds={['%1', '%2']} api={api} enabled sessionName="work" />
    <SessionPrCount paneIds={['%3']} api={api} enabled sessionName="empty" />
    <SessionPrCount paneIds={['%1']} api={api} enabled sessionName="other" />
  </>)
  expect(await screen.findByRole('img', { name: 'PR #2 in work: Draft; 2 more open pull requests' })).toHaveTextContent('#2+2')
  expect(await screen.findByRole('img', { name: 'PR #2 in other: Draft; 1 more open pull request' })).toHaveTextContent('#2+1')
  expect(screen.queryByRole('img', { name: /in empty/ })).not.toBeInTheDocument()
  expect(api.pane.mock.calls.filter(([id]) => id === '%1')).toHaveLength(1)
})

it('shares foreground polling and removes the badge after merging', async () => {
  vi.useFakeTimers()
  const api = { pane: vi.fn().mockResolvedValueOnce(list([pr(1)])).mockResolvedValue(list([pr(1, 'merged')])) }
  function Foreground() { usePanePrs('%1', api, { background: false }); return null }
  const view = render(<><SessionPrCount paneIds={['%1']} api={api} enabled sessionName="work" /><Foreground /></>)
  await act(async () => { await Promise.resolve() })
  expect(screen.getByRole('img', { name: 'PR #1 in work: Checking merge readiness' })).toBeInTheDocument()
  view.rerender(<><SessionPrCount paneIds={['%1']} api={api} enabled sessionName="work" /><Foreground /></>)
  expect(api.pane).toHaveBeenCalledTimes(1)
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
  expect(screen.queryByRole('img')).not.toBeInTheDocument()
  expect(api.pane).toHaveBeenCalledTimes(2)
})

it('updates membership and skips requests while disconnected', async () => {
  const api = { pane: vi.fn(async () => list([pr(1)])) }
  const view = render(<SessionPrCount paneIds={['%1']} api={api} enabled={false} sessionName="work" />)
  expect(api.pane).not.toHaveBeenCalled()
  view.rerender(<SessionPrCount paneIds={['%1']} api={api} enabled sessionName="work" />)
  await screen.findByRole('img', { name: 'PR #1 in work: Checking merge readiness' })
  view.rerender(<SessionPrCount paneIds={[]} api={api} enabled sessionName="work" />)
  expect(screen.queryByRole('img')).not.toBeInTheDocument()
})

function withPreview(number: number, overrides: Partial<PrSummary> = {}): PanePrSummary {
  const summary: PrSummary = {
    ...pr(number), author: 'leo', bodyExcerpt: 'Full HUD hover excerpt', changedFiles: 2, commitCount: 1,
    reviews: [], requestedReviewers: [], mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN',
    headRefName: 'feature', baseRefName: 'main', headRefOid: '2'.repeat(40), baseRefOid: '1'.repeat(40),
    viewerIsAuthor: true, viewerReviewRequested: false, commandoMarker: null, ...overrides,
  }
  return { ...pr(number), ...summary, preview: summary }
}

it('shows the HUD hover and opens quick look from a numbered session pill', async () => {
  const first = withPreview(12, { unresolvedThreads: 2 })
  const api = {
    pane: vi.fn(async () => list([first, withPreview(11)])),
    threads: vi.fn(async () => ({ threads: [], truncated: false })),
    details: vi.fn(async () => ({ body: '# Full description', conversation: [], checks: [], headOid: first.preview!.headRefOid, mergeTarget: { branch: first.preview!.baseRefName, oid: first.preview!.baseRefOid } })),
  } as unknown as PrsApiClient
  render(<SessionPrCount paneIds={['%1']} api={api} previewApi={api} enabled sessionName="work" />)
  const pill = await screen.findByRole('button', { name: /PR #12 in work: 2 unresolved comment threads; 1 more/ })
  expect(pill).toHaveTextContent('#12+1')
  expect(pill.querySelector('.session-pr-readiness')).toHaveClass('amber')
  fireEvent.mouseEnter(pill.closest('article')!)
  expect(await screen.findByRole('dialog', { name: 'Details for #12' })).toHaveTextContent('Full HUD hover excerpt')
  expect(api.threads).toHaveBeenCalledWith('acme/app', 12)
  fireEvent.click(pill)
  expect(await screen.findByRole('heading', { name: 'Full description' })).toBeVisible()
  expect(screen.queryByRole('dialog', { name: 'Details for #12' })).not.toBeInTheDocument()
})

it('renders distinct open PR cards, in newest order, sharing the pill subscription', async () => {
  const api = { pane: vi.fn(async () => list([withPreview(10), withPreview(12), { ...withPreview(13), state: 'merged' }])) } as unknown as PrsApiClient
  render(<>
    <SessionPrCount paneIds={['%1', '%2']} api={api} previewApi={api} enabled sessionName="work" />
    <SessionPrCards paneIds={['%1', '%2']} api={api} enabled sessionName="work" liveTargetIds={new Set()} onJumpToTarget={vi.fn()} />
  </>)
  expect(await screen.findByRole('button', { name: 'Quick look at PR #12' })).toBeVisible()
  expect([...screen.getByRole('region', { name: 'Open pull requests in work' }).querySelectorAll('.pr-number')].map((node) => node.textContent)).toEqual(['#12', '#10'])
  expect(screen.queryByRole('button', { name: 'Quick look at PR #13' })).not.toBeInTheDocument()
  expect(api.pane).toHaveBeenCalledTimes(2)
})
