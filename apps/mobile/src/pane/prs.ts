/**
 * `GET /api/prs/pane` says which pull requests a pane is working on, but it
 * carries only the identity fields. The checks, the review decision and the
 * unresolved-thread count the mockup shows live on the fuller `GET /api/prs`
 * list, so the sheet asks for that too and joins the two by number.
 */

export type PrCheckState = 'pass' | 'fail' | 'pending'

export type PrChecks = {
  state: PrCheckState
  failed: number
  pending: number
  total: number
} | null

export type PrDetail = {
  number: number
  state: 'open' | 'merged' | 'closed'
  isDraft: boolean
  conflicting: boolean
  unresolvedThreads: number
  reviewDecision: 'approved' | 'changes_requested' | 'review_required' | null
  checks: PrChecks
}

export type PrChip = { label: string; tone: 'ok' | 'warn' | 'bad' | 'mute' }

const REVIEW_LABELS: Record<NonNullable<PrDetail['reviewDecision']>, PrChip> = {
  approved: { label: 'approved', tone: 'ok' },
  changes_requested: { label: 'changes requested', tone: 'bad' },
  review_required: { label: 'review required', tone: 'mute' },
}

/** The chip row under a pull request title: checks, review, threads, conflicts. */
export function prChips(detail: PrDetail | undefined): PrChip[] {
  if (!detail) return []
  const chips: PrChip[] = []
  const checks = detail.checks
  if (checks) {
    const passed = checks.total - checks.failed - checks.pending
    if (checks.failed) chips.push({ label: `✕ ${checks.failed} failed`, tone: 'bad' })
    if (checks.pending) chips.push({ label: `● ${checks.pending} running`, tone: 'warn' })
    if (passed > 0) chips.push({ label: `✓ ${passed} ${passed === 1 ? 'check' : 'checks'}`, tone: 'ok' })
  }
  if (detail.reviewDecision) chips.push(REVIEW_LABELS[detail.reviewDecision])
  if (detail.unresolvedThreads > 0) {
    chips.push({ label: `${detail.unresolvedThreads} unresolved`, tone: 'mute' })
  }
  if (detail.conflicting) chips.push({ label: 'conflicts', tone: 'bad' })
  return chips
}
