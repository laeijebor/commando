import { describe, expect, it } from 'vitest'
import { prReadiness } from './prReadiness'
import type { PanePrSummary, PrSummary } from './prsApi'

const ready = { state: 'open', isDraft: false, conflicting: false, unresolvedThreads: 0, checks: null, reviewDecision: null, preview: { state: 'open', isDraft: false, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' } as PrSummary } as PanePrSummary

describe('PR readiness', () => {
  it('prioritizes conflicts or failed checks over unresolved threads', () => {
    expect(prReadiness({ ...ready, conflicting: true, unresolvedThreads: 3 }).tone).toBe('red')
    expect(prReadiness({ ...ready, checks: { state: 'fail' } as NonNullable<PanePrSummary['checks']>, unresolvedThreads: 3 }).tone).toBe('red')
  })
  it('uses amber for unresolved threads and green only for known merge readiness', () => {
    expect(prReadiness({ ...ready, unresolvedThreads: 1 }).tone).toBe('amber')
    expect(prReadiness(ready).tone).toBe('green')
  })
  it.each([
    { isDraft: true }, { checks: { state: 'pending' } as NonNullable<PanePrSummary['checks']> },
    { reviewDecision: 'review_required' as const }, { reviewDecision: 'changes_requested' as const },
    { preview: undefined }, { preview: { ...ready.preview!, mergeStateStatus: 'BLOCKED' } },
    { preview: { ...ready.preview!, mergeable: 'UNKNOWN' } },
  ])('does not show green for pending or blocked PRs: %j', (overrides) => {
    expect(prReadiness({ ...ready, ...overrides }).tone).toBe('neutral')
  })
})
