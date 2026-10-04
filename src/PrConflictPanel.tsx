import { useEffect, useRef, useState } from 'react'
import type { PrConflicts } from '../shared/pr-quick-look'
import type { PrsApiClient } from './prsApi'

export function PrConflictPanel({
  repo,
  number,
  api,
  onLoaded,
}: {
  repo: string
  number: number
  api: PrsApiClient
  onLoaded(value: PrConflicts): void
}) {
  const [result, setResult] = useState<PrConflicts | null>(null)
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  const [path, setPath] = useState('')
  const [filter, setFilter] = useState('')
  const loaded = useRef(onLoaded)
  loaded.current = onLoaded
  useEffect(() => {
    let active = true
    const report = loaded.current
    setResult(null)
    setError('')
    api
      .conflicts(repo, number)
      .then((value) => {
        if (!active) return
        setResult(value)
        setPath(value.files[0]?.path ?? '')
        report(value)
      })
      .catch((cause: unknown) => {
        if (active) setError(cause instanceof Error ? cause.message : 'Unable to inspect merge conflicts')
      })
    return () => {
      active = false
    }
  }, [api, repo, number, retry])

  if (error)
    return (
      <div className="pr-quick-message" role="alert">
        {error}{' '}
        <button type="button" onClick={() => setRetry((value) => value + 1)}>
          Retry conflict inspection
        </button>
      </div>
    )
  if (!result)
    return (
      <div className="pr-quick-message" role="status">
        Inspecting the PR’s actual merge target…
        <p>Simulating a merge in a temporary repository. Your checkout is not changed.</p>
      </div>
    )
  const file = result.files.find((candidate) => candidate.path === path)
  const visible = result.files.filter((candidate) =>
    candidate.path.toLowerCase().includes(filter.toLowerCase()),
  )
  return (
    <div className="pr-conflict-layout">
      <div className="pr-conflict-summary">
        <strong className={result.state === 'conflicting' ? 'fail' : result.state === 'clean' ? 'pass' : ''}>
          {result.state === 'conflicting'
            ? `Merge conflicts${result.files.length ? ` · ${result.files.length} files${result.truncated ? '+' : ''}` : ''}`
            : result.state === 'clean'
              ? 'No merge conflicts'
              : 'PR is merged or closed'}
        </strong>
        <span>
          Actual merge: <code>{result.headRefName}</code> → <code>{result.baseRefName}</code>
        </span>
        <small>
          {result.headOid.slice(0, 7)} into {result.baseOid.slice(0, 7)} · checked{' '}
          {new Date(result.fetchedAt).toLocaleTimeString()}
        </small>
        <button type="button" onClick={() => setRetry((value) => value + 1)}>
          Refresh conflicts
        </button>
        {result.state === 'not-open' ? <p>Conflict inspection applies to open PRs.</p> : null}
        {result.state === 'clean' ? (
          <p>These commits merge cleanly. Checks and review requirements can still block merging.</p>
        ) : null}
        {result.truncated ? (
          <p>Some file previews are limited in size. Resolve the full merge in your checkout.</p>
        ) : null}
        {result.messages.length ? (
          <details open={result.files.length === 0}>
            <summary>Git conflict details</summary>
            <pre>{result.messages.join('\n')}</pre>
          </details>
        ) : null}
      </div>
      {result.state === 'conflicting' && result.files.length > 0 ? (
        <div className="pr-conflict-files-layout">
          <aside className="pr-quick-files">
            <label>
              Conflicting files
              <input
                type="search"
                aria-label="Filter conflicting files"
                value={filter}
                placeholder="Filter paths…"
                onChange={(event) => setFilter(event.target.value)}
              />
            </label>
            {visible.map((candidate) => (
              <button
                type="button"
                key={candidate.path}
                aria-pressed={candidate.path === path}
                onClick={() => setPath(candidate.path)}
              >
                <span>{candidate.path}</span>
                <small className="fail">{candidate.kind}</small>
              </button>
            ))}
            {!visible.length ? <p>No matching conflicting files.</p> : null}
          </aside>
          <div className="pr-quick-diff">
            <header>
              <strong>{file?.path}</strong>
              <span>
                Target: {result.baseRefName} · PR: {result.headRefName}
              </span>
            </header>
            {file?.content != null ? (
              <pre>
                {file.content.split('\n').map((line, index) => (
                  <span
                    key={index}
                    className={
                      /^(<<<<<<<|=======|>>>>>>>|\|\|\|\|\|\|\|)/.test(line)
                        ? 'pr-conflict-marker'
                        : undefined
                    }
                  >
                    {(/^(<<<<<<<|=======|>>>>>>>|\|\|\|\|\|\|\|)/.test(line)
                      ? line
                          .replaceAll(result.baseOid, `Target (${result.baseRefName})`)
                          .replaceAll(result.headOid, `PR (${result.headRefName})`)
                      : line) || ' '}
                  </span>
                ))}
              </pre>
            ) : (
              <p>
                {file?.truncated
                  ? 'This file exceeds the preview size limit.'
                  : 'No text preview is available for this binary, deleted, renamed, or submodule conflict.'}{' '}
                See Git conflict details above.
              </p>
            )}
          </div>
        </div>
      ) : null}
    </div>
  )
}
