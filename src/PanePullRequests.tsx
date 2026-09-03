import { GitMerge, GitPullRequest, X } from 'lucide-react'
import type { PanePrList, PrsApiClient } from './prsApi'
import { usePanePrs } from './prStore'

export function usePanePullRequests(
  paneId: string,
  api: Pick<PrsApiClient, 'pane'>,
  connected: boolean,
  background = false,
): PanePrList | null {
  return usePanePrs(paneId, api, { background, enabled: connected })
}

export function PanePullRequests({
  paneId,
  api,
  connected,
  list: suppliedList,
}: {
  paneId: string
  api: Pick<PrsApiClient, 'pane'>
  connected: boolean
  list?: PanePrList | null
}) {
  const internalList = usePanePullRequests(paneId, api, connected && suppliedList === undefined)
  const list = suppliedList === undefined ? internalList : suppliedList

  if (!list?.pullRequests.length) return null

  return (
    <section className="pane-worklog-prs" aria-label={`Pull requests for pane ${paneId}`}>
      <header><strong>Pull requests</strong><small>{list.pullRequests.length}</small></header>
      <div className="pane-worklog-pr-list">
        {list.pullRequests.map((pullRequest) => (
          <a
            href={pullRequest.url}
            target="_blank"
            rel="noreferrer"
            className={`pane-worklog-pr is-${pullRequest.state}`}
            aria-label={`Open ${pullRequest.isDraft ? 'draft' : pullRequest.state} pull request ${pullRequest.repo} #${pullRequest.number}: ${pullRequest.title}`}
            key={pullRequest.url}
          >
            <span className="pane-worklog-pr-icon" aria-hidden="true">
              {pullRequest.state === 'merged' ? <GitMerge /> : pullRequest.state === 'closed' ? <X /> : <GitPullRequest />}
            </span>
            <span>
              <strong>{pullRequest.title}</strong>
              <small>{pullRequest.repo} #{pullRequest.number} · {pullRequest.isDraft ? 'draft' : pullRequest.state}</small>
            </span>
          </a>
        ))}
      </div>
      {list.truncated ? <p className="pane-worklog-pr-truncated">Additional linked PRs are available on GitHub.</p> : null}
    </section>
  )
}
