import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { ExternalLink, X } from 'lucide-react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeRaw from 'rehype-raw'
import rehypeSanitize from 'rehype-sanitize'
import type { PrDetails, PrRemoteDiff } from '../shared/pr-quick-look'
import type { PrSummary, PrsApiClient } from './prsApi'
import './pr-quick-look.css'

const tabs = ['Description', 'Checks', 'Conversation', 'Diff'] as const
type Tab = (typeof tabs)[number]

function MarkdownBody({ body }: { body: string }) {
  return (
    <div className="pr-quick-markdown">
      <Markdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeRaw, rehypeSanitize]}
        components={{ a: (props) => <a {...props} target="_blank" rel="noreferrer" /> }}
      >
        {body}
      </Markdown>
    </div>
  )
}

export function PrQuickLook({
  pr,
  repo,
  api,
  onClose,
  actions,
}: {
  pr: PrSummary
  repo: string
  api: PrsApiClient
  onClose(): void
  actions: ReactNode
}) {
  const [tab, setTab] = useState<Tab>('Description')
  const [details, setDetails] = useState<PrDetails | null>(null)
  const [detailError, setDetailError] = useState('')
  const [diff, setDiff] = useState<PrRemoteDiff | null>(null)
  const [diffError, setDiffError] = useState('')
  const [retry, setRetry] = useState(0)
  const [selectedPath, setSelectedPath] = useState('')
  const [filter, setFilter] = useState('')
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
          'button:not(:disabled), a[href], input, [tabindex="0"]',
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

  useEffect(() => {
    let active = true
    setDetailError('')
    api
      .details(repo, pr.number)
      .then((value) => {
        if (active) setDetails(value)
      })
      .catch((error: unknown) => {
        if (active) setDetailError(error instanceof Error ? error.message : 'Unable to load PR details')
      })
    return () => {
      active = false
    }
  }, [api, repo, pr.number, retry])

  useEffect(() => {
    if (tab !== 'Diff' || diff) return
    let active = true
    setDiffError('')
    api
      .diff(repo, pr.number)
      .then((value) => {
        if (active) {
          setDiff(value)
          setSelectedPath(value.files[0]?.path ?? '')
        }
      })
      .catch((error: unknown) => {
        if (active) setDiffError(error instanceof Error ? error.message : 'Unable to load diff')
      })
    return () => {
      active = false
    }
  }, [tab, api, repo, pr.number, diff, retry])

  const file = diff?.files.find((candidate) => candidate.path === selectedPath)
  const error = tab === 'Diff' ? diffError : detailError
  const checks = details?.checks ?? pr.checks?.runs.map((run) => ({ ...run, url: '' })) ?? []
  return createPortal(
    <div
      className="pr-quick-backdrop"
      data-native-terminal-occluder=""
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <section
        className="pr-quick-modal"
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="pr-quick-title"
      >
        <header className="pr-quick-header">
          <div>
            <span className="pr-quick-repo">
              {repo} · #{pr.number}
            </span>
            <h2 id="pr-quick-title">{pr.title}</h2>
          </div>
          <span className={`pr-state ${pr.isDraft && pr.state === 'open' ? 'draft' : pr.state}`}>
            {pr.isDraft && pr.state === 'open' ? 'Draft' : pr.state}
          </span>
          <button type="button" className="icon-button" aria-label="Close PR quick look" onClick={onClose}>
            <X />
          </button>
        </header>
        <div className="pr-quick-meta">
          <code>{pr.headRefName}</code>
          <span>→</span>
          <code>{pr.baseRefName}</code>
          <span>
            by {pr.author ?? 'unknown'} · {pr.commitCount} commits · {pr.changedFiles} files
          </span>
          <span className="pass">+{pr.additions}</span>
          <span className="fail">−{pr.deletions}</span>
        </div>
        <div className="pr-quick-tabs" role="tablist" aria-label="PR quick look tabs">
          {tabs.map((name, index) => (
            <button
              key={name}
              id={`pr-quick-tab-${name}`}
              type="button"
              role="tab"
              aria-selected={tab === name}
              aria-controls="pr-quick-panel"
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
                document.getElementById(`pr-quick-tab-${tabs[next]}`)?.focus()
              }}
            >
              {name}
              {name === 'Diff' ? <small>vs origin/main</small> : null}
            </button>
          ))}
        </div>
        <div
          className={`pr-quick-panel${tab === 'Diff' ? ' is-diff' : ''}`}
          role="tabpanel"
          id="pr-quick-panel"
          aria-labelledby={`pr-quick-tab-${tab}`}
          tabIndex={0}
        >
          {error ? (
            <div className="pr-quick-message" role="alert">
              {error}{' '}
              <button type="button" onClick={() => setRetry((value) => value + 1)}>
                Retry
              </button>
            </div>
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
              {pr.conflicting ? <p className="fail">This pull request has merge conflicts.</p> : null}
            </>
          ) : null}
          {tab === 'Conversation' && !error ? (
            details ? (
              <>
                <h3>
                  Conversation{' '}
                  <small>
                    {details.conversation.length} entries · {pr.unresolvedThreads} unresolved threads
                  </small>
                </h3>
                {details.conversation.length ? (
                  details.conversation.map((entry) => (
                    <article className="pr-quick-comment" key={entry.id}>
                      <header>
                        <strong>{entry.author}</strong>
                        <span>
                          {entry.kind}
                          {entry.replyTo ? ' · reply' : ''}
                        </span>
                        <a href={entry.url || pr.url} target="_blank" rel="noreferrer">
                          {entry.createdAt ? new Date(entry.createdAt).toLocaleString() : 'View on GitHub'}
                        </a>
                      </header>
                      {entry.path ? (
                        <code>
                          {entry.path}
                          {entry.line ? `:${entry.line}` : ''}
                        </code>
                      ) : null}
                      <MarkdownBody body={entry.body || '_No review body._'} />
                    </article>
                  ))
                ) : (
                  <p>No conversation yet.</p>
                )}
              </>
            ) : (
              <p role="status">Loading conversation…</p>
            )
          ) : null}
          {tab === 'Diff' && !error ? (
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
                    <strong>{file?.path ?? 'Select a file'}</strong>
                    <span title={`${diff.base}…${diff.head}`}>
                      {diff.head.slice(0, 7)} vs origin/main · {diff.base.slice(0, 7)}
                    </span>
                  </header>
                  {file ? (
                    file.patch !== null ? (
                      <pre>
                        {file.patch.split('\n').map((line, index) => (
                          <span
                            key={index}
                            className={
                              line.startsWith('+')
                                ? 'added'
                                : line.startsWith('-')
                                  ? 'removed'
                                  : line.startsWith('@@')
                                    ? 'hunk'
                                    : undefined
                            }
                          >
                            {line || ' '}
                          </span>
                        ))}
                      </pre>
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
      </section>
    </div>,
    document.body,
  )
}
