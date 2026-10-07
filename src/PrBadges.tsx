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
  const unanswered = pr.unansweredThreads ?? pr.unresolvedThreads
  const replied = pr.unresolvedThreads - unanswered
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
    {pr.stack ? <span className="pr-chip pr-stack-badge" title={`Stack #${pr.stack.number} · PR ${pr.stack.position} of ${pr.stack.size} · ultimately targets ${pr.stack.baseRefName}`}>
      stack #{pr.stack.number} · {pr.stack.position}/{pr.stack.size}
    </span> : null}
    {unanswered > 0 ? (
      <span className="pr-chip warn" title="Open comment threads without replies">{unanswered}{pr.threadsTruncated ? '+' : ''} unanswered</span>
    ) : null}
    {replied > 0 ? (
      <span className="pr-chip replied" title="Open comment threads with replies">{replied}{pr.threadsTruncated ? '+' : ''} unresolved</span>
    ) : null}
    {pr.reviewDecision === 'changes_requested' ? <span className="pr-chip bad">changes requested</span> : null}
    {pr.reviewDecision === 'approved' ? <span className="pr-chip ok">approved</span> : null}
    {pr.conflicting ? <span className="pr-chip bad">⚠ conflicts</span> : null}
  </>
}
