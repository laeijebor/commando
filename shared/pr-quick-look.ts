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
}

export type PrDetails = {
  body: string
  conversation: PrConversationEntry[]
  checks: Array<{ name: string; state: 'pass' | 'fail' | 'pending'; url: string }>
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
