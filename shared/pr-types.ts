import type { CommandoPrMarker } from './pane-target.js'

export type PrStateFilter = 'open' | 'closed' | 'all'
export type PrScope = 'mine' | 'everyone'
export type PrCheckState = 'pass' | 'fail' | 'pending'
export type PrCheckRun = { name: string; state: PrCheckState }
export type PrChecks = { state: PrCheckState; runs: PrCheckRun[]; failed: number; pending: number; total: number; truncated: boolean } | null
export type PrReview = { login: string; state: 'approved' | 'changes_requested' }
export type PrSummary = {
  number: number
  title: string
  url: string
  state: 'open' | 'merged' | 'closed'
  isDraft: boolean
  author: string | null
  bodyExcerpt: string
  additions: number
  deletions: number
  changedFiles: number
  commitCount: number
  unresolvedThreads: number
  // Optional while the frontend and daemon may be running different versions.
  unansweredThreads?: number
  threadsTruncated: boolean
  reviewDecision: 'approved' | 'changes_requested' | 'review_required' | null
  reviews: PrReview[]
  requestedReviewers: string[]
  conflicting: boolean
  mergeable?: string
  mergeStateStatus?: string
  checks: PrChecks
  createdAt: string
  updatedAt: string
  headRefName: string
  baseRefName: string
  headRefOid: string
  baseRefOid: string
  viewerIsAuthor: boolean
  viewerReviewRequested: boolean
  commandoMarker: CommandoPrMarker | null
  // Entity freshness can be newer than the query's membership timestamp.
  statusFetchedAt?: number
}
export type PrList = {
  repo: string
  filter: PrStateFilter
  viewer: string
  totalCount: number
  pullRequests: PrSummary[]
  truncated: boolean
  mineTruncated: boolean
  fetchedAt: number
}
export type PrStatus = Pick<PrSummary, 'additions' | 'deletions' | 'checks' | 'conflicting' | 'unresolvedThreads' | 'unansweredThreads' | 'threadsTruncated' | 'reviewDecision'>
export type PanePrSummary = PrStatus & Pick<PrSummary, 'number' | 'title' | 'url' | 'state' | 'isDraft' | 'createdAt' | 'updatedAt' | 'statusFetchedAt'> & {
  repo: string
  preview?: PrSummary
}
export type PanePrList = {
  targetId: string
  totalCount: number
  pullRequests: PanePrSummary[]
  truncated: boolean
  fetchedAt: number
}
