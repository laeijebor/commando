export type PrConversationEntry = {
  id: string
  author: string
  body: string
  url: string
  createdAt: string
  kind: string
  path?: string
  line?: number
  replyTo?: number
  commentId?: number
  reviewId?: number
}

export type PrDetails = {
  body: string
  conversation: PrConversationEntry[]
  checks: Array<{ name: string; state: 'pass' | 'fail' | 'pending'; url: string }>
  mergeTarget?: { branch: string; oid: string }
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
