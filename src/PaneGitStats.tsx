import { useEffect, useRef, useState } from 'react'
import { GitDiffModal } from './GitDiffModal'
import type { GitDiffApiClient, GitDiffSummary } from './gitApi'
import './git-diff.css'

const POLL_INTERVAL_MS = 15_000

type Props = {
  paneId: string
  panePath: string
  api: GitDiffApiClient
  connected: boolean
}

export function PaneGitStats({ paneId, panePath, api, connected }: Props) {
  const [summary, setSummary] = useState<GitDiffSummary | null>(null)
  const [open, setOpen] = useState(false)
  const apiRef = useRef(api)
  apiRef.current = api

  useEffect(() => {
    setSummary(null)
    if (!connected) return
    let cancelled = false
    const refresh = () => {
      apiRef.current
        .summary(paneId)
        .then((next) => { if (!cancelled) setSummary(next) })
        .catch(() => { if (!cancelled) setSummary(null) })
    }
    refresh()
    const timer = window.setInterval(refresh, POLL_INTERVAL_MS)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [paneId, panePath, connected])

  if (!summary?.isRepo || summary.target == null) return null

  const files = summary.files ?? []
  const clean = files.length === 0

  return (
    <>
      <button
        type="button"
        className="pane-git-stats"
        onClick={() => setOpen(true)}
        title={`Diff vs ${summary.target} - click to view changed files`}
        aria-label={`Git changes vs ${summary.target}: ${files.length} files, +${summary.additions ?? 0} -${summary.deletions ?? 0}`}
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
      {open ? (
        <GitDiffModal
          paneId={paneId}
          panePath={panePath}
          api={api}
          initialSummary={summary}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  )
}
