import { useRef, useState } from 'react'
import type { PrStack, StackedPrResult } from '../shared/pr-stacks'
import type { PrSummary, PrsApiClient } from './prsApi'
import './pr-stacks.css'

export function PrStackComposer({ repo, prs, api, paneId, onRefresh, onClose, onBusyChange }: {
  repo: string; prs: PrSummary[]; api: PrsApiClient; paneId?: string | null
  onRefresh(): Promise<void>; onClose(): void
  onBusyChange?(busy: boolean): void
}) {
  const [mode, setMode] = useState<'link' | 'new'>('link')
  const [numbers, setNumbers] = useState('')
  const [parent, setParent] = useState('')
  const [head, setHead] = useState('')
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [draft, setDraft] = useState(true)
  const [busy, setBusy] = useState(false)
  const inFlight = useRef(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState<{ stack: PrStack | null; created?: StackedPrResult } | null>(null)
  const candidates = prs.filter((pr) => pr.state === 'open' && (!pr.stack || pr.stack.position === pr.stack.size))
  const selectedParent = candidates.find((pr) => String(pr.number) === parent)
  const submit = async () => {
    if (inFlight.current || result) return
    let ordered: number[] = []
    if (mode === 'link') {
      if (!/^\s*#?\d+(?:[\s,]+#?\d+)+\s*$/.test(numbers)) { setError('Enter at least two PR numbers, separated by commas or spaces'); return }
      ordered = numbers.trim().split(/[\s,]+/).map((value) => Number(value.replace(/^#/, '')))
      if (ordered.length > 100 || ordered.some((value) => !Number.isSafeInteger(value) || value <= 0) || new Set(ordered).size !== ordered.length) {
        setError('Choose 2–100 distinct positive PR numbers'); return
      }
    }
    inFlight.current = true
    setBusy(true)
    onBusyChange?.(true)
    setError('')
    try {
      const next = mode === 'link'
        ? { stack: await api.linkStack(repo, ordered) }
        : await api.createStackedPr(repo, Number(parent), { head: head.trim(), title: title.trim(), body, draft }, paneId ?? undefined).then((created) => ({ stack: created.stack, created }))
      setResult(next)
      // A refresh error must never invite the user to repeat a successful write.
      try { await onRefresh() } catch { setError('Saved on GitHub, but the PR list could not refresh. Resync pull requests.') }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to create stack')
    } finally { inFlight.current = false; setBusy(false); onBusyChange?.(false) }
  }
  return <section className="pr-stack-composer" aria-label="Create a native GitHub stack">
    <header><strong>Create stack</strong><button type="button" className="pr-pop-btn" disabled={busy} onClick={onClose}>Close</button></header>
    <p className="pr-stack-help">Native GitHub preview · {repo}</p>
    {result ? <div role="status">
      {result.created ? <p><a href={result.created.pullRequest.url} target="_blank" rel="noreferrer">PR #{result.created.pullRequest.number} created</a></p> : null}
      {result.stack ? <p>Stack #{result.stack.number} saved · {result.stack.pullRequests.map((pr) => `#${pr.number}`).join(' → ')} → {result.stack.baseRefName}</p> : null}
      {result.created?.warning ? <p className="pr-stack-warning">{result.created.warning}</p> : null}
    </div> : <>
      <div className="prs-filters" role="group" aria-label="Stack creation mode">
        <button type="button" className="prs-filter" disabled={busy} aria-pressed={mode === 'link'} onClick={() => { setMode('link'); setError('') }}>Link existing PRs</button>
        <button type="button" className="prs-filter" disabled={busy} aria-pressed={mode === 'new'} onClick={() => { setMode('new'); setError('') }}>New PR on top</button>
      </div>
      <form onSubmit={(event) => { event.preventDefault(); void submit() }}>
        <fieldset disabled={busy}>
          {mode === 'link' ? <>
            <label>PR numbers · bottom to top<input autoFocus value={numbers} onChange={(event) => setNumbers(event.target.value)} placeholder="12, 15, 18" required /></label>
            <p className="pr-stack-help">Each PR must already target the previous PR&rsquo;s branch. To extend a stack, include all its PRs first. Bases remain unchanged.</p>
            {numbers ? <ol className="pr-stack-preview">{numbers.trim().split(/[\s,]+/).filter(Boolean).map((value, index) => {
              const pr = prs.find((item) => item.number === Number(value.replace(/^#/, '')))
              return <li key={index}>#{value.replace(/^#/, '')}{pr ? <> · {pr.headRefName} → {pr.baseRefName}</> : ' · checked on GitHub when submitted'}</li>
            })}</ol> : null}
          </> : <>
            <label>Parent PR<select value={parent} onChange={(event) => setParent(event.target.value)} required>
              <option value="">Choose an open PR</option>
              {candidates.map((pr) => <option key={pr.number} value={pr.number}>#{pr.number} · {pr.title}</option>)}
            </select></label>
            {!candidates.length ? <p className="pr-stack-help">No open parent PRs in this list. Switch to Open or Everyone&rsquo;s to choose a parent.</p> : null}
            {selectedParent ? <p className="pr-stack-help">New PR targets <code>{selectedParent.headRefName}</code>{selectedParent.stack ? ` · extends stack #${selectedParent.stack.number}` : ''}.</p> : null}
            <label>Already-pushed branch<input value={head} onChange={(event) => setHead(event.target.value)} placeholder="feature/next-layer" required maxLength={250} /></label>
            <label>Title<input value={title} onChange={(event) => setTitle(event.target.value)} required maxLength={256} /></label>
            <label>Description<textarea value={body} onChange={(event) => setBody(event.target.value)} rows={4} maxLength={60_000} /></label>
            <label className="pr-stack-draft"><input type="checkbox" checked={draft} onChange={(event) => setDraft(event.target.checked)} />Create as draft</label>
            <p className="pr-stack-help">Push the branch first. This creates a PR and links it to its parent{paneId ? ', with a marker for the current pane' : ''}.</p>
          </>}
          <button type="submit" className="pr-pop-btn primary" disabled={mode === 'new' && !selectedParent}>{busy ? 'Saving…' : mode === 'link' ? 'Link stack on GitHub' : 'Create stacked PR'}</button>
        </fieldset>
      </form>
    </>}
    {error ? <p role="alert" className="pr-stack-warning">{error}</p> : null}
  </section>
}
