// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
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
    bodyExcerpt: 'Adds the thing behind a flag.',
    additions: 100,
    deletions: 25,
    changedFiles: 4,
    commitCount: 3,
    unresolvedThreads: 0,
    threadsTruncated: false,
    reviewDecision: null,
    reviews: [],
    requestedReviewers: [],
    conflicting: false,
    checks: null,
    createdAt: '2026-08-01T09:00:00Z',
    updatedAt: new Date().toISOString(),
    headRefName: 'leo/thing',
    baseRefName: 'main',
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
  list?: (url: string) => Response | Promise<Response>
  paneRepo?: (url: string) => Response | Promise<Response>
  threads?: (url: string) => Response
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
      return jsonResponse({ prefs: { version: 1, pinnedRepos: ['acme/widgets'], recentRepos: ['acme/widgets'], lastRepo: 'acme/widgets', lastFilter: 'open', lastScope: 'mine' } })
    }
    if (url.includes('/api/prs/threads')) {
      return routes.threads?.(url) ?? jsonResponse({ threads: { repo: 'acme/widgets', number: 12, threads: [], truncated: false, fetchedAt: 0 } })
    }
    if (url.includes('/api/prs/repos')) {
      return jsonResponse({ repos: [{ nameWithOwner: 'acme/widgets', pinned: true }, { nameWithOwner: 'acme/gadgets', pinned: false }] })
    }
    if (url.includes('/api/prs/repo')) {
      return routes.paneRepo?.(url) ?? jsonResponse({ repo: null })
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

  it('renders the PR number in its own id row instead of inside the title link', async () => {
    stubFetch({ list: () => jsonResponse({ list: listWith([pr()]) }) })
    render(<PrsSection token="t" />)
    const title = await screen.findByRole('link', { name: 'feat: add thing' })
    expect(title).toBeInTheDocument()
    const number = screen.getByText('#12')
    expect(number).toBeInTheDocument()
    expect(title.contains(number)).toBe(false)
  })

  it('opens a hover popover with details after a delay and lazily loads thread excerpts', async () => {
    stubFetch({
      list: () => jsonResponse({
        list: listWith([pr({
          unresolvedThreads: 2,
          baseRefName: 'release/2.0',
          reviews: [{ login: 'timgent', state: 'approved' }],
          requestedReviewers: ['dana'],
          checks: { state: 'pass', runs: [{ name: 'Build', state: 'pass' }], failed: 0, pending: 0, total: 1, truncated: false },
        })]),
      }),
      threads: () => jsonResponse({
        threads: {
          repo: 'acme/widgets', number: 12, truncated: false, fetchedAt: 0,
          threads: [{ path: 'src/SocialFeed.tsx', author: 'andrii', excerpt: 'should this cache key include the session' }],
        },
      }),
    })
    const { container } = render(<PrsSection token="t" />)
    await screen.findByRole('link', { name: 'feat: add thing' })
    expect(screen.queryByText('Adds the thing behind a flag.')).not.toBeInTheDocument()

    vi.useFakeTimers()
    fireEvent.mouseEnter(container.querySelector('.pr-card')!)
    await act(async () => { await vi.advanceTimersByTimeAsync(400) })
    vi.useRealTimers()

    expect(await screen.findByRole('dialog', { name: 'Details for #12' })).toHaveAttribute('data-native-terminal-occluder', '')
    expect(screen.getByText('Adds the thing behind a flag.')).toBeInTheDocument()
    expect(screen.getByText('release/2.0')).toBeInTheDocument()
    expect(screen.getByText('timgent')).toBeInTheDocument()
    expect(screen.getByText(/dana/)).toBeInTheDocument()
    expect(screen.getByText('Build')).toBeInTheDocument()
    expect(await screen.findByText(/should this cache key include the session/)).toBeInTheDocument()
    expect(requests.some((request) => request.url.includes('/api/prs/threads') && request.url.includes('number=12'))).toBe(true)
  })

  it('keeps the popover working when the thread request fails, and copies the number', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    stubFetch({
      list: () => jsonResponse({ list: listWith([pr({ unresolvedThreads: 1 })]) }),
      threads: () => jsonResponse({ error: 'boom', code: 'github_failed' }, 502),
    })
    const { container } = render(<PrsSection token="t" />)
    await screen.findByRole('link', { name: 'feat: add thing' })

    vi.useFakeTimers()
    fireEvent.mouseEnter(container.querySelector('.pr-card')!)
    await act(async () => { await vi.advanceTimersByTimeAsync(400) })
    vi.useRealTimers()

    expect(await screen.findByText('Adds the thing behind a flag.')).toBeInTheDocument()
    expect(await screen.findByText(/comments unavailable/i)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Copy #' }))
    expect(writeText).toHaveBeenCalledWith('12')
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
    // The per-run breakdown lives in the hover popover now, not a chip tooltip.
    expect(screen.queryByText(/✗ Lint/)).not.toBeInTheDocument()
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

  it('keeps cached repo data visible while switching back and revalidating', async () => {
    let widgetsCalls = 0
    let finishRefresh: ((response: Response) => void) | undefined
    stubFetch({
      list: (url) => {
        if (url.includes('repo=acme%2Fgadgets')) {
          return jsonResponse({ list: listWith([pr({ title: 'gadgets title' })], 1, { repo: 'acme/gadgets' }) })
        }
        widgetsCalls += 1
        if (widgetsCalls === 1) {
          return jsonResponse({ list: listWith([pr({ title: 'cached widgets title' })]) })
        }
        return new Promise<Response>((resolve) => { finishRefresh = resolve })
      },
    })
    render(<PrsSection token="t" />)
    expect(await screen.findByText('cached widgets title')).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('Repository'), { target: { value: 'acme/gadgets' } })
    expect(await screen.findByText('gadgets title')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Repository'), { target: { value: 'acme/widgets' } })

    expect(screen.getByText('cached widgets title')).toBeInTheDocument()
    expect(screen.queryByText('gadgets title')).not.toBeInTheDocument()
    finishRefresh?.(jsonResponse({ list: listWith([pr({ title: 'refreshed widgets title' })]) }))
    expect(await screen.findByText('refreshed widgets title')).toBeInTheDocument()
  })

  it('selects and remembers the current pane tracking repository', async () => {
    stubFetch({
      paneRepo: () => jsonResponse({ repo: 'acme/gadgets' }),
      list: (url) => jsonResponse({
        list: listWith([], 0, { repo: url.includes('repo=acme%2Fgadgets') ? 'acme/gadgets' : 'acme/widgets' }),
      }),
    })
    render(<PrsSection token="t" currentPaneId="%7" currentPanePath="/workspace/gadgets" />)

    await waitFor(() => expect(screen.getByLabelText('Repository')).toHaveValue('acme/gadgets'))
    expect(requests.some((request) => request.url.includes('/api/prs/repo?paneId=%257'))).toBe(true)
    expect(requests.some((request) => (
      request.method === 'PUT' && (request.body as { lastRepo?: string })?.lastRepo === 'acme/gadgets'
    ))).toBe(true)
  })

  it('remembers an auto-detected repo that was already selected from suggestions', async () => {
    stubFetch({ paneRepo: () => jsonResponse({ repo: 'ACME/WIDGETS' }) })
    render(<PrsSection token="t" currentPaneId="%7" currentPanePath="/workspace/widgets" />)

    await waitFor(() => expect(requests.some((request) => (
      request.method === 'PUT' && (request.body as { lastRepo?: string })?.lastRepo === 'ACME/WIDGETS'
    ))).toBe(true))
    expect(screen.getByLabelText('Repository')).toHaveValue('acme/widgets')
  })

  it('does not let a late pane lookup override a manual repository choice', async () => {
    let finishLookup: ((response: Response) => void) | undefined
    stubFetch({
      paneRepo: () => new Promise<Response>((resolve) => { finishLookup = resolve }),
    })
    render(<PrsSection token="t" currentPaneId="%7" currentPanePath="/workspace/widgets" />)
    const selector = await screen.findByLabelText('Repository')
    await waitFor(() => expect(finishLookup).toBeDefined())

    fireEvent.change(selector, { target: { value: 'acme/gadgets' } })
    finishLookup?.(jsonResponse({ repo: 'acme/widgets' }))
    await act(async () => { await Promise.resolve() })
    expect(selector).toHaveValue('acme/gadgets')
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
