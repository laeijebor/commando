import type { MouseEvent, ReactNode } from 'react'
import type { PrQuickLookTab } from './PrQuickLook'
import type { PrStatus } from './prsApi'
import './pr-badges.css'

export type PrChipTab = Extract<PrQuickLookTab, 'Diff' | 'Checks' | 'Conversation' | 'Conflicts'>

/** Turns status chips into links: `url` backs modified clicks on GitHub, `onClick` may open the tab in-app instead. */
export type PrChipLinks = { url: string; onClick: (tab: PrChipTab, event: MouseEvent<HTMLAnchorElement>) => void }

export function PrBadges({ pr, number, onOpenDiff, links, children }: {
  pr: PrStatus
  number: number
  onOpenDiff?: () => void
  links?: PrChipLinks
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
  const truncated = pr.threadsTruncated ? '+' : ''
  const chip = (tab: PrChipTab, className: string, text: string, title?: string, content: ReactNode = text) => {
    if (!links) return <span className={`pr-chip ${className}`} title={title}>{content}</span>
    const path = tab === 'Diff' ? '/files' : tab === 'Checks' ? '/checks' : ''
    return (
      <a className={`pr-chip pr-chip-link ${className}`} href={`${links.url}${path}`} target="_blank" rel="noopener noreferrer"
        aria-label={`Open ${tab.toLowerCase()} for PR #${number}: ${text}`} title={title} onClick={(event) => links.onClick(tab, event)}>{content}</a>
    )
  }

  return <>
    {onOpenDiff ? (
      <button type="button" className="pr-chip pr-diffstat pr-diff-link"
        aria-label={`Open diff for PR #${number}: +${pr.additions} -${pr.deletions}`}
        onClick={onOpenDiff}>{diffstat}</button>
    ) : chip('Diff', 'pr-diffstat', `+${pr.additions} -${pr.deletions}`, undefined, diffstat)}
    {chip('Checks', checks?.state ?? 'dim', checkLabel)}
    {children}
    {pr.stack ? <span className="pr-chip pr-stack-badge" title={`Stack #${pr.stack.number} · PR ${pr.stack.position} of ${pr.stack.size} · ultimately targets ${pr.stack.baseRefName}`}>
      stack #{pr.stack.number} · {pr.stack.position}/{pr.stack.size}
    </span> : null}
    {unanswered > 0 ? chip('Conversation', 'warn', `${unanswered}${truncated} unanswered`, 'Open comment threads without replies') : null}
    {replied > 0 ? chip('Conversation', 'replied', `${replied}${truncated} unresolved`, 'Open comment threads with replies') : null}
    {pr.reviewDecision === 'changes_requested' ? <span className="pr-chip bad">changes requested</span> : null}
    {pr.reviewDecision === 'approved' ? <span className="pr-chip ok">approved</span> : null}
    {pr.conflicting ? chip('Conflicts', 'bad', '⚠ conflicts') : null}
  </>
}
