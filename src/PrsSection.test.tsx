// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PrsSection, prsNeedAttention } from './PrsSection'
import type { PrList, PrSummary } from './prsApi'

function pr(overrides: Partial<PrSummary> = {}): PrSummary {
  return {
    number: 12,
    title: 'feat: add thing',
    url: 'https://github.com/acme/widgets/pull/12',
    state: 'open',
    isDraft: false,
    author: 'leo',
    additions: 100,
    deletions: 25,
    changedFiles: 4,
    unresolvedThreads: 0,
    threadsTruncated: false,
    reviewDecision: null,
    conflicting: false,
    checks: null,
    updatedAt: new Date().toISOString(),
    headRefName: 'leo/thing',
    viewerIsAuthor: true,
    viewerReviewRequested: false,
    ...overrides,
  }
}

function listWith(pullRequests: PrSummary[], totalCount = pullRequests.length, overrides: Partial<PrList> = {}): PrList {
  return { repo: 'acme/widgets', filter: 'open', viewer: 'leo', totalCount, pullRequests, truncated: totalCount > pullRequests.length, mineTruncated: false, fetchedAt: Date.now(), ...overrides }
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })
}

type Routes = {
  list?: (url: string) => Response
  prefsPut?: (body: unknown) => Response
}

const requests: Array<{ url: string; method: string; body: unknown }> = []

function stubFetch(routes: Routes = {}): void {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as unknown : undefined
    requests.push({ url, method, body })
    if (url.includes('/api/prs/prefs')) {
      if (method === 'PUT' && routes.prefsPut) return routes.prefsPut(body)
      return jsonResponse({ prefs: { version: 1, pinnedRepos: ['acme/widgets'], lastRepo: 'acme/widgets', lastFilter: 'open', lastScope: 'mine' } })
    }
    if (url.includes('/api/prs/repos')) {
      return jsonResponse({ repos: [{ nameWithOwner: 'acme/widgets', pinned: true }, { nameWithOwner: 'acme/gadgets', pinned: false }] })
    }
    if (url.includes('/api/prs')) {
      return routes.list?.(url) ?? jsonResponse({ list: listWith([]) })
    }
    return jsonResponse({ error: 'Not found' }, 404)
  }))
}

beforeEach(() => {
  requests.length = 0
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('PrsSection', () => {
  it('groups your PRs and review requests, revealing the rest on demand', async () => {
    stubFetch({
      list: () => jsonResponse({
        list: listWith([
          pr({ number: 1, title: 'yours: fix resize' }),
          pr({ number: 2, title: 'review me: auth linking', author: 'timgent', viewerIsAuthor: false, viewerReviewRequested: true }),
          pr({ number: 3, title: 'someone else: ECR push', author: 'andrii', viewerIsAuthor: false }),
        ], 5),
      }),
    })
    render(<PrsSection token="t" />)
    expect(await screen.findByText('yours: fix resize')).toBeInTheDocument()
    expect(screen.getByText('Yours')).toBeInTheDocument()
    expect(screen.getByText('Needs your review')).toBeInTheDocument()
    expect(screen.getByText('review me: auth linking')).toBeInTheDocument()
    expect(screen.queryByText('someone else: ECR push')).not.toBeInTheDocument()

    const reveal = screen.getByRole('button', { name: /Everyone.s open PRs · 3 · show/ })
    fireEvent.click(reveal)
    expect(await screen.findByText('someone else: ECR push')).toBeInTheDocument()
    await waitFor(() => {
      expect(requests.some((request) => request.method === 'PUT' && (request.body as { lastScope?: string })?.lastScope === 'everyone')).toBe(true)
    })
  })

  it('notes when the viewer-scoped searches overflow a page', async () => {
    stubFetch({
      list: () => jsonResponse({ list: listWith([pr()], 1, { mineTruncated: true }) }),
    })
    render(<PrsSection token="t" />)
    expect(await screen.findByText(/Some of your PRs and review requests/)).toBeInTheDocument()
  })

  it('renders diffstat, unresolved, review decision, conflict, and checks chips', async () => {
    stubFetch({
      list: () => jsonResponse({
        list: listWith([
          pr({
            additions: 1494,
            deletions: 45,
            unresolvedThreads: 2,
            reviewDecision: 'changes_requested',
            conflicting: true,
            checks: {
              state: 'fail',
              runs: [{ name: 'Lint', state: 'fail' }, { name: 'Build', state: 'pass' }],
              failed: 1,
              pending: 0,
              total: 2,
              truncated: false,
            },
          }),
        ]),
      }),
    })
    render(<PrsSection token="t" />)
    expect(await screen.findByText('+1,494')).toBeInTheDocument()
    expect(screen.getByText('−45')).toBeInTheDocument()
    expect(screen.getByText('2 unresolved')).toBeInTheDocument()
    expect(screen.getByText('changes requested')).toBeInTheDocument()
    expect(screen.getByText('⚠ conflicts')).toBeInTheDocument()
    expect(screen.getByText('✗ 1 failing')).toBeInTheDocument()
    expect(screen.getByText(/✗ Lint/)).toBeInTheDocument()
  })

  it('falls back to a countless fail label when reruns cleared every named failure', async () => {
    stubFetch({
      list: () => jsonResponse({
        list: listWith([
          pr({ checks: { state: 'fail', runs: [{ name: 'CI', state: 'pass' }], failed: 0, pending: 0, total: 1, truncated: true } }),
        ]),
      }),
    })
    render(<PrsSection token="t" />)
    expect(await screen.findByText('✗ checks')).toBeInTheDocument()
  })

  it('persists filter changes and refetches with the new state', async () => {
    stubFetch()
    render(<PrsSection token="t" />)
    await screen.findByLabelText('Pull request filters')
    fireEvent.click(screen.getByRole('button', { name: 'closed' }))
    await waitFor(() => {
      expect(requests.some((request) => request.url.includes('state=closed'))).toBe(true)
      expect(requests.some((request) => request.method === 'PUT' && (request.body as { lastFilter?: string })?.lastFilter === 'closed')).toBe(true)
    })
  })

  it('shows the gh sign-in hint when the daemon reports auth_required', async () => {
    stubFetch({
      list: () => jsonResponse({ error: 'gh is not authenticated', code: 'auth_required' }, 401),
    })
    render(<PrsSection token="t" />)
    expect(await screen.findByText('GitHub sign-in needed')).toBeInTheDocument()
    expect(screen.getByText(/gh auth login/)).toBeInTheDocument()
  })

  it('reports attention for failing checks on your open PRs', async () => {
    const onAttentionChange = vi.fn()
    stubFetch({
      list: () => jsonResponse({
        list: listWith([
          pr({ checks: { state: 'fail', runs: [{ name: 'CI', state: 'fail' }], failed: 1, pending: 0, total: 1, truncated: false } }),
        ]),
      }),
    })
    render(<PrsSection token="t" onAttentionChange={onAttentionChange} />)
    await waitFor(() => expect(onAttentionChange).toHaveBeenLastCalledWith(true))
  })
})

describe('prsNeedAttention', () => {
  it('flags review requests, failing checks, conflicts, and changes requested — but only on open PRs', () => {
    expect(prsNeedAttention(null)).toBe(false)
    expect(prsNeedAttention(listWith([pr()]))).toBe(false)
    expect(prsNeedAttention(listWith([pr({ viewerIsAuthor: false, viewerReviewRequested: true })]))).toBe(true)
    expect(prsNeedAttention(listWith([pr({ conflicting: true })]))).toBe(true)
    expect(prsNeedAttention(listWith([pr({ reviewDecision: 'changes_requested' })]))).toBe(true)
    expect(prsNeedAttention(listWith([pr({ state: 'merged', conflicting: true })]))).toBe(false)
    expect(prsNeedAttention(listWith([pr({ viewerIsAuthor: false, author: 'other', conflicting: false })]))).toBe(false)
  })
})
