import { GitPullRequest } from 'lucide-react'
import type { PrsApiClient } from './prsApi'
import { useSessionPrs } from './prStore'
import { PrCard } from './PrsSection'
import { prReadiness } from './prReadiness'

export function SessionPrCount({ paneIds, api, previewApi, enabled, sessionName, liveTargetIds = new Set(), onJumpToTarget }: {
  paneIds: string[]
  api: Pick<PrsApiClient, 'pane'>
  previewApi?: PrsApiClient
  enabled: boolean
  sessionName: string
  liveTargetIds?: ReadonlySet<string>
  onJumpToTarget?: (targetId: string) => void
}) {
  const { pullRequests, refresh } = useSessionPrs(paneIds, api, { enabled })
  const first = pullRequests[0]
  if (!first) return null
  const readiness = prReadiness(first)
  const label = `PR #${first.number} in ${sessionName}: ${readiness.label}${pullRequests.length > 1 ? `; ${pullRequests.length - 1} more open pull request${pullRequests.length > 2 ? 's' : ''}` : ''}`
  if (first.preview && previewApi) return <PrCard
    pr={first.preview} repo={first.repo} viewer={first.preview.viewerIsAuthor ? first.preview.author ?? '' : ''}
    api={previewApi} liveTargetIds={liveTargetIds} onJumpToTarget={onJumpToTarget} onMerged={refresh}
    pill={{ count: pullRequests.length, sessionName, tone: readiness.tone, status: readiness.label }}
    key={`${first.repo}:${first.number}`}
  />
  return <span className="session-pr-preview"><span className={`session-pr-count tone-${readiness.tone}`} role="img" aria-label={label} title={label}>
    <GitPullRequest aria-hidden="true" />
    {pullRequests.length > 1 ? <span className="session-pr-more">{pullRequests.length}</span> : null}
  </span></span>
}

