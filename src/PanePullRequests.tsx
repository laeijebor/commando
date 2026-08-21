import { GitMerge, GitPullRequest, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import type { PanePrList, PrsApiClient } from './prsApi'

const POLL_INTERVAL_MS = 30_000

export function PanePullRequests({
  paneId,
  api,
  connected,
}: {
  paneId: string
  api: Pick<PrsApiClient, 'pane'>
  connected: boolean
}) {
  const [list, setList] = useState<PanePrList | null>(null)
  const apiRef = useRef(api)
  apiRef.current = api

  useEffect(() => {
    setList(null)
    if (!connected) return
    let cancelled = false
    const refresh = () => {
      if (document.visibilityState === 'hidden') return
      apiRef.current.pane(paneId)
        .then((next) => { if (!cancelled) setList(next) })
        .catch(() => undefined)
    }
    refresh()
    const timer = window.setInterval(refresh, POLL_INTERVAL_MS)
    document.addEventListener('visibilitychange', refresh)
    return () => {
      cancelled = true
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', refresh)
    }
  }, [connected, paneId])

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
