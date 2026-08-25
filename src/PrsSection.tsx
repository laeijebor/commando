import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { GitPullRequestArrow, Pin, PinOff, Plus, RefreshCw } from 'lucide-react'
import {
  createPrsApi,
  type PrList,
  type PrScope,
  type PrStateFilter,
  type PrSummary,
  type PrThreads,
} from './prsApi'
import './prs-section.css'

export const PRS_POLL_INTERVAL_MS = 30_000
export const PR_HOVER_DELAY_MS = 350
const PR_HOVER_CLOSE_DELAY_MS = 120
const PR_POP_WIDTH = 260
const PR_POP_MAX_CHECKS = 12

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
  return <span className={`pr-chip ${checks.state}`}>{label}</span>
}

function fileName(path: string): string {
  return path.split('/').pop() ?? path
}

function PrPopover({ pr, position, threads, threadsFailed, onEnter, onLeave, targetIsLive, onJumpToTarget }: {
  pr: PrSummary
  position: { top: number; left: number }
  threads: PrThreads | null
  threadsFailed: boolean
  onEnter: () => void
  onLeave: () => void
  targetIsLive: boolean
  onJumpToTarget?: (targetId: string) => void
}) {
  const stateLabel = pr.state === 'open' ? (pr.isDraft ? 'Draft' : 'Open') : pr.state === 'merged' ? 'Merged' : 'Closed'
  const stateClass = pr.state === 'open' ? (pr.isDraft ? 'draft' : 'open') : pr.state
  const pendingReviewers = pr.requestedReviewers.filter((login) => !pr.reviews.some((review) => review.login === login))
  const checkRuns = pr.checks?.runs ?? []
  return createPortal(
    <div
      className="pr-pop"
      data-native-terminal-occluder=""
      style={{ top: position.top, left: position.left, width: PR_POP_WIDTH }}
      role="dialog"
      aria-label={`Details for #${pr.number}`}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
    >
      <div className="pr-pop-head">
        <span className="pr-pop-num">#{pr.number}</span>
        <span className={`pr-state ${stateClass}`}>{stateLabel}</span>
      </div>
      <div className="pr-pop-title">{pr.title}</div>
      {pr.bodyExcerpt ? <p className="pr-pop-body">{pr.bodyExcerpt}</p> : null}
      <div className="pr-pop-row mono">
        <span className="pr-pop-strong">{pr.headRefName}</span>
        <span className="pr-pop-dim">→</span>
        <span>{pr.baseRefName}</span>
      </div>
      <div className="pr-pop-row">
        {pr.createdAt ? `opened ${relativeTime(pr.createdAt)}` : 'opened'}
        {pr.author ? ` by ${pr.author}` : ''} · {formatCount(pr.commitCount)} commits · {formatCount(pr.changedFiles)} files
      </div>
      {pr.reviews.length > 0 || pendingReviewers.length > 0 ? (
        <div className="pr-pop-sec">
          <span className="pr-pop-label">Reviews</span>
          {pr.reviews.map((review) => (
            <span key={review.login} className={`pr-pop-line ${review.state === 'approved' ? 'pass' : 'fail'}`}>
              <span className="pr-pop-glyph">{review.state === 'approved' ? '✓' : '✗'}</span>
              <span>{review.login}</span>
              <span className="pr-pop-dim">{review.state === 'approved' ? 'approved' : 'changes requested'}</span>
            </span>
          ))}
          {pendingReviewers.map((login) => (
            <span key={login} className="pr-pop-line pending">
              <span className="pr-pop-glyph">●</span>
              <span>{login} requested</span>
            </span>
          ))}
        </div>
      ) : null}
      {checkRuns.length > 0 ? (
        <div className="pr-pop-sec">
          <span className="pr-pop-label">
            Checks{pr.checks && pr.checks.failed > 0 ? ` · ${pr.checks.failed} of ${pr.checks.total} failing` : ` · ${checkRuns.length}`}
          </span>
          {checkRuns.slice(0, PR_POP_MAX_CHECKS).map((run) => (
            <span key={run.name} className={`pr-pop-line ${run.state}`}>
              <span className="pr-pop-glyph">{run.state === 'fail' ? '✗' : run.state === 'pending' ? '●' : '✓'}</span>
              <span>{run.name}</span>
            </span>
          ))}
          {checkRuns.length > PR_POP_MAX_CHECKS || pr.checks?.truncated ? (
            <span className="pr-pop-line dim">…more on GitHub</span>
          ) : null}
        </div>
      ) : null}
      {pr.unresolvedThreads > 0 ? (
        <div className="pr-pop-sec">
          <span className="pr-pop-label">Unresolved · {pr.unresolvedThreads}{pr.threadsTruncated ? '+' : ''}</span>
          {threadsFailed ? (
            <span className="pr-pop-line dim">comments unavailable</span>
          ) : !threads ? (
            <span className="pr-pop-line dim">loading comments…</span>
          ) : (
            threads.threads.map((thread, index) => (
              <span key={index} className="pr-pop-thread">
                <span className="pr-pop-strong">{thread.author ?? 'someone'}</span>
                {thread.path ? <span className="pr-pop-dim"> on {fileName(thread.path)}</span> : null}
                {thread.excerpt ? <>: “{thread.excerpt}”</> : null}
              </span>
            ))
          )}
          {threads?.truncated ? <span className="pr-pop-line dim">…more on GitHub</span> : null}
        </div>
      ) : null}
      <div className="pr-pop-actions">
        {targetIsLive && pr.commandoMarker ? (
          <button
            type="button"
            className="pr-pop-btn primary"
            onClick={() => onJumpToTarget?.(pr.commandoMarker!.targetId)}
          >
            Jump to pane
          </button>
        ) : null}
        <a className="pr-pop-btn primary" href={pr.url} target="_blank" rel="noreferrer">Open on GitHub</a>
        <button type="button" className="pr-pop-btn" onClick={() => { void navigator.clipboard?.writeText(String(pr.number)).catch(() => undefined) }}>Copy #</button>
        <button type="button" className="pr-pop-btn" onClick={() => { void navigator.clipboard?.writeText(pr.headRefName).catch(() => undefined) }}>Copy branch</button>
        <button type="button" className="pr-pop-btn" onClick={() => { void navigator.clipboard?.writeText(pr.url).catch(() => undefined) }}>Copy URL</button>
      </div>
    </div>,
    document.body,
  )
}

function PrCard({ pr, viewer, repo, api, liveTargetIds, onJumpToTarget, onOpenDiff }: {
  pr: PrSummary
  viewer: string
  repo: string
  api: ReturnType<typeof createPrsApi>
  liveTargetIds: ReadonlySet<string>
  onJumpToTarget?: (targetId: string) => void
  onOpenDiff?: (pr: PrSummary) => void
}) {
  const stateLabel = pr.state === 'open' ? (pr.isDraft ? 'Draft' : 'Open') : pr.state === 'merged' ? 'Merged' : 'Closed'
  const stateClass = pr.state === 'open' ? (pr.isDraft ? 'draft' : 'open') : pr.state
  const attention = pr.state === 'open' && (pr.conflicting || (pr.viewerIsAuthor && pr.checks?.state === 'fail'))
  const targetId = pr.commandoMarker?.targetId
  const targetIsLive = targetId !== undefined && liveTargetIds.has(targetId)

  const cardRef = useRef<HTMLElement | null>(null)
  const openTimer = useRef<number | null>(null)
  const closeTimer = useRef<number | null>(null)
  const [popover, setPopover] = useState<{ top: number; left: number } | null>(null)
  const [threads, setThreads] = useState<PrThreads | null>(null)
  const [threadsFailed, setThreadsFailed] = useState(false)

  useEffect(() => () => {
    if (openTimer.current !== null) window.clearTimeout(openTimer.current)
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current)
  }, [])

  const openNow = () => {
    const rect = cardRef.current?.getBoundingClientRect()
    if (!rect) return
    // The HUD hugs the right edge, so prefer opening leftward over the pane
    // grid; drop below the card when there is no room.
    const fitsLeft = rect.left >= PR_POP_WIDTH + 18
    setPopover(fitsLeft
      ? { top: Math.max(8, Math.min(rect.top - 8, window.innerHeight - 340)), left: rect.left - PR_POP_WIDTH - 10 }
      : { top: rect.bottom + 6, left: Math.max(8, Math.min(rect.left, window.innerWidth - PR_POP_WIDTH - 8)) })
  }
  const cancelTimers = () => {
    if (openTimer.current !== null) { window.clearTimeout(openTimer.current); openTimer.current = null }
    if (closeTimer.current !== null) { window.clearTimeout(closeTimer.current); closeTimer.current = null }
  }
  const scheduleOpen = () => {
    if (closeTimer.current !== null) { window.clearTimeout(closeTimer.current); closeTimer.current = null }
    if (popover || openTimer.current !== null) return
    openTimer.current = window.setTimeout(() => { openTimer.current = null; openNow() }, PR_HOVER_DELAY_MS)
  }
  const scheduleClose = () => {
    if (openTimer.current !== null) { window.clearTimeout(openTimer.current); openTimer.current = null }
    if (closeTimer.current !== null) return
    closeTimer.current = window.setTimeout(() => { closeTimer.current = null; setPopover(null) }, PR_HOVER_CLOSE_DELAY_MS)
  }
  const keepOpen = () => cancelTimers()

  useEffect(() => {
    if (!popover || pr.unresolvedThreads === 0 || threads || threadsFailed) return
    let active = true
    api.threads(repo, pr.number)
      .then((next) => { if (active) setThreads(next) })
      .catch(() => { if (active) setThreadsFailed(true) })
    return () => { active = false }
  }, [popover, threads, threadsFailed, api, repo, pr.number, pr.unresolvedThreads])

  return (
    <article
      ref={cardRef}
      className={`pr-card${attention ? ' attention' : ''}`}
      onMouseEnter={scheduleOpen}
      onMouseLeave={scheduleClose}
      onFocus={scheduleOpen}
      onBlur={scheduleClose}
    >
      <div className="pr-idrow">
        <span className="pr-number">#{pr.number}</span>
        <span className="pr-idrule" aria-hidden="true" />
        <span className={`pr-state ${stateClass}`}>{stateLabel}</span>
      </div>
      <a className="pr-card-title" href={pr.url} target="_blank" rel="noreferrer">{pr.title}</a>
      {popover ? (
        <PrPopover
          pr={pr}
          position={popover}
          threads={threads}
          threadsFailed={threadsFailed}
          onEnter={keepOpen}
          onLeave={scheduleClose}
          targetIsLive={targetIsLive}
          onJumpToTarget={onJumpToTarget}
        />
      ) : null}
      <div className="pr-meta">
        {targetIsLive && onOpenDiff ? (
          <button
            type="button"
            className="pr-chip pr-diffstat pr-diff-link"
            aria-label={`Open diff for PR #${pr.number}: +${pr.additions} -${pr.deletions}`}
            onClick={() => onOpenDiff(pr)}
          >
            <span className="plus">+{formatCount(pr.additions)}</span>
            <span className="minus">−{formatCount(pr.deletions)}</span>
          </button>
        ) : (
          <span className="pr-chip pr-diffstat">
            <span className="plus">+{formatCount(pr.additions)}</span>
            <span className="minus">−{formatCount(pr.deletions)}</span>
          </span>
        )}
        <ChecksChip checks={pr.checks} />
        {targetIsLive ? (
          <button
            type="button"
            className="pr-chip pr-pane-link"
            aria-label={`Jump to producing pane for PR #${pr.number}`}
            onClick={() => onJumpToTarget?.(targetId)}
          >
            pane
          </button>
        ) : null}
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
  currentPaneId,
  currentPanePath,
  onAttentionChange,
  liveTargetIds = new Set<string>(),
  onJumpToTarget,
  onOpenDiff,
}: {
  token: string
  currentPaneId?: string | null
  currentPanePath?: string | null
  onAttentionChange?: (attention: boolean) => void
  liveTargetIds?: ReadonlySet<string>
  onJumpToTarget?: (targetId: string) => void
  onOpenDiff?: (pr: PrSummary) => void
}) {
  const api = useMemo(() => createPrsApi(token), [token])
  const listCache = useRef(new Map<string, PrList>())
  const repoRef = useRef('')
  const filterRef = useRef<PrStateFilter>('open')
  const manualPaneContext = useRef<string | null>(null)
  const refreshList = useRef<(() => Promise<void>) | null>(null)
  const [repos, setRepos] = useState<string[]>([])
  const [pinnedRepos, setPinnedRepos] = useState<string[]>([])
  const [repo, setRepo] = useState('')
  const [filter, setFilter] = useState<PrStateFilter>('open')
  const [scope, setScope] = useState<PrScope>('mine')
  const [ready, setReady] = useState(false)
  const [list, setList] = useState<PrList | null>(null)
  const [loading, setLoading] = useState(true)
  const [polling, setPolling] = useState(false)
  const [error, setError] = useState('')
  const [errorCode, setErrorCode] = useState('')
  const [addingRepo, setAddingRepo] = useState(false)
  const [repoDraft, setRepoDraft] = useState('')
  repoRef.current = repo
  filterRef.current = filter
  const paneContext = currentPaneId && currentPanePath ? `${currentPaneId}\u0000${currentPanePath}` : ''

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
    manualPaneContext.current = null
    if (!ready || !currentPaneId || !paneContext) return
    let active = true
    let inFlight = false
    let persistedRepo = ''

    const resolvePaneRepo = async () => {
      if (inFlight || manualPaneContext.current === paneContext) return
      inFlight = true
      try {
        const next = await api.repoForPane(currentPaneId)
        if (!active || !next || manualPaneContext.current === paneContext) return
        setRepos((current) => current.some((candidate) => candidate.toLowerCase() === next.toLowerCase())
          ? current
          : [next, ...current])
        const nextKey = next.toLowerCase()
        if (persistedRepo !== nextKey) {
          persistedRepo = nextKey
          void api.updatePrefs({ lastRepo: next }).catch(() => {
            if (active && persistedRepo === nextKey) persistedRepo = ''
          })
        }
        if (repoRef.current.toLowerCase() === nextKey) return
        const cached = listCache.current.get(`${next}::${filterRef.current}`) ?? null
        repoRef.current = next
        setList(cached)
        setLoading(cached === null)
        setRepo(next)
      } catch {
        // Pane repository discovery is best-effort; the manual picker stays usable.
      } finally {
        inFlight = false
      }
    }

    void resolvePaneRepo()
    const timer = window.setInterval(() => { void resolvePaneRepo() }, PRS_POLL_INTERVAL_MS)
    return () => {
      active = false
      window.clearInterval(timer)
    }
  }, [api, currentPaneId, paneContext, ready])

  useEffect(() => {
    if (!ready || !repo) {
      if (ready) setLoading(false)
      return
    }
    let active = true
    let inFlight = false
    const key = `${repo}::${filter}`
    const cached = listCache.current.get(key) ?? null

    const load = async (background: boolean, refresh = false) => {
      if (inFlight || (background && !refresh && document.visibilityState !== 'visible')) return
      inFlight = true
      if (background) setPolling(true)
      else setLoading(true)
      try {
        const next = await api.list(repo, filter, { refresh })
        if (!active) return
        listCache.current.set(key, next)
        setList(next)
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

    const manualRefresh = () => load(true, true)
    refreshList.current = manualRefresh

    setList(cached)
    setError('')
    setErrorCode('')
    void load(cached !== null)
    const timer = window.setInterval(() => { void load(true) }, PRS_POLL_INTERVAL_MS)
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') void load(true)
    }
    document.addEventListener('visibilitychange', handleVisibility)
    return () => {
      active = false
      if (refreshList.current === manualRefresh) refreshList.current = null
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
    if (paneContext) manualPaneContext.current = paneContext
    const cached = listCache.current.get(`${next}::${filter}`) ?? null
    repoRef.current = next
    setList(cached)
    setLoading(cached === null)
    setRepo(next)
    void api.updatePrefs({ lastRepo: next }).catch(() => undefined)
  }
  const changeFilter = (next: PrStateFilter) => {
    const cached = listCache.current.get(`${repo}::${next}`) ?? null
    setList(cached)
    setLoading(cached === null)
    filterRef.current = next
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
                {groups.yours.map((pr) => <PrCard pr={pr} viewer={list.viewer} repo={list.repo} api={api} liveTargetIds={liveTargetIds} onJumpToTarget={onJumpToTarget} onOpenDiff={onOpenDiff} key={pr.number} />)}
              </section>
            ) : null}
            {groups.needsReview.length > 0 ? (
              <section className="prs-group" aria-label="Pull requests awaiting your review">
                <header><strong>Needs your review</strong><small>{groups.needsReview.length}</small></header>
                {groups.needsReview.map((pr) => <PrCard pr={pr} viewer={list.viewer} repo={list.repo} api={api} liveTargetIds={liveTargetIds} onJumpToTarget={onJumpToTarget} onOpenDiff={onOpenDiff} key={pr.number} />)}
              </section>
            ) : null}
            {showEveryone && groups.everyone.length > 0 ? (
              <section className="prs-group" aria-label="Everyone's pull requests">
                <header><strong>Everyone&rsquo;s</strong><small>{groups.everyone.length}</small></header>
                {groups.everyone.map((pr) => <PrCard pr={pr} viewer={list.viewer} repo={list.repo} api={api} liveTargetIds={liveTargetIds} onJumpToTarget={onJumpToTarget} onOpenDiff={onOpenDiff} key={pr.number} />)}
              </section>
            ) : null}
            {list.mineTruncated ? (
              <p className="prs-truncated">Some of your PRs and review requests are not shown — the rest are on GitHub.</p>
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
      <button
        type="button"
        className="prs-sync"
        onClick={() => { void refreshList.current?.() }}
        disabled={!repo || loading || polling}
        aria-label="Resync pull requests"
        title={polling ? 'Syncing pull requests' : 'Resync pull requests'}
      >
        <RefreshCw aria-hidden="true" className={polling ? 'spinning' : ''} />
        <span aria-live="polite">
          {list ? `synced ${relativeTime(new Date(list.fetchedAt).toISOString())}` : 'not synced yet'}
          {list ? ` · gh · ${list.viewer}` : ''}
          {error && list ? ' · stale' : ''}
        </span>
      </button>
    </div>
  )
}
