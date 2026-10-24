import { useEffect, useRef, useState, type MouseEvent } from 'react'
import { CheckCircle2, ChevronDown, ChevronRight, CircleDashed, CircleMinus, ExternalLink, GitMerge, GitPullRequest, Undo2, X, XCircle } from 'lucide-react'
import type { PrAutofixStatus } from '../../shared/pr-types'
import { prMergeDisabledReason } from '../../shared/pr-merge'
import type { PanePrSummary, PrsApiClient } from '../prsApi'
import { usePanePullRequests } from '../PanePullRequests'
import { PrBadges } from '../PrBadges'
import type { PrQuickLookTab } from '../PrQuickLook'
import { cachedPrSummary, markPrMerged, refreshPanePrs } from '../prStore'
import { Button } from './ui/button'
import { Popover, PopoverPopup, PopoverTrigger } from './ui/popover'

type StripApi = Pick<PrsApiClient, 'pane' | 'list' | 'merge' | 'autofixStatus' | 'setAutofix'> & Partial<Pick<PrsApiClient, 'storeKey'>>

export const DISMISSED_PRS_STORAGE_KEY = 'commando.chat.dismissed-prs'
export const MINIMISED_PR_STRIPS_STORAGE_KEY = 'commando.chat.minimised-pr-strips'
const MAX_STORED_KEYS = 200

function storedKeys(storageKey: string): string[] {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(storageKey) ?? '[]')
    return Array.isArray(parsed) ? parsed.filter((key): key is string => typeof key === 'string').slice(-MAX_STORED_KEYS) : []
  } catch {
    return []
  }
}

function storeKeys(storageKey: string, keys: string[]): void {
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(keys.slice(-MAX_STORED_KEYS)))
  } catch {
    // The strip still works in memory when storage is unavailable.
  }
}

function stripSummary(prs: PanePrSummary[]): string {
  const count = (state: PanePrSummary['state']) => prs.filter((pr) => pr.state === state).length
  const failing = prs.filter((pr) => pr.state === 'open' && pr.checks?.state === 'fail').length
  return [
    `${prs.length} PRs`,
    ...(['open', 'merged', 'closed'] as const).flatMap((state) => count(state) ? [`${count(state)} ${state}`] : []),
    ...(failing ? [`${failing} failing`] : []),
  ].join(' · ')
}

export function autofixStatusText(status: PrAutofixStatus | null): string {
  if (!status) return 'Enable to watch CI failures and new comments'
  if (status.status === 'watching') return 'Watching for CI failures and new comments'
  if (status.status === 'fix-requested') return `Fix requested · round ${status.rounds}/5`
  if (status.status === 'capped') return 'Stopped after 5 rounds'
  return `Stopped${status.reason ? ` · ${status.reason}` : ''}`
}

function CiPopover({ pr, paneId, api, connected }: { pr: PanePrSummary; paneId: string; api: StripApi; connected: boolean }) {
  const [open, setOpen] = useState(false)
  const [status, setStatus] = useState<PrAutofixStatus | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const writing = useRef(false)
  const generation = useRef(0)
  useEffect(() => {
    if (!open || !connected) return
    let cancelled = false
    let loading = false
    const load = async () => {
      if (writing.current || loading) return
      loading = true
      const version = generation.current
      try {
        const next = await api.autofixStatus(pr.repo, pr.number)
        if (!cancelled && version === generation.current) { setStatus(next); setLoaded(true); setError('') }
      } catch (error) {
        if (!cancelled && version === generation.current) setError(error instanceof Error ? error.message : String(error))
      } finally { loading = false }
    }
    void load()
    const timer = window.setInterval(() => { void load() }, 15_000)
    return () => { cancelled = true; window.clearInterval(timer) }
  }, [open, connected, api, pr.repo, pr.number])

  const toggle = async (enabled: boolean) => {
    writing.current = true
    generation.current++
    setSaving(true)
    setError('')
    try { setStatus(await api.setAutofix(pr.repo, pr.number, enabled, paneId)) }
    catch (error) { setError(error instanceof Error ? error.message : String(error)) }
    finally { writing.current = false; setSaving(false) }
  }
  const [merging, setMerging] = useState(false)
  const [mergeError, setMergeError] = useState('')
  const mergeInFlight = useRef(false)
  // Pane status stays authoritative; the preview supplies GitHub's mergeability and head commit.
  const full = pr.preview ?? cachedPrSummary(api, pr.repo, pr.number)
  const mergeTarget = full ? { ...full, ...pr } : undefined
  const mergeBlocked = !connected ? 'Disconnected' : mergeTarget ? prMergeDisabledReason(mergeTarget) : 'Checking merge readiness'
  const merge = async () => {
    if (!mergeTarget || mergeInFlight.current || mergeBlocked) return
    mergeInFlight.current = true
    setMerging(true)
    setMergeError('')
    try {
      await api.merge(pr.repo, pr.number, mergeTarget.headRefOid, mergeTarget.baseRefName || undefined)
      markPrMerged(api, pr.repo, pr.number)
    } catch (error) {
      setMergeError(error instanceof Error ? error.message : 'Unable to merge pull request')
    } finally {
      mergeInFlight.current = false
      setMerging(false)
      await refreshPanePrs(api, paneId).catch(() => undefined)
    }
  }
  const checks = pr.checks
  const skipped = checks?.skipped ?? checks?.runs.filter((run) => run.skipped).length ?? 0
  const counts = [
    { label: 'Passed', count: checks ? Math.max(0, checks.total - checks.failed - checks.pending - skipped) : 0, Icon: CheckCircle2, className: 'text-success' },
    { label: 'Failed', count: checks?.failed ?? 0, Icon: XCircle, className: 'text-destructive' },
    { label: 'Pending', count: checks?.pending ?? 0, Icon: CircleDashed, className: 'text-warning' },
    { label: 'Skipped', count: skipped, Icon: CircleMinus, className: 'text-muted-foreground' },
  ]
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger className="chat-pr-ci" aria-label={`CI monitoring for PR #${pr.number}`}>
        CI <ChevronDown className="size-3" />
      </PopoverTrigger>
      <PopoverPopup align="end" className="w-[290px] p-3" aria-label={`CI monitoring for PR #${pr.number}`}>
        <div className="flex items-center justify-between gap-2 mb-3">
          <strong>CI monitoring</strong>
          <a href={`${pr.url}/checks`} target="_blank" rel="noopener noreferrer" aria-label={`Open checks for PR #${pr.number}`} className="p-1 rounded-sm hover:bg-accent"><ExternalLink className="size-4" /></a>
        </div>
        {counts.filter((row) => row.count > 0).map(({ label, count, Icon, className }) => (
          <div key={label} className="flex items-center gap-2 py-1"><Icon className={`size-4 ${className}`} /><span>{label}</span><span className="ml-auto font-mono">{count}</span></div>
        ))}
        {!checks ? <p className="text-muted-foreground">No checks reported</p> : null}
        {checks?.truncated ? <p className="text-xs text-muted-foreground">More checks on GitHub</p> : null}
        <div className="border-t mt-3 pt-3">
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" className="chat-pr-autofix-toggle" checked={status?.enabled ?? false} disabled={!connected || !loaded || saving} onChange={(event) => { void toggle(event.target.checked) }} />
            <span>Auto-fix CI &amp; address comments</span>
          </label>
          <p className="mt-2 text-xs text-muted-foreground" role="status">{loaded ? autofixStatusText(status) : connected ? 'Loading monitoring status…' : 'Disconnected'}</p>
          {status?.lastEventAt ? <time className="block mt-1 text-xs text-muted-foreground" dateTime={new Date(status.lastEventAt).toISOString()}>Last event: {new Date(status.lastEventAt).toLocaleString()}</time> : null}
          {error ? <p className="mt-2 text-xs text-destructive" role="alert">{error}</p> : null}
        </div>
        <div className="border-t mt-3 pt-3">
          <Button size="sm" className="w-full" disabled={merging || Boolean(mergeBlocked)} title={mergeBlocked ?? 'Merge this pull request on GitHub'}
            onClick={() => { void merge() }}><GitMerge className="size-4" />{merging ? 'Merging…' : 'Merge PR'}</Button>
          {mergeBlocked && !merging ? <p className="mt-2 text-xs text-muted-foreground">{mergeBlocked}</p> : null}
          {mergeError ? <p className="mt-2 text-xs text-destructive" role="alert">{mergeError}</p> : null}
        </div>
      </PopoverPopup>
    </Popover>
  )
}

export function PrStrip({ paneId, api, connected, onOpenPr }: { paneId: string; api: StripApi; connected: boolean; onOpenPr?: (repo: string, number: number, tab: PrQuickLookTab) => void }) {
  const list = usePanePullRequests(paneId, api, connected)
  const [expanded, setExpanded] = useState(false)
  const [dismissed, setDismissed] = useState(() => storedKeys(DISMISSED_PRS_STORAGE_KEY))
  const [minimisedStrips, setMinimisedStrips] = useState(() => storedKeys(MINIMISED_PR_STRIPS_STORAGE_KEY))
  if (!list?.pullRequests.length) return null
  const openInPanel = (event: MouseEvent<HTMLAnchorElement>, pr: PanePrSummary, tab: PrQuickLookTab) => {
    // Modified clicks keep the browser's open-in-new-tab behaviour.
    if (!onOpenPr || event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return
    event.preventDefault()
    onOpenPr(pr.repo, pr.number, tab)
  }
  // Keyed by the pane's stable target so a reused tmux pane id starts clean.
  const dismissKey = (pr: PanePrSummary) => `${list.targetId}:${pr.repo}#${pr.number}`
  const updateDismissed = (keys: string[]) => { setDismissed(keys); storeKeys(DISMISSED_PRS_STORAGE_KEY, keys) }
  const prs = [...list.pullRequests].sort((left, right) => Number(right.state === 'open') - Number(left.state === 'open'))
  // A single PR is already one line, so only longer lists get the minimise header.
  const minimisable = prs.length > 1
  const minimised = minimisable && minimisedStrips.includes(list.targetId)
  const toggleMinimised = () => {
    const keys = minimised ? minimisedStrips.filter((key) => key !== list.targetId) : [...minimisedStrips, list.targetId]
    setMinimisedStrips(keys)
    storeKeys(MINIMISED_PR_STRIPS_STORAGE_KEY, keys)
  }
  const shown = prs.filter((pr) => !dismissed.includes(dismissKey(pr)))
  const hidden = prs.filter((pr) => dismissed.includes(dismissKey(pr)))
  const restore = (pr: PanePrSummary) => {
    updateDismissed(dismissed.filter((key) => key !== dismissKey(pr)))
    if (hidden.length === 1) setExpanded(false)
  }
  return (
    <section className="chat-pr-strip" aria-label="Linked pull requests">
      {minimisable ? (
        <button type="button" className="chat-pr-toggle" aria-expanded={!minimised} title={minimised ? 'Show pull requests' : 'Minimise pull requests'} onClick={toggleMinimised}>
          {minimised ? <ChevronRight className="size-3.5" /> : <ChevronDown className="size-3.5" />}
          <span>{stripSummary(prs)}</span>
        </button>
      ) : null}
      {minimised ? null : <>
        {(expanded ? [...shown, ...hidden] : shown).map((pr) => {
          const Icon = pr.state === 'merged' ? GitMerge : GitPullRequest
          const isDismissed = hidden.includes(pr)
          return (
            <div key={`${pr.repo}#${pr.number}`} className={`chat-pr-row ${pr.state}${isDismissed ? ' dismissed' : ''}`}>
              <Icon className="size-4 shrink-0" />
              <span className="chat-pr-link" title={`${pr.repo}#${pr.number}: ${pr.title}`}>
                <a className="font-mono shrink-0" href={pr.url} target="_blank" rel="noopener noreferrer"
                  aria-label={`Open PR #${pr.number} on GitHub`}>#{pr.number}</a>
                <a className="truncate" href={pr.url} target="_blank" rel="noopener noreferrer"
                  onClick={(event) => openInPanel(event, pr, 'Description')}>{pr.title}</a>
              </span>
              {pr.state === 'open' ? <>
                {/* The same shared PR status the HUD shows, updated as any view refreshes it. */}
                <span className="chat-pr-badges">
                  <PrBadges pr={pr} number={pr.number} {...(onOpenPr ? { links: { url: pr.url, onClick: (tab, event) => openInPanel(event, pr, tab) } } : {})} />
                  <CiPopover pr={pr} paneId={paneId} api={api} connected={connected} />
                </span>
              </> : <>
                <span className="chat-pr-diff"><span className="text-success">+{pr.additions.toLocaleString('en-US')}</span> <span className="text-destructive">−{pr.deletions.toLocaleString('en-US')}</span></span>
                <span className="shrink-0">{pr.state === 'merged' ? 'Merged' : 'Closed'}</span>
              </>}
              {isDismissed
                ? <button type="button" className="chat-pr-dismiss" aria-label={`Restore PR #${pr.number}`} title="Restore" onClick={() => restore(pr)}><Undo2 className="size-3.5" /></button>
                : <button type="button" className="chat-pr-dismiss" aria-label={`Dismiss PR #${pr.number}`} title="Dismiss" onClick={() => updateDismissed([...dismissed, dismissKey(pr)])}><X className="size-3.5" /></button>}
            </div>
          )
        })}
        {hidden.length ? <button type="button" className="chat-pr-more" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? 'Show less' : `Show ${hidden.length} more`}</button> : null}
      </>}
    </section>
  )
}
