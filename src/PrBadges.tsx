import type { ReactNode } from 'react'
import type { PrStatus } from './prsApi'
import './pr-badges.css'

export function PrBadges({ pr, number, onOpenDiff, children }: {
  pr: PrStatus
  number: number
  onOpenDiff?: () => void
  children?: ReactNode
}) {
  const diffstat = <>
    <span className="plus">+{pr.additions.toLocaleString('en-US')}</span>
    <span className="minus">−{pr.deletions.toLocaleString('en-US')}</span>
  </>
  const checks = pr.checks
  const checkLabel = !checks ? 'no checks'
    : checks.state === 'fail' ? (checks.failed > 0 ? `✗ ${checks.failed} failing` : '✗ checks')
      : checks.state === 'pending' ? (checks.pending > 0 ? `● ${checks.pending} running` : '● running') : '✓ checks'

  return <>
    {onOpenDiff ? (
      <button type="button" className="pr-chip pr-diffstat pr-diff-link"
        aria-label={`Open diff for PR #${number}: +${pr.additions} -${pr.deletions}`}
        onClick={onOpenDiff}>{diffstat}</button>
    ) : <span className="pr-chip pr-diffstat">{diffstat}</span>}
    <span className={`pr-chip ${checks?.state ?? 'dim'}`}>{checkLabel}</span>
    {children}
    {pr.unresolvedThreads > 0 ? (
      <span className="pr-chip warn">{pr.unresolvedThreads}{pr.threadsTruncated ? '+' : ''} unresolved</span>
    ) : null}
    {pr.reviewDecision === 'changes_requested' ? <span className="pr-chip bad">changes requested</span> : null}
    {pr.reviewDecision === 'approved' ? <span className="pr-chip ok">approved</span> : null}
    {pr.conflicting ? <span className="pr-chip bad">⚠ conflicts</span> : null}
  </>
}
