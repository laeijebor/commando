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
  /** GitHub's `mergeable` and `mergeStateStatus`, read by `prMergeDisabledReason`. */
  mergeable?: string
  mergeStateStatus?: string
  checks?: { state: 'pass' | 'fail' | 'pending'; failed: number; pending: number; total: number } | null
  headRefName?: string
  baseRefName?: string
  headRefOid?: string
  baseRefOid?: string
  createdAt?: string
  updatedAt?: string
}

/** The daemon's `{ error }` message for a failed response, or `fallback` with the status. */
async function failure(response: Response, fallback: string): Promise<DaemonHttpError> {
  let message = `${fallback} (${response.status})`
  try {
    const body = (await response.json()) as { error?: unknown }
    if (typeof body.error === 'string' && body.error) message = body.error
  } catch {
    // Not JSON: keep the status line.
  }
  return new DaemonHttpError(response.status, message)
}

async function readJson<T>(host: Host, path: string, fallback: string, timeoutMs: number): Promise<T> {
  const response = await daemonFetch(host, path, { timeoutMs })
  if (!response.ok) throw await failure(response, fallback)
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

/**
 * `GET /api/prs/diff?base=pr` — GitHub's "Files changed": the PR against its
 * own base, with GitHub's patches. (Without `base=pr` the daemon compares with
 * the remote main, which is empty once a PR has merged.)
 */
export async function fetchPrDiff(host: Host, repo: string, number: number): Promise<PrRemoteDiff> {
  const body = await readJson<{ diff: PrRemoteDiff }>(host, `/api/prs/diff${prQuery(repo, number, '&base=pr')}`, 'PR diff failed', 30_000)
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

/**
 * `POST /api/prs/merge` — the desktop panel's Merge PR. The daemon re-reads
 * the PR first and refuses if it is no longer mergeable, has new commits
 * (`headRefOid`) or now targets another branch (`baseRefName`), then merges
 * with the first method the repository allows (merge, squash, rebase).
 */
export async function mergePr(host: Host, repo: string, number: number, headRefOid: string, baseRefName?: string): Promise<void> {
  const response = await daemonFetch(host, '/api/prs/merge', {
    method: 'POST',
    body: { repo, number, headRefOid, ...(baseRefName ? { baseRefName } : {}) },
    timeoutMs: 60_000,
  })
  if (!response.ok) throw await failure(response, 'Merge failed')
}
