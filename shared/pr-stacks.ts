export type PrStackMembership = { number: number; position: number; size: number; baseRefName: string }

export type PrStack = {
  number: number
  baseRefName: string
  open: boolean
  pullRequests: Array<{
    number: number
    state: 'open' | 'merged' | 'closed'
    isDraft: boolean
    headRefName: string
    url: string
  }>
}

export type NewStackedPr = { head: string; title: string; body: string; draft: boolean }
export type StackedPrResult = {
  pullRequest: { number: number; url: string }
  stack: PrStack | null
  warning?: string
}
