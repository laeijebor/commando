import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { ExternalLink, X } from 'lucide-react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeRaw from 'rehype-raw'
import rehypeSanitize from 'rehype-sanitize'
import type { PrConflicts, PrConversationEntry, PrDetails, PrRemoteDiff } from '../shared/pr-quick-look'
import { PrConversationPanel } from './PrConversationPanel'
import { refreshPrCommentStatus } from './prStore'
import { PrConflictPanel } from './PrConflictPanel'
import { PrStackPanel } from './PrStackPanel'
import { PrDiffPatch } from './PrDiffPatch'
import { MarkdownPre } from './MarkdownCode'
import type { PrSummary, PrsApiClient } from './prsApi'
import './pr-quick-look.css'

const tabs = ['Description', 'Checks', 'Conversation', 'Diff', 'Conflicts', 'Stack'] as const
export type PrQuickLookTab = (typeof tabs)[number]
type Snapshot<T> = { api: PrsApiClient; references: string; revision: string; value: T; retry?: number }

function MarkdownBody({ body }: { body: string }) {
  return (
    <div className="pr-quick-markdown">
      <Markdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeRaw, rehypeSanitize]}
        components={{ a: (props) => <a {...props} target="_blank" rel="noreferrer" />, pre: MarkdownPre }}
      >
        {body}
      </Markdown>
    </div>
  )
}

function ConversationComment({
  entry,
  prUrl,
  reply,
  detached,
  showPath = true,
}: {
  entry: PrConversationEntry
  prUrl: string
  reply?: boolean
  detached?: boolean
  showPath?: boolean
}) {
  return (
    <>
      <header>
        <strong>{entry.author}</strong>
        <span>
          {reply ? 'reply' : entry.kind}
          {detached ? ' · reply, original comment unavailable' : ''}
        </span>
        <a href={entry.url || prUrl} target="_blank" rel="noreferrer">
          {entry.createdAt ? new Date(entry.createdAt).toLocaleString() : 'View on GitHub'}
        </a>
      </header>
      {showPath && entry.path ? (
        <code>
          {entry.path}
          {entry.line ? `:${entry.line}` : ''}
        </code>
      ) : null}
      <MarkdownBody body={entry.body || '_No review body._'} />
    </>
  )
}

type PrQuickLookProps = {
  pr: PrSummary
  repo: string
  api: PrsApiClient
  actions: ReactNode
  selection?: { tab: PrQuickLookTab; revision: number }
  onRefresh?(): Promise<void>
}

export function PrQuickLook({ onClose, ...props }: PrQuickLookProps & { onClose(): void }) {
  const dialog = useRef<HTMLElement>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    dialog.current?.querySelector<HTMLButtonElement>('button')?.focus()
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        closeRef.current()
        return
      }
      if (event.key !== 'Tab') return
      const controls = [
        ...(dialog.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled), a[href], input:not(:disabled), textarea:not(:disabled), [tabindex="0"]',
        ) ?? []),
      ]
      const first = controls[0]
      const last = controls.at(-1)
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last?.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first?.focus()
      }
    }
    window.addEventListener('keydown', keydown, true)
    return () => {
      window.removeEventListener('keydown', keydown, true)
      previous?.focus()
    }
  }, [])
  return createPortal(
    <div className="pr-quick-backdrop" data-native-terminal-occluder=""
      onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <section className="pr-quick-modal" ref={dialog} role="dialog" aria-modal="true" aria-label={`PR #${props.pr.number}: ${props.pr.title}`}>
        <PrQuickLookView {...props} closeButton={<button type="button" className="icon-button" aria-label="Close PR quick look" onClick={onClose}><X /></button>} />
      </section>
    </div>, document.body,
  )
}

export function PrQuickLookView({ pr, repo, api, actions, onRefresh, closeButton, visible = true, selection, onSelectionApplied, diffView }: PrQuickLookProps & {
  closeButton?: ReactNode
  visible?: boolean
  diffView?: (visible: boolean) => ReactNode
  onSelectionApplied?(): void
}) {
  const id = useId()
  const references = JSON.stringify([
    repo,
    pr.number,
    pr.state,
    pr.headRefName,
    pr.baseRefName,
    pr.headRefOid,
    pr.baseRefOid,
  ])
  const detailRevision = JSON.stringify([
    references,
    pr.updatedAt,
    pr.checks,
    pr.unresolvedThreads,
    pr.unansweredThreads,
    pr.reviewDecision,
    pr.reviews,
    pr.requestedReviewers,
  ])
  const [tab, setTab] = useState<PrQuickLookTab>(selection?.tab ?? 'Description')
  const [diffOpened, setDiffOpened] = useState(tab === 'Diff')
  useEffect(() => { if (tab === 'Diff') setDiffOpened(true) }, [tab])
  useEffect(() => {
    if (!selection) return
    setTab(selection.tab)
    onSelectionApplied?.()
  }, [selection?.revision, selection?.tab])
  const [detailSnapshot, setDetailSnapshot] = useState<Snapshot<PrDetails> | null>(null)
  const [detailError, setDetailError] = useState('')
  const [diffSnapshot, setDiffSnapshot] = useState<Snapshot<PrRemoteDiff> | null>(null)
  const [diffError, setDiffError] = useState('')
  const [retry, setRetry] = useState(0)
  const [selectedPath, setSelectedPath] = useState('')
  const [filter, setFilter] = useState('')
  const [conflictSnapshot, setConflictSnapshot] = useState<Snapshot<PrConflicts> | null>(null)
  // Hide stale data immediately on a new render, including before effects or old requests settle.
  const details =
    detailSnapshot?.api === api && detailSnapshot.revision === detailRevision ? detailSnapshot.value : null
  const diff = diffSnapshot?.api === api && diffSnapshot.revision === references ? diffSnapshot.value : null
  const conflicts =
    conflictSnapshot?.api === api && conflictSnapshot.revision === references ? conflictSnapshot.value : null
  const detailRequest = useRef(0)
  const latest = useRef({ api, references, detailRevision, pr })
  latest.current = { api, references, detailRevision, pr }

  useEffect(() => {
    setDetailSnapshot(null)
    setDiffSnapshot(null)
    setConflictSnapshot(null)
    setDetailError('')
    setDiffError('')
    setSelectedPath('')
  }, [api, references])

  useEffect(() => () => { detailRequest.current += 1 }, [])

  useEffect(() => {
    if (!visible || (details && detailSnapshot?.retry === retry)) return
    let active = true
    const request = ++detailRequest.current
    setDetailError('')
    api
      .details(repo, pr.number)
      .then((value) => {
        if (!active || request !== detailRequest.current) return
        if ((pr.headRefOid && value.headOid !== pr.headRefOid)
          || (pr.baseRefOid && (value.mergeTarget?.oid !== pr.baseRefOid || value.mergeTarget.branch !== pr.baseRefName))) {
          throw new Error('The PR or merge target changed since this card refreshed. Refresh PR, then retry.')
        }
        setDetailSnapshot({ api, references, revision: detailRevision, value, retry })
      })
      .catch((error: unknown) => {
        if (active && request === detailRequest.current) setDetailError(error instanceof Error ? error.message : 'Unable to load PR details')
      })
    return () => {
      active = false
    }
  }, [api, repo, pr.number, references, detailRevision, retry, visible, details])

  useEffect(() => {
    if (diffView !== undefined || !visible || tab !== 'Diff' || (diff && diffSnapshot?.retry === retry)) return
    let active = true
    setDiffError('')
    api
      .diff(repo, pr.number)
      .then((value) => {
        if (active) {
          if (pr.headRefOid && value.head !== pr.headRefOid) throw new Error('The PR head changed since this card refreshed. Refresh PR, then retry.')
          setDiffSnapshot({ api, references, revision: references, value, retry })
          setSelectedPath(value.files[0]?.path ?? '')
        }
      })
      .catch((error: unknown) => {
        if (active) setDiffError(error instanceof Error ? error.message : 'Unable to load diff')
      })
    return () => {
      active = false
    }
  }, [tab, api, repo, pr.number, references, diff, retry, visible, diffView !== undefined])

  const file = diff?.files.find((candidate) => candidate.path === selectedPath)
  const error = tab === 'Diff' ? (diffView !== undefined ? '' : diffError) : detailError
  const checks = details?.checks ?? pr.checks?.runs.map((run) => ({ ...run, url: '' })) ?? []
  const knownTarget =
    detailSnapshot?.api === api && detailSnapshot.references === references
      ? detailSnapshot.value.mergeTarget?.branch
      : undefined
  const mergeTarget = conflicts?.baseRefName ?? knownTarget ?? pr.baseRefName
  const nonMainTarget = Boolean(mergeTarget && mergeTarget !== 'main')
  const hasConflicts = conflicts ? conflicts.state === 'conflicting' : pr.conflicting
  const refreshConversation = async () => {
    const original = latest.current
    // Refresh the shared PR store as well as the full conversation; avoid replaying a write on failure.
    let refreshError: unknown
    try { await Promise.all([onRefresh?.(), refreshPrCommentStatus(api, repo)]) } catch (cause) { refreshError = cause }
    if (latest.current.api !== original.api || latest.current.references !== original.references) return
    const request = ++detailRequest.current
    let value: PrDetails
    try {
      value = await api.details(repo, pr.number)
    } catch (cause) {
      if (latest.current.api === original.api && latest.current.references === original.references && request === detailRequest.current) {
        setDetailError(`Saved on GitHub, but conversation refresh failed: ${cause instanceof Error ? cause.message : 'Unable to refresh'}`)
      }
      throw cause
    }
    if (latest.current.api !== original.api || latest.current.references !== original.references || request !== detailRequest.current) return
    const current = latest.current
    if ((current.pr.headRefOid && value.headOid !== current.pr.headRefOid)
      || (current.pr.baseRefOid && (value.mergeTarget?.oid !== current.pr.baseRefOid || value.mergeTarget.branch !== current.pr.baseRefName))) {
      const message = 'Saved on GitHub, but the PR or merge target changed. Refresh PR, then retry.'
      setDetailError(message)
      throw new Error(message)
    }
    setDetailError('')
    setDetailSnapshot({ api, references: current.references, revision: current.detailRevision, value, retry })
    if (refreshError) throw refreshError
  }
  return (
    <div className="pr-quick-view">
        <header className="pr-quick-header">
          <div>
            <span className="pr-quick-repo">
              {repo} · #{pr.number}
            </span>
            <h2>{pr.title}</h2>
          </div>
          <span className={`pr-state ${pr.isDraft && pr.state === 'open' ? 'draft' : pr.state}`}>
            {pr.isDraft && pr.state === 'open' ? 'Draft' : pr.state}
          </span>
          {closeButton}
        </header>
        <div className="pr-quick-meta">
          <code>{pr.headRefName}</code>
          <span>→</span>
          <span
            className={`pr-quick-target${nonMainTarget ? ' non-main' : ''}`}
            title={`Merge target: ${mergeTarget}`}
          >
            <small>Merge target</small>
            <code>{mergeTarget || 'unknown'}</code>
          </span>
          <span>
            by {pr.author ?? 'unknown'} · {pr.commitCount} commits · {pr.changedFiles} files
          </span>
          <span className="pass">+{pr.additions}</span>
          <span className="fail">−{pr.deletions}</span>
          {pr.stack ? <button type="button" className="pr-pop-btn" onClick={() => setTab('Stack')}>Stack #{pr.stack.number} · {pr.stack.position}/{pr.stack.size}</button> : null}
        </div>
        {nonMainTarget ? (
          <div className="pr-quick-target-warning" role="note">
            <strong>
              Merges into <code>{mergeTarget}</code>, not main.
            </strong>{' '}
            {diffView === undefined ? <>The Diff tab still compares against <code>origin/main</code>; conflict inspection uses{' '}
              <code>{mergeTarget}</code>.</> : <>Diff and conflict inspection use this PR’s merge target.</>}
          </div>
        ) : null}
        {hasConflicts ? (
          <div className="pr-quick-conflict-warning" role="status">
            This PR has merge conflicts against <code>{mergeTarget}</code>.{' '}
            <button type="button" onClick={() => setTab('Conflicts')}>
              View conflicts
            </button>
          </div>
        ) : null}
        <div className="pr-quick-tabs" role="tablist" aria-label="PR quick look tabs">
          {tabs.map((name, index) => (
            <button
              key={name}
              id={`${id}-tab-${name}`}
              type="button"
              role="tab"
              aria-selected={tab === name}
              aria-controls={`${id}-panel`}
              tabIndex={tab === name ? 0 : -1}
              onClick={() => setTab(name)}
              onKeyDown={(event) => {
                const next =
                  event.key === 'ArrowRight'
                    ? (index + 1) % tabs.length
                    : event.key === 'ArrowLeft'
                      ? (index + tabs.length - 1) % tabs.length
                      : event.key === 'Home'
                        ? 0
                        : event.key === 'End'
                          ? tabs.length - 1
                          : -1
                if (next < 0) return
                event.preventDefault()
                setTab(tabs[next])
                document.getElementById(`${id}-tab-${tabs[next]}`)?.focus()
              }}
            >
              {name}
              {name === 'Diff' && diffView === undefined ? <small>vs origin/main</small> : null}
              {name === 'Conflicts' && hasConflicts ? <small className="fail">!</small> : null}
            </button>
          ))}
        </div>
        <div
          className={`pr-quick-panel${tab === 'Diff' && diffView !== undefined ? ' is-comparison' : tab === 'Diff' || tab === 'Conflicts' ? ' is-diff' : ''}`}
          role="tabpanel"
          id={`${id}-panel`}
          aria-labelledby={`${id}-tab-${tab}`}
          tabIndex={0}
        >
          {error && tab !== 'Conflicts' && tab !== 'Stack' ? (
            <div className="pr-quick-message" role="alert">
              {error}{' '}
              <button type="button" onClick={() => setRetry((value) => value + 1)}>
                Retry
              </button>
              {onRefresh ? <button type="button" onClick={() => { void onRefresh().then(() => setRetry((value) => value + 1)) }}>Refresh PR</button> : null}
            </div>
          ) : null}
          {tab === 'Stack' ? <PrStackPanel key={`${repo}:${pr.number}:${pr.stack?.number ?? ''}`} repo={repo} pr={pr} api={api} /> : null}
          {tab === 'Conflicts' ? (
            <PrConflictPanel
              key={references}
              repo={repo}
              number={pr.number}
              api={api}
              onLoaded={(value) => setConflictSnapshot({ api, references, revision: references, value })}
              expected={{ headOid: pr.headRefOid, baseRefName: pr.baseRefName }}
              onRefresh={onRefresh}
            />
          ) : null}
          {tab === 'Description' && !error ? (
            details ? (
              <MarkdownBody body={details.body || '_No description provided._'} />
            ) : (
              <p role="status">Loading full description…</p>
            )
          ) : null}
          {tab === 'Checks' ? (
            <>
              <h3>Check status</h3>
              {checks.length ? (
                checks.map((run, index) => (
                  <div className={`pr-quick-check ${run.state}`} key={`${run.name}:${index}`}>
                    <span>{run.state === 'pass' ? '✓' : run.state === 'fail' ? '✗' : '●'}</span>
                    <strong>
                      {run.url ? (
                        <a href={run.url} target="_blank" rel="noreferrer">
                          {run.name}
                        </a>
                      ) : (
                        run.name
                      )}
                    </strong>
                    <span>
                      {run.state === 'pending'
                        ? 'running / queued'
                        : run.state === 'pass'
                          ? 'passed'
                          : 'failed'}
                    </span>
                  </div>
                ))
              ) : (
                <p>No checks reported.</p>
              )}
              {!details && !error ? <p role="status">Loading full check status…</p> : null}
              <h3>Reviews</h3>
              {pr.reviews.map((review) => (
                <div
                  className={`pr-quick-check ${review.state === 'approved' ? 'pass' : 'fail'}`}
                  key={review.login}
                >
                  <strong>{review.login}</strong>
                  <span>{review.state.replaceAll('_', ' ')}</span>
                </div>
              ))}
              {pr.requestedReviewers
                .filter((login) => !pr.reviews.some((review) => review.login === login))
                .map((login) => (
                  <div className="pr-quick-check pending" key={login}>
                    {login} · review requested
                  </div>
                ))}
              {!pr.reviews.length && !pr.requestedReviewers.length ? <p>No reviews yet.</p> : null}
              {hasConflicts ? (
                <p className="fail">This pull request has merge conflicts against {mergeTarget}.</p>
              ) : null}
            </>
          ) : null}
          <div hidden={tab !== 'Conversation' || Boolean(error)}>
            <PrConversationPanel key={`${repo}:${pr.number}`} details={details} unresolvedThreads={pr.unresolvedThreads}
              repo={repo} number={pr.number} api={api} onChanged={refreshConversation}
              renderComment={(entry, options) => <ConversationComment entry={entry} prUrl={pr.url} {...options} />} />
          </div>
          {diffOpened && diffView !== undefined ? <div className="pr-quick-comparison" hidden={tab !== 'Diff'}>
            {diffView(visible && tab === 'Diff')}
          </div> : null}
          {tab === 'Diff' && diffView === undefined && !error ? (
            diff ? (
              <>
                <aside className="pr-quick-files">
                  <label>
                    Changed files
                    <input
                      type="search"
                      aria-label="Filter diff files"
                      placeholder="Filter paths…"
                      value={filter}
                      onChange={(event) => setFilter(event.target.value)}
                    />
                  </label>
                  {diff.truncated ? (
                    <p>
                      GitHub limits comparisons to 300 files.{' '}
                      <a href={`${pr.url}/files`} target="_blank" rel="noreferrer">
                        View all on GitHub
                      </a>
                      .
                    </p>
                  ) : null}
                  {!diff.files.length ? <p>No changes vs origin/main.</p> : null}
                  {diff.files
                    .filter((candidate) => candidate.path.toLowerCase().includes(filter.toLowerCase()))
                    .map((candidate) => (
                      <button
                        type="button"
                        key={candidate.path}
                        aria-pressed={candidate.path === selectedPath}
                        onClick={() => setSelectedPath(candidate.path)}
                      >
                        <span>{candidate.path}</span>
                        <small>
                          <em className="pass">+{candidate.additions}</em>{' '}
                          <em className="fail">−{candidate.deletions}</em>
                        </small>
                      </button>
                    ))}
                  {diff.files.length > 0 &&
                  !diff.files.some((candidate) =>
                    candidate.path.toLowerCase().includes(filter.toLowerCase()),
                  ) ? (
                    <p>No matching files.</p>
                  ) : null}
                </aside>
                <div className="pr-quick-diff">
                  <header>
                    <strong title={file?.path}>{file?.path ?? 'Select a file'}</strong>
                    <span title={`${diff.base}…${diff.head}`}>
                      {diff.head.slice(0, 7)} vs origin/main · {diff.base.slice(0, 7)}
                    </span>
                  </header>
                  {file ? (
                    file.patch !== null ? (
                      <PrDiffPatch key={`${references}:${file.path}`} path={file.path} patch={file.patch} api={api} />
                    ) : (
                      <p>
                        GitHub did not provide a text patch for this file (binary or too large).{' '}
                        <a href={`${pr.url}/files`} target="_blank" rel="noreferrer">
                          View on GitHub
                        </a>
                        .
                      </p>
                    )
                  ) : null}
                </div>
              </>
            ) : (
              <p className="pr-quick-message" role="status">
                Loading diff against origin/main…
              </p>
            )
          ) : null}
        </div>
        <footer className="pr-quick-actions">
          {actions}
          <a className="pr-pop-btn primary" href={pr.url} target="_blank" rel="noreferrer">
            <ExternalLink aria-hidden="true" /> Open on GitHub
          </a>
        </footer>
    </div>
  )
}
