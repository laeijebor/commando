import { GitMerge, GitPullRequest, GitPullRequestDraft, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { panePrLink } from '../shared/pane-pr-links'
import { PrBadges } from './PrBadges'
import type { PanePrList } from './prsApi'
import './worklog-pull-requests.css'

/**
 * PRs the pane's session created, pushed to, reviewed or commented on, newest
 * first. A row opens the PR's tab beside the pane, restoring it if it was closed.
 */
export function WorklogPullRequests({ paneId, paneLabel, list, repoForPane, onOpen }: {
  paneId: string
  paneLabel: string
  list: PanePrList | null
  /** The pane's own repo, whose name the rows leave out. */
  repoForPane?: (paneId: string) => Promise<string | null>
  onOpen?: (repo: string, number: number) => void
}) {
  const [paneRepo, setPaneRepo] = useState<string | null>(null)
  const hasPrs = Boolean(list?.pullRequests.length)
  useEffect(() => {
    if (!hasPrs || !repoForPane) return
    let current = true
    repoForPane(paneId).then((repo) => { if (current) setPaneRepo(repo) }, () => undefined)
    return () => { current = false }
  }, [paneId, hasPrs, repoForPane])

  if (!list || !hasPrs) return null
  const rows = list.pullRequests.map((pr) => ({ pr, link: panePrLink(list, pr) }))
    .sort((left, right) => (right.link.at || 0) - (left.link.at || 0))
  return (
    <section className="pane-worklog-prs worklog-prs" aria-label={`Pull requests for ${paneLabel}`}>
      <header><strong>Pull requests</strong><small>{rows.length}</small></header>
      <div className="pane-worklog-pr-list">
        {rows.map(({ pr, link }) => {
          const state = pr.state === 'open' && pr.isDraft ? 'draft' : pr.state
          const otherRepo = pr.repo.toLowerCase() !== paneRepo?.toLowerCase()
          return (
            <button
              type="button"
              className={`pane-worklog-pr is-${state}`}
              key={`${pr.repo}#${pr.number}`}
              disabled={!onOpen}
              onClick={() => onOpen?.(pr.repo, pr.number)}
              title={`Open ${pr.repo}#${pr.number} beside the pane`}
              aria-label={`Open ${state} pull request ${pr.repo} #${pr.number}: ${pr.title} (${link.relation})`}
            >
              <span className="pane-worklog-pr-icon" aria-hidden="true">
                {state === 'merged' ? <GitMerge /> : state === 'closed' ? <X /> : state === 'draft' ? <GitPullRequestDraft /> : <GitPullRequest />}
              </span>
              <span className="pane-worklog-pr-content">
                <strong>#{pr.number} {pr.title}</strong>
                <small>{otherRepo ? `${pr.repo} · ` : ''}{state}</small>
                <span className="pane-worklog-pr-badges"><PrBadges pr={pr} number={pr.number} /></span>
              </span>
              <span className={`worklog-pr-relation is-${link.relation}`}>{link.relation}</span>
            </button>
          )
        })}
      </div>
      {list.truncated ? <p className="pane-worklog-pr-truncated">More linked PRs are on GitHub.</p> : null}
    </section>
  )
}
