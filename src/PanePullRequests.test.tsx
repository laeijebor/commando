// @vitest-environment jsdom

import { act, cleanup, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { PanePullRequests } from './PanePullRequests'
import type { PanePrSummary, PrStatus } from './prsApi'

const status: PrStatus = {
  additions: 100, deletions: 25, checks: null, conflicting: false,
  unresolvedThreads: 0, threadsTruncated: false, reviewDecision: null,
}

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('PanePullRequests', () => {
  it.each([
    ['fail', '✗ 2 failing', 'changes_requested', 'changes requested'],
    ['pending', '● 3 running', 'approved', 'approved'],
    ['pass', '✓ checks', null, null],
  ] as const)('renders %s checks with diffstat and review/conflict badges', (state, label, decision, reviewLabel) => {
    const pr: PanePrSummary = {
      ...status, repo: 'acme/widgets', number: 12, title: 'Badge coverage',
      url: 'https://github.com/acme/widgets/pull/12', state: 'open', isDraft: false,
      createdAt: '', updatedAt: '', additions: 1234, deletions: 56,
      conflicting: true, unresolvedThreads: 2, threadsTruncated: true, reviewDecision: decision,
      checks: { state, failed: state === 'fail' ? 2 : 0, pending: state === 'pending' ? 3 : 0, total: 5, runs: [], truncated: false },
    }
    render(<PanePullRequests paneId="%12" api={{ pane: vi.fn() }} connected list={{
      targetId: 'target', totalCount: 1, pullRequests: [pr], truncated: false, fetchedAt: 1,
    }} />)
    expect(screen.getByText('+1,234')).toBeInTheDocument()
    expect(screen.getByText('−56')).toBeInTheDocument()
    expect(screen.getByText(label)).toBeInTheDocument()
    expect(screen.getByText('2+ unresolved')).toBeInTheDocument()
    expect(screen.getByText('⚠ conflicts')).toBeInTheDocument()
    if (reviewLabel) expect(screen.getByText(reviewLabel)).toBeInTheDocument()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('renders multiple linked pull requests with repository and state', async () => {
    const api = {
      pane: vi.fn(async () => ({
        targetId: '123e4567-e89b-42d3-a456-426614174000',
        totalCount: 2,
        truncated: false,
        fetchedAt: 1,
        pullRequests: [
          {
            ...status,
            repo: 'acme/gadgets',
            number: 44,
            title: 'Second pane PR',
            url: 'https://github.com/acme/gadgets/pull/44',
            state: 'open' as const,
            isDraft: true,
            createdAt: '2026-08-21T09:00:00Z',
            updatedAt: '2026-08-21T10:00:00Z',
          },
          {
            ...status,
            repo: 'acme/widgets',
            number: 12,
            title: 'First pane PR',
            url: 'https://github.com/acme/widgets/pull/12',
            state: 'merged' as const,
            isDraft: false,
            createdAt: '2026-08-19T09:00:00Z',
            updatedAt: '2026-08-20T09:00:00Z',
          },
        ],
      })),
    }

    render(<PanePullRequests paneId="%12" api={api} connected />)

    expect(await screen.findByRole('link', {
      name: 'Open draft pull request acme/gadgets #44: Second pane PR',
    })).toHaveTextContent('acme/gadgets #44 · draft')
    expect(screen.getByRole('link', {
      name: 'Open merged pull request acme/widgets #12: First pane PR',
    })).toHaveAttribute('href', 'https://github.com/acme/widgets/pull/12')
    expect(api.pane).toHaveBeenCalledWith('%12')
  })

  it('stays hidden when no linked pull requests exist', async () => {
    const api = {
      pane: vi.fn(async () => ({
        targetId: '123e4567-e89b-42d3-a456-426614174000',
        totalCount: 0,
        truncated: false,
        fetchedAt: 1,
        pullRequests: [],
      })),
    }

    render(<PanePullRequests paneId="%12" api={api} connected />)
    await vi.waitFor(() => expect(api.pane).toHaveBeenCalled())
    expect(screen.queryByText('Pull requests')).not.toBeInTheDocument()
  })

  it('keeps the last successful list when a background refresh fails', async () => {
    vi.useFakeTimers()
    const api = {
      pane: vi.fn()
        .mockResolvedValueOnce({
          targetId: '123e4567-e89b-42d3-a456-426614174000',
          totalCount: 1,
          truncated: false,
          fetchedAt: 1,
          pullRequests: [{
            ...status,
            repo: 'acme/widgets',
            number: 12,
            title: 'Stable pane PR',
            url: 'https://github.com/acme/widgets/pull/12',
            state: 'open' as const,
            isDraft: false,
            createdAt: '2026-08-21T09:00:00Z',
            updatedAt: '2026-08-21T10:00:00Z',
          }],
        })
        .mockRejectedValueOnce(new Error('rate limited')),
    }

    render(<PanePullRequests paneId="%12" api={api} connected />)
    await act(async () => { await Promise.resolve() })
    expect(screen.getByText('Stable pane PR')).toBeInTheDocument()

    await act(async () => {
      vi.advanceTimersByTime(30_000)
      await Promise.resolve()
    })
    expect(api.pane).toHaveBeenCalledTimes(2)
    expect(screen.getByText('Stable pane PR')).toBeInTheDocument()
  })
})
