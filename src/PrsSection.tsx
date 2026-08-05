import { useEffect, useMemo, useRef, useState } from 'react'
import { GitPullRequestArrow, Pin, PinOff, Plus, RefreshCw } from 'lucide-react'
import {
  createPrsApi,
  type PrList,
  type PrScope,
  type PrStateFilter,
  type PrSummary,
} from './prsApi'
import './prs-section.css'

export const PRS_POLL_INTERVAL_MS = 30_000

function relativeTime(iso: string): string {
  const then = Date.parse(iso)
  if (!Number.isFinite(then)) return ''
  const seconds = Math.max(0, Math.floor((Date.now() - then) / 1000))
  if (seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d ago`
  return new Date(then).toLocaleDateString()
}

function formatCount(value: number): string {
  return value.toLocaleString('en-US')
}

export function prsNeedAttention(list: PrList | null): boolean {
  if (!list) return false
  return list.pullRequests.some((pr) =>
    pr.state === 'open' && (
      pr.viewerReviewRequested ||
      (pr.viewerIsAuthor && (pr.checks?.state === 'fail' || pr.reviewDecision === 'changes_requested' || pr.conflicting))
    ),
  )
}

function ChecksChip({ checks }: { checks: PrSummary['checks'] }) {
  if (!checks) return <span className="pr-chip dim">no checks</span>
  const label = checks.state === 'fail'
    ? (checks.failed > 0 ? `✗ ${checks.failed} failing` : '✗ checks')
    : checks.state === 'pending' ? (checks.pending > 0 ? `● ${checks.pending} running` : '● running') : '✓ checks'
  const detail = checks.runs
    .filter((run) => run.state !== 'pass')
    .slice(0, 8)
  return (
    <span className={`pr-chip pr-checks ${checks.state}`} tabIndex={0}>
      {label}
      {detail.length > 0 ? (
        <span className="pr-checks-pop" role="tooltip">
          {detail.map((run) => (
            <span key={run.name} className={`pr-checks-run ${run.state}`}>
              {run.state === 'fail' ? '✗' : '●'} {run.name}
            </span>
          ))}
          {checks.truncated ? <span className="pr-checks-run dim">…more on GitHub</span> : null}
        </span>
      ) : null}
    </span>
  )
}

function PrCard({ pr, viewer }: { pr: PrSummary; viewer: string }) {
  const stateLabel = pr.state === 'open' ? (pr.isDraft ? 'Draft' : 'Open') : pr.state === 'merged' ? 'Merged' : 'Closed'
  const stateClass = pr.state === 'open' ? (pr.isDraft ? 'draft' : 'open') : pr.state
  const attention = pr.state === 'open' && (pr.conflicting || (pr.viewerIsAuthor && pr.checks?.state === 'fail'))
  return (
    <article className={`pr-card${attention ? ' attention' : ''}`}>
      <div className="pr-card-top">
        <a className="pr-card-title" href={pr.url} target="_blank" rel="noreferrer">
          <span className="pr-number">#{pr.number}</span>
          {pr.title}
        </a>
        <span className={`pr-state ${stateClass}`}>{stateLabel}</span>
      </div>
      <div className="pr-meta">
        <span className="pr-chip pr-diffstat">
          <span className="plus">+{formatCount(pr.additions)}</span>
          <span className="minus">−{formatCount(pr.deletions)}</span>
        </span>
        <ChecksChip checks={pr.checks} />
        {pr.unresolvedThreads > 0 ? (
          <span className="pr-chip warn">{pr.unresolvedThreads}{pr.threadsTruncated ? '+' : ''} unresolved</span>
        ) : null}
        {pr.reviewDecision === 'changes_requested' ? <span className="pr-chip bad">changes requested</span> : null}
        {pr.reviewDecision === 'approved' ? <span className="pr-chip ok">approved</span> : null}
        {pr.conflicting ? <span className="pr-chip bad">⚠ conflicts</span> : null}
      </div>
      <div className="pr-foot">
        {pr.author && pr.author !== viewer
          ? <span className="pr-author"><span className="pr-avatar">{pr.author.slice(0, 2).toUpperCase()}</span>{pr.author}</span>
          : <span className="pr-branch" title={pr.headRefName}>{pr.headRefName}</span>}
        <span className="pr-time">{relativeTime(pr.updatedAt)}</span>
      </div>
    </article>
  )
}

export function PrsSection({
  token,
  onAttentionChange,
}: {
  token: string
  onAttentionChange?: (attention: boolean) => void
}) {
  const api = useRef(createPrsApi(token)).current
  const [repos, setRepos] = useState<string[]>([])
  const [pinnedRepos, setPinnedRepos] = useState<string[]>([])
  const [repo, setRepo] = useState('')
  const [filter, setFilter] = useState<PrStateFilter>('open')
  const [scope, setScope] = useState<PrScope>('mine')
  const [ready, setReady] = useState(false)
  const [list, setList] = useState<PrList | null>(null)
  const [loading, setLoading] = useState(true)
  const [polling, setPolling] = useState(false)
  const [lastSyncedAt, setLastSyncedAt] = useState(0)
  const [error, setError] = useState('')
  const [errorCode, setErrorCode] = useState('')
  const [addingRepo, setAddingRepo] = useState(false)
  const [repoDraft, setRepoDraft] = useState('')

  useEffect(() => {
    let active = true
    void (async () => {
      try {
        const [prefs, options] = await Promise.all([api.prefs(), api.repos()])
        if (!active) return
        const names = options.map((option) => option.nameWithOwner)
        setRepos(names)
        setPinnedRepos(options.filter((option) => option.pinned).map((option) => option.nameWithOwner))
        setFilter(prefs.lastFilter)
        setScope(prefs.lastScope)
        setRepo(prefs.lastRepo && names.includes(prefs.lastRepo) ? prefs.lastRepo : (prefs.lastRepo ?? names[0] ?? ''))
      } catch (cause) {
        if (!active) return
        setError(cause instanceof Error ? cause.message : 'Unable to load PR settings')
        setLoading(false)
      } finally {
        if (active) setReady(true)
      }
    })()
    return () => { active = false }
  }, [api])

  useEffect(() => {
    if (!ready || !repo) {
      if (ready) setLoading(false)
      return
    }
    let active = true
    let inFlight = false

    const load = async (background: boolean) => {
      if (inFlight || (background && document.visibilityState !== 'visible')) return
      inFlight = true
      if (background) setPolling(true)
      else setLoading(true)
      try {
        const next = await api.list(repo, filter)
        if (!active) return
        setList(next)
        setLastSyncedAt(Date.now())
        setError('')
        setErrorCode('')
      } catch (cause) {
        if (!active) return
        setError(cause instanceof Error ? cause.message : 'Unable to load pull requests')
        setErrorCode((cause as { code?: string }).code ?? '')
      } finally {
        inFlight = false
        if (active) {
          setLoading(false)
          setPolling(false)
        }
      }
    }

    setList(null)
    void load(false)
    const timer = window.setInterval(() => { void load(true) }, PRS_POLL_INTERVAL_MS)
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') void load(true)
    }
    document.addEventListener('visibilitychange', handleVisibility)
    return () => {
      active = false
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', handleVisibility)
    }
  }, [api, ready, repo, filter])

  const attention = useMemo(() => prsNeedAttention(list), [list])
  useEffect(() => { onAttentionChange?.(attention) }, [attention, onAttentionChange])
  useEffect(() => () => { onAttentionChange?.(false) }, [onAttentionChange])

  const groups = useMemo(() => {
    const pullRequests = list?.pullRequests ?? []
    const yours = pullRequests.filter((pr) => pr.viewerIsAuthor)
    const needsReview = pullRequests.filter((pr) => !pr.viewerIsAuthor && pr.viewerReviewRequested)
    const everyone = pullRequests.filter((pr) => !pr.viewerIsAuthor && !pr.viewerReviewRequested)
    return { yours, needsReview, everyone }
  }, [list])

  const changeRepo = (next: string) => {
    setRepo(next)
    void api.updatePrefs({ lastRepo: next }).catch(() => undefined)
  }
  const changeFilter = (next: PrStateFilter) => {
    setFilter(next)
    void api.updatePrefs({ lastFilter: next }).catch(() => undefined)
  }
  const changeScope = (next: PrScope) => {
    setScope(next)
    void api.updatePrefs({ lastScope: next }).catch(() => undefined)
  }
  const togglePin = () => {
    if (!repo) return
    const next = pinnedRepos.includes(repo)
      ? pinnedRepos.filter((pinned) => pinned !== repo)
      : [...pinnedRepos, repo]
    setPinnedRepos(next)
    void api.updatePrefs({ pinnedRepos: next }).catch(() => undefined)
  }
  const addRepo = () => {
    const next = repoDraft.trim()
    if (!/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/.test(next)) {
      setError('Repos look like owner/name')
      return
    }
    setRepoDraft('')
    setAddingRepo(false)
    setRepos((current) => current.includes(next) ? current : [...current, next])
    const pinned = pinnedRepos.includes(next) ? pinnedRepos : [...pinnedRepos, next]
    setPinnedRepos(pinned)
    setError('')
    void api.updatePrefs({ pinnedRepos: pinned, lastRepo: next }).catch(() => undefined)
    setRepo(next)
  }

  const hiddenCount = list ? Math.max(0, list.totalCount - groups.yours.length - groups.needsReview.length) : 0
  const showEveryone = scope === 'everyone'

  return (
    <div className="prs-section">
      <div className="prs-controls">
        <div className="prs-repo-row">
          <select
            className="prs-repo-select"
            aria-label="Repository"
            value={repo}
            onChange={(event) => changeRepo(event.target.value)}
          >
            {repo && !repos.includes(repo) ? <option value={repo}>{repo}</option> : null}
            {repos.map((name) => <option key={name} value={name}>{name}</option>)}
          </select>
          <button
            type="button"
            className="icon-button prs-pin"
            onClick={togglePin}
            disabled={!repo}
            aria-label={pinnedRepos.includes(repo) ? `Unpin ${repo}` : `Pin ${repo}`}
            title={pinnedRepos.includes(repo) ? 'Unpin repo' : 'Pin repo'}
          >
            {pinnedRepos.includes(repo) ? <PinOff aria-hidden="true" /> : <Pin aria-hidden="true" />}
          </button>
          <button
            type="button"
            className="icon-button prs-add"
            onClick={() => setAddingRepo((current) => !current)}
            aria-label="Add a repo"
            aria-expanded={addingRepo}
            title="Add a repo"
          >
            <Plus aria-hidden="true" />
          </button>
        </div>
        {addingRepo ? (
          <form
            className="prs-add-row"
            onSubmit={(event) => { event.preventDefault(); addRepo() }}
          >
            <input
              type="text"
              value={repoDraft}
              placeholder="owner/name"
              aria-label="Repository to add"
              autoFocus
              onChange={(event) => setRepoDraft(event.target.value)}
            />
            <button type="submit">Add</button>
          </form>
        ) : null}
        <div className="prs-filters" role="group" aria-label="Pull request filters">
          {(['open', 'closed', 'all'] as const).map((value) => (
            <button
              key={value}
              type="button"
              className="prs-filter"
              aria-pressed={filter === value}
              onClick={() => changeFilter(value)}
            >
              {value === 'all' ? 'All states' : value}
            </button>
          ))}
          <button
            type="button"
            className="prs-filter prs-scope"
            aria-pressed={showEveryone}
            onClick={() => changeScope(showEveryone ? 'mine' : 'everyone')}
          >
            Everyone&rsquo;s{list ? <span className="count">{formatCount(list.totalCount)}</span> : null}
          </button>
        </div>
      </div>
      <div className="prs-stream">
        {!repo && ready && !loading ? (
          <div className="prs-empty">
            <GitPullRequestArrow aria-hidden="true" />
            <strong>No repo selected</strong>
            <p>Add a repo with the + button, or open a PR somewhere so it shows up in your recent activity.</p>
          </div>
        ) : null}
        {error && !list ? (
          <div className="prs-empty">
            <GitPullRequestArrow aria-hidden="true" />
            <strong>{errorCode === 'auth_required' ? 'GitHub sign-in needed' : 'Pull requests unavailable'}</strong>
            <p>{errorCode === 'auth_required' ? 'Run `gh auth login` on the daemon host, then come back.' : error}</p>
          </div>
        ) : null}
        {loading && !list && !error ? <div className="prs-loading">Loading pull requests…</div> : null}
        {list ? (
          <>
            {groups.yours.length > 0 ? (
              <section className="prs-group" aria-label="Your pull requests">
                <header><strong>Yours</strong><small>{groups.yours.length}</small></header>
                {groups.yours.map((pr) => <PrCard pr={pr} viewer={list.viewer} key={pr.number} />)}
              </section>
            ) : null}
            {groups.needsReview.length > 0 ? (
              <section className="prs-group" aria-label="Pull requests awaiting your review">
                <header><strong>Needs your review</strong><small>{groups.needsReview.length}</small></header>
                {groups.needsReview.map((pr) => <PrCard pr={pr} viewer={list.viewer} key={pr.number} />)}
              </section>
            ) : null}
            {showEveryone && groups.everyone.length > 0 ? (
              <section className="prs-group" aria-label="Everyone's pull requests">
                <header><strong>Everyone&rsquo;s</strong><small>{groups.everyone.length}</small></header>
                {groups.everyone.map((pr) => <PrCard pr={pr} viewer={list.viewer} key={pr.number} />)}
              </section>
            ) : null}
            {!showEveryone && hiddenCount > 0 ? (
              <button type="button" className="prs-reveal" onClick={() => changeScope('everyone')}>
                Everyone&rsquo;s {filter === 'all' ? '' : `${filter} `}PRs · {formatCount(hiddenCount)} · show
              </button>
            ) : null}
            {list.pullRequests.length === 0 ? (
              <div className="prs-empty">
                <GitPullRequestArrow aria-hidden="true" />
                <strong>No {filter === 'all' ? '' : `${filter} `}pull requests</strong>
                <p>Nothing in {list.repo} right now.</p>
              </div>
            ) : showEveryone && list.truncated ? (
              <p className="prs-truncated">Showing {list.pullRequests.length} of {formatCount(list.totalCount)} — the rest are on GitHub.</p>
            ) : null}
          </>
        ) : null}
      </div>
      <footer className="prs-sync">
        <RefreshCw aria-hidden="true" className={polling ? 'spinning' : ''} />
        <span>
          {list ? `synced ${lastSyncedAt ? relativeTime(new Date(lastSyncedAt).toISOString()) : ''}` : 'not synced yet'}
          {list ? ` · gh · ${list.viewer}` : ''}
          {error && list ? ' · stale' : ''}
        </span>
      </footer>
    </div>
  )
}
