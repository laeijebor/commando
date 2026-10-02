export type PrMergeability = {
  state: string
  isDraft: boolean
  mergeable?: string
  mergeStateStatus?: string
}

export function prMergeDisabledReason(pr: PrMergeability): string | null {
  if (pr.state.toLowerCase() !== 'open') return 'Only open pull requests can be merged'
  if (pr.isDraft) return 'Draft pull requests cannot be merged'
  if (pr.mergeable === 'CONFLICTING' || pr.mergeStateStatus === 'DIRTY') return 'Resolve merge conflicts on GitHub first'
  if (pr.mergeable !== 'MERGEABLE' || !pr.mergeStateStatus || pr.mergeStateStatus === 'UNKNOWN') return 'GitHub is still checking mergeability'
  if (pr.mergeStateStatus === 'BLOCKED') return 'GitHub reports unmet merge requirements'
  if (pr.mergeStateStatus === 'BEHIND') return 'Update this branch before merging'
  if (!['CLEAN', 'HAS_HOOKS', 'UNSTABLE'].includes(pr.mergeStateStatus)) return 'GitHub reports this pull request is not mergeable'
  return null
}
