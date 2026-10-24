export type PrReviewThread = {
  id: string
  commentId: number
  isResolved: boolean
  /** The code under the thread changed since it was written. Absent from older daemons. */
  isOutdated?: boolean
  viewerCanReply: boolean
  viewerCanResolve: boolean
  viewerCanUnresolve: boolean
}

export type PrConversationEntry = {
  id: string
  author: string
  body: string
  url: string
  createdAt: string
  kind: string
  path?: string
  line?: number
  /** Where an outdated inline comment was written, when it no longer has a current line. */
  originalLine?: number
  /** The last lines of the diff hunk a thread's first inline comment was left on. */
  diffHunk?: string
  replyTo?: number
  commentId?: number
  reviewId?: number
  thread?: PrReviewThread
}

export type PrDetails = {
  body: string
  conversation: PrConversationEntry[]
  checks: Array<{ name: string; state: 'pass' | 'fail' | 'pending'; url: string }>
  mergeTarget?: { branch: string; oid: string }
  headOid?: string
  unresolvedThreads?: number
  fetchedAt?: { metadata: number; conversation: number; checks: number }
  stale?: boolean
  retryAt?: number
  warning?: string
}

export type PrConflicts = {
  state: 'clean' | 'conflicting' | 'not-open'
  baseRefName: string
  headRefName: string
  baseOid: string
  headOid: string
  files: Array<{ path: string; kind: string; content: string | null; truncated: boolean }>
  messages: string[]
  truncated: boolean
  fetchedAt: number
}

export type PrRemoteDiff = {
  base: string
  head: string
  files: Array<{
    path: string
    status: string
    additions: number
    deletions: number
    patch: string | null
  }>
  truncated: boolean
}
