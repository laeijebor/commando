import { usePaneGitSummary } from './paneGitStore'
import { hasPaneChanges } from './sidePanelState'
import type { GitDiffApiClient } from './gitApi'
import './git-diff.css'

type Props = {
  paneId: string
  panePath: string
  api: GitDiffApiClient
  connected: boolean
  onOpenChanges?: () => void
}

export function PaneGitStats({ paneId, panePath, api, connected, onOpenChanges }: Props) {
  const summary = usePaneGitSummary(paneId, panePath, api, connected)

  if (!summary?.isRepo) return null

  const files = summary.files ?? []
  const clean = files.length === 0
  const target = summary.target
  const pullRequest = summary.pullRequest
  if (target == null && !pullRequest) return null

  return (
    <>
      {target != null ? (
        <button
          type="button"
          className="pane-git-stats"
          disabled={!hasPaneChanges(summary)}
          onClick={onOpenChanges}
          title={`Diff vs ${target} - click to view changed files`}
          aria-label={`Git changes vs ${target}: ${files.length} files, +${summary.additions ?? 0} -${summary.deletions ?? 0}`}
        >
          {clean ? (
            <span className="git-clean">clean</span>
          ) : (
            <>
              <span className="added">+{summary.additions ?? 0}</span>
              <span className="deleted">-{summary.deletions ?? 0}</span>
              <span className="count">{files.length}</span>
            </>
          )}
        </button>
      ) : null}
      {pullRequest ? (
        <a
          className="pane-pull-request"
          href={pullRequest.url}
          target="_blank"
          rel="noopener noreferrer"
          title={`${pullRequest.isDraft ? 'Draft PR' : 'PR'} #${pullRequest.number}: ${pullRequest.title}`}
          aria-label={`Open ${pullRequest.isDraft ? 'draft ' : ''}pull request #${pullRequest.number}: ${pullRequest.title}`}
        >
          PR #{pullRequest.number}
        </a>
      ) : null}

    </>
  )
}
