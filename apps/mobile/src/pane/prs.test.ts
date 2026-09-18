import { prChips } from './prs'

const DETAIL = {
  number: 142,
  state: 'open' as const,
  isDraft: false,
  conflicting: false,
  unresolvedThreads: 2,
  reviewDecision: 'review_required' as const,
  checks: { state: 'pending' as const, failed: 0, pending: 1, total: 4 },
}

describe('pull request chips', () => {
  it('reads the mockup row: running checks, passed checks, review and threads', () => {
    expect(prChips(DETAIL)).toEqual([
      { label: '● 1 running', tone: 'warn' },
      { label: '✓ 3 checks', tone: 'ok' },
      { label: 'review required', tone: 'mute' },
      { label: '2 unresolved', tone: 'mute' },
    ])
  })

  it('leads with failures and flags a conflicting branch', () => {
    expect(prChips({
      ...DETAIL,
      conflicting: true,
      unresolvedThreads: 0,
      reviewDecision: 'approved',
      checks: { state: 'fail', failed: 2, pending: 0, total: 3 },
    })).toEqual([
      { label: '✕ 2 failed', tone: 'bad' },
      { label: '✓ 1 check', tone: 'ok' },
      { label: 'approved', tone: 'ok' },
      { label: 'conflicts', tone: 'bad' },
    ])
  })

  it('shows nothing for a PR the fuller list never described', () => {
    expect(prChips(undefined)).toEqual([])
    expect(prChips({ ...DETAIL, checks: null, reviewDecision: null, unresolvedThreads: 0 })).toEqual([])
  })
})
