import type { PrDetails, PrRemoteDiff } from '@commando/pr-quick-look'

import { daemonFetch, DaemonHttpError } from '../hosts/api'
import type { Host } from '../hosts/types'

export type { PrConversationEntry, PrDetails, PrRemoteDiff, PrReviewThread } from '@commando/pr-quick-look'

/**
 * The PR fields the phone draws in a PR's header: a trimmed copy of the
 * daemon's `PrSummary` (`shared/pr-types.ts`), which `GET /api/prs/pane`
 * carries as `preview` and `GET /api/prs` lists in full. Everything is
 * optional so an older daemon, or a newer one with more fields, never breaks
 * the screen.
 */
export type PrPreview = {
  number: number
  title: string
  url: string
  state: 'open' | 'merged' | 'closed'
  isDraft: boolean
  author?: string | null
  additions?: number
  deletions?: number
  changedFiles?: number
  commitCount?: number
  unresolvedThreads?: number
  reviewDecision?: 'approved' | 'changes_requested' | 'review_required' | null
  conflicting?: boolean
  checks?: { state: 'pass' | 'fail' | 'pending'; failed: number; pending: number; total: number } | null
  headRefName?: string
  baseRefName?: string
  headRefOid?: string
  baseRefOid?: string
  createdAt?: string
  updatedAt?: string
}

async function readJson<T>(host: Host, path: string, fallback: string, timeoutMs: number): Promise<T> {
  const response = await daemonFetch(host, path, { timeoutMs })
  if (!response.ok) {
    let message = `${fallback} (${response.status})`
    try {
      const body = (await response.json()) as { error?: unknown }
      if (typeof body.error === 'string' && body.error) message = body.error
    } catch {
      // Not JSON: keep the status line.
    }
    throw new DaemonHttpError(response.status, message)
  }
  return (await response.json()) as T
}

function prQuery(repo: string, number: number, extra = ''): string {
  return `?repo=${encodeURIComponent(repo)}&number=${number}${extra}`
}

/**
 * `GET /api/prs/details` — the full description, conversation and checks. The
 * daemon caches each part (metadata 5 min, conversation 60 s, checks 30 s) and
 * serves its last copy while GitHub is rate limited; `refresh` bypasses that
 * and is only sent when the owner pulls to refresh.
 */
export async function fetchPrDetails(host: Host, repo: string, number: number, options: { refresh?: boolean } = {}): Promise<PrDetails> {
  const body = await readJson<{ details: PrDetails }>(host, `/api/prs/details${prQuery(repo, number, options.refresh ? '&refresh=1' : '')}`, 'PR details failed', 30_000)
  return body.details
}

/** `GET /api/prs/diff` — the files the PR changes against the repository's remote main, with GitHub's patches. */
export async function fetchPrDiff(host: Host, repo: string, number: number): Promise<PrRemoteDiff> {
  const body = await readJson<{ diff: PrRemoteDiff }>(host, `/api/prs/diff${prQuery(repo, number)}`, 'PR diff failed', 30_000)
  return body.diff
}

/**
 * The PR's summary when the pane list carried no `preview` (an older daemon,
 * or a PR opened from outside a pane): the same `GET /api/prs` read the
 * desktop panel falls back to.
 */
export async function fetchPrPreview(host: Host, repo: string, number: number): Promise<PrPreview> {
  const body = await readJson<{ list: { pullRequests: PrPreview[] } }>(
    host,
    `/api/prs?repo=${encodeURIComponent(repo)}&state=all&scope=everyone`,
    'PR list failed',
    30_000,
  )
  const found = body.list.pullRequests.find((candidate) => candidate.number === number)
  if (!found) throw new Error(`#${number} is not in ${repo}'s pull request list`)
  return found
}
