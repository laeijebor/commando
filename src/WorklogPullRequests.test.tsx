// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { PanePrList, PanePrSummary } from './prsApi'
import { WorklogPullRequests } from './WorklogPullRequests'

afterEach(cleanup)

function pr(overrides: Partial<PanePrSummary> & Pick<PanePrSummary, 'number'>): PanePrSummary {
  return {
    repo: 'acme/app', title: `PR ${overrides.number}`, url: `https://github.com/acme/app/pull/${overrides.number}`, state: 'open', isDraft: false,
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', additions: 0, deletions: 0, checks: null,
    conflicting: false, unresolvedThreads: 0, threadsTruncated: false, reviewDecision: null, ...overrides,
  }
}

function list(pullRequests: PanePrSummary[], impacted?: PanePrList['impacted'], truncated = false): PanePrList {
  return { targetId: 'target', totalCount: pullRequests.length, truncated, fetchedAt: 0, pullRequests, ...(impacted ? { impacted } : {}) }
}

describe('WorklogPullRequests', () => {
  it('lists created and impacted PRs newest first with state, relation and foreign repos', async () => {
    const onOpen = vi.fn()
    const at = (iso: string) => Date.parse(iso)
    render(<WorklogPullRequests paneId="%3" paneLabel="Tests" onOpen={onOpen} repoForPane={async () => 'acme/app'} list={list([
      pr({ number: 1, createdAt: '2026-01-01T00:00:00Z' }),
    ], [
      { ...pr({ number: 2, state: 'merged' }), relation: 'pushed', impactedAt: at('2026-01-04T00:00:00Z') },
      { ...pr({ number: 3, isDraft: true }), relation: 'commented', impactedAt: at('2026-01-02T00:00:00Z') },
      { ...pr({ repo: 'other/lib', number: 4, state: 'closed' }), relation: 'reviewed', impactedAt: at('2026-01-03T00:00:00Z') },
    ])} />)
    const section = screen.getByLabelText('Pull requests for Tests')
    await within(section).findByText('merged')
    const rows = within(section).getAllByRole('button')
    expect(rows.map((row) => row.getAttribute('aria-label'))).toEqual([
      'Open merged pull request acme/app #2: PR 2 (pushed)',
      'Open closed pull request other/lib #4: PR 4 (reviewed)',
      'Open draft pull request acme/app #3: PR 3 (commented)',
      'Open open pull request acme/app #1: PR 1 (created)',
    ])
    expect(rows[1]).toHaveTextContent('other/lib · closed')
    expect(rows[0]).not.toHaveTextContent('acme/app')
    expect(rows[0]).toHaveTextContent('#2 PR 2')
    fireEvent.click(rows[1])
    expect(onOpen).toHaveBeenCalledWith('other/lib', 4)
  })

  it.each([
    ['fail', '✗ 2 failing', 'changes_requested', 'changes requested'],
    ['pending', '● 3 running', 'approved', 'approved'],
    ['pass', '✓ checks', null, null],
  ] as const)('shows %s checks with diffstat and review/conflict badges', (state, label, decision, reviewLabel) => {
    render(<WorklogPullRequests paneId="%3" paneLabel="Tests" list={list([pr({
      number: 12, additions: 1234, deletions: 56, conflicting: true, unresolvedThreads: 2, unansweredThreads: 1, threadsTruncated: true, reviewDecision: decision,
      checks: { state, failed: state === 'fail' ? 2 : 0, pending: state === 'pending' ? 3 : 0, total: 5, runs: [], truncated: false },
    })])} />)
    expect(screen.getByText('+1,234')).toBeInTheDocument()
    expect(screen.getByText('−56')).toBeInTheDocument()
    expect(screen.getByText(label)).toBeInTheDocument()
    expect(screen.getByText('1+ unanswered')).toHaveClass('warn')
    expect(screen.getByText('1+ unresolved')).toHaveClass('replied')
    expect(screen.getByText('⚠ conflicts')).toBeInTheDocument()
    if (reviewLabel) expect(screen.getByText(reviewLabel)).toBeInTheDocument()
  })

  it('shows a pane that only impacted PRs, and names every repo until the pane repo is known', () => {
    render(<WorklogPullRequests paneId="%3" paneLabel="Tests" list={list([], [{ ...pr({ number: 5 }), relation: 'pushed', impactedAt: 1 }])} />)
    expect(screen.getByRole('button', { name: /#5/ })).toHaveTextContent('acme/app · open')
  })

  it('treats a list from an older daemon as created PRs and names every repo until the pane repo is known', () => {
    render(<WorklogPullRequests paneId="%3" paneLabel="Tests" list={list([pr({ number: 7 })])} />)
    const row = screen.getByRole('button', { name: /#7/ })
    expect(row).toHaveTextContent('acme/app · open')
    expect(row).toHaveTextContent('created')
    expect(row).toBeDisabled()
  })

  it('renders nothing without PRs and notes a truncated list', () => {
    const { container, rerender } = render(<WorklogPullRequests paneId="%3" paneLabel="Tests" list={list([])} />)
    expect(container).toBeEmptyDOMElement()
    rerender(<WorklogPullRequests paneId="%3" paneLabel="Tests" list={list([pr({ number: 1 })], undefined, true)} />)
    expect(screen.getByText('More linked PRs are on GitHub.')).toBeInTheDocument()
  })
})
