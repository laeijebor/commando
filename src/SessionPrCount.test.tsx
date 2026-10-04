// @vitest-environment jsdom

import { act, cleanup, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, expect, it, vi } from 'vitest'
import type { PanePrList, PanePrSummary } from './prsApi'
import { SessionPrCount } from './SessionPrCount'
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
  expect(await screen.findByRole('img', { name: '3 open pull requests in work' })).toHaveTextContent('3')
  expect(await screen.findByRole('img', { name: '2 open pull requests in other' })).toHaveTextContent('2')
  expect(screen.queryByRole('img', { name: /in empty/ })).not.toBeInTheDocument()
  expect(api.pane.mock.calls.filter(([id]) => id === '%1')).toHaveLength(1)
})

it('shares foreground polling and removes the badge after merging', async () => {
  vi.useFakeTimers()
  const api = { pane: vi.fn().mockResolvedValueOnce(list([pr(1)])).mockResolvedValue(list([pr(1, 'merged')])) }
  function Foreground() { usePanePrs('%1', api, { background: false }); return null }
  const view = render(<><SessionPrCount paneIds={['%1']} api={api} enabled sessionName="work" /><Foreground /></>)
  await act(async () => { await Promise.resolve() })
  expect(screen.getByRole('img', { name: '1 open pull request in work' })).toBeInTheDocument()
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
  await screen.findByRole('img', { name: '1 open pull request in work' })
  view.rerender(<SessionPrCount paneIds={[]} api={api} enabled sessionName="work" />)
  expect(screen.queryByRole('img')).not.toBeInTheDocument()
})
