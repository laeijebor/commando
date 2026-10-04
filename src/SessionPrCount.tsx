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
  return <span className="session-pr-preview"><span className="session-pr-count" role="img" aria-label={label} title={label}>
    <GitPullRequest aria-hidden="true" /><span>#{first.number}</span>
    {pullRequests.length > 1 ? <span className="session-pr-more">+{pullRequests.length - 1}</span> : null}
    <i className={`session-pr-readiness ${readiness.tone}`} aria-hidden="true" />
  </span></span>
}

export function SessionPrCards({ paneIds, api, enabled, sessionName, liveTargetIds, onJumpToTarget }: {
  paneIds: string[]
  api: PrsApiClient
  enabled: boolean
  sessionName: string
  liveTargetIds: ReadonlySet<string>
  onJumpToTarget: (targetId: string) => void
}) {
  const { pullRequests, loading, error, truncated, refresh } = useSessionPrs(paneIds, api, { enabled, background: false })
  return <div className="session-open-prs" role="region" aria-label={`Open pull requests in ${sessionName}`}>
    {pullRequests.map((pr) => pr.preview ? <PrCard
      key={`${pr.repo.toLowerCase()}:${pr.number}`} pr={pr.preview} repo={pr.repo}
      viewer={pr.preview.viewerIsAuthor ? pr.preview.author ?? '' : ''} api={api}
      liveTargetIds={liveTargetIds} onJumpToTarget={onJumpToTarget} onMerged={refresh}
    /> : <a className="session-pr-fallback" key={`${pr.repo}:${pr.number}`} href={pr.url} target="_blank" rel="noreferrer">#{pr.number} · {pr.title}</a>)}
    {loading && !pullRequests.length ? <p role="status">Loading open PRs…</p> : null}
    {error ? <p role="alert">{error} <button type="button" onClick={() => { void refresh() }}>Retry</button></p> : null}
    {!loading && !error && !pullRequests.length ? <p>No open pull requests in this session.</p> : null}
    {truncated ? <p>More linked pull requests may be available on GitHub.</p> : null}
  </div>
}
