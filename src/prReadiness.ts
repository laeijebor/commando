import { prMergeDisabledReason } from '../shared/pr-merge'
import type { PanePrSummary } from './prsApi'

export function prReadiness(pr: PanePrSummary): { tone: 'red' | 'amber' | 'green' | 'neutral'; label: string } {
  if (pr.conflicting || pr.checks?.state === 'fail') return { tone: 'red', label: pr.conflicting ? 'Merge conflicts' : 'Failed checks' }
  if (pr.unresolvedThreads > 0) return { tone: 'amber', label: `${pr.unresolvedThreads} unresolved ${pr.unresolvedThreads === 1 ? 'comment thread' : 'comment threads'}` }
  if (pr.isDraft) return { tone: 'neutral', label: 'Draft' }
  if (pr.checks?.state === 'pending') return { tone: 'neutral', label: 'Checks running' }
  if (pr.threadsTruncated || pr.checks?.truncated) return { tone: 'neutral', label: 'Additional status on GitHub' }
  if (pr.reviewDecision === 'changes_requested' || pr.reviewDecision === 'review_required') return { tone: 'neutral', label: 'Awaiting review' }
  if (pr.preview && !prMergeDisabledReason(pr.preview)) return { tone: 'green', label: 'Ready to merge' }
  return { tone: 'neutral', label: pr.preview ? prMergeDisabledReason(pr.preview) ?? 'Checking merge readiness' : 'Checking merge readiness' }
}
