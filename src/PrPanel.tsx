import { useEffect, useRef, useState } from 'react'
import type { PanePrSummary, PrSummary, PrsApiClient } from './prsApi'
import { cachedPrSummary, markPrMerged, refreshPanePrs } from './prStore'
import { PrQuickLookView, type PrQuickLookTab } from './PrQuickLook'
import { prMergeDisabledReason } from '../shared/pr-merge'

export function PrPanel({ paneId, source, api, visible, selection, onSelectionApplied }: {
  paneId: string
  source: PanePrSummary
  api: PrsApiClient
  visible: boolean
  selection?: { tab: PrQuickLookTab; revision: number }
  onSelectionApplied?(): void
}) {
  const known = source.preview ?? cachedPrSummary(api, source.repo, source.number)
  const [resolved, setResolved] = useState<{ api: PrsApiClient; repo: string; pr: PrSummary } | null>(null)
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  const [merging, setMerging] = useState(false)
  const [mergeError, setMergeError] = useState('')
  const mergeInFlight = useRef(false)
  const fetched = resolved?.api === api && resolved.repo === source.repo && resolved.pr.number === source.number ? resolved.pr : undefined
  const full = known ?? fetched
  // Pane membership and status stay authoritative even when an older daemon omits preview.
  const pr = full ? { ...full, ...source } : undefined
  useEffect(() => {
    if (known || !visible) return
    let active = true
    setError('')
    api.list(source.repo, 'all', { scope: 'everyone', ...(retry ? { refresh: true } : {}) })
      .then((list) => {
        if (!active) return
        const found = list.pullRequests.find((candidate) => candidate.number === source.number)
        if (!found) throw new Error('This PR is unavailable in the repository list. Refresh PR, then retry.')
        setResolved({ api, repo: source.repo, pr: found })
      })
      .catch((cause: unknown) => { if (active) setError(cause instanceof Error ? cause.message : 'Unable to load PR') })
    return () => { active = false }
  }, [api, source.repo, source.number, source.updatedAt, known, visible, retry])
  const refresh = () => refreshPanePrs(api, paneId).then(() => { setRetry((value) => value + 1) })
  const merge = async () => {
    if (!pr || mergeInFlight.current || prMergeDisabledReason(pr)) return
    mergeInFlight.current = true
    setMerging(true)
    setMergeError('')
    try {
      await api.merge(source.repo, pr.number, pr.headRefOid, pr.baseRefName || undefined)
      markPrMerged(api, source.repo, pr.number)
      await refresh()
    } catch (cause) {
      setMergeError(cause instanceof Error ? cause.message : 'Unable to merge pull request')
      await refresh()
    } finally {
      mergeInFlight.current = false
      setMerging(false)
    }
  }
  return <div className="pr-quick-embedded">
    {error ? <p role="alert" className="pr-quick-message">{error} <button type="button" onClick={() => { void refresh() }}>Refresh PR</button></p> : null}
    {pr ? <PrQuickLookView embedded pr={pr} repo={source.repo} api={api} visible={visible} selection={selection} onSelectionApplied={onSelectionApplied} onRefresh={refresh} actions={<>
      <button type="button" className="pr-pop-btn" onClick={() => { void navigator.clipboard?.writeText(String(pr.number)).catch(() => undefined) }}>Copy #</button>
      <button type="button" className="pr-pop-btn" onClick={() => { void navigator.clipboard?.writeText(pr.headRefName).catch(() => undefined) }}>Copy branch</button>
      <button type="button" className="pr-pop-btn" onClick={() => { void navigator.clipboard?.writeText(pr.url).catch(() => undefined) }}>Copy URL</button>
      {pr.state === 'open' ? <button type="button" className="pr-pop-btn primary" disabled={merging || Boolean(prMergeDisabledReason(pr))}
        title={prMergeDisabledReason(pr) ?? 'Merge this pull request on GitHub'} onClick={() => { void merge() }}>{merging ? 'Merging…' : 'Merge PR'}</button> : null}
      {mergeError ? <span className="pr-pop-merge-error" role="alert">{mergeError}</span> : null}
    </>} /> : !error ? <p role="status" className="pr-quick-message">Loading quick look…</p> : null}
  </div>
}
