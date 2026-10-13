import { useEffect, useRef, useState } from 'react'
import { CheckCircle2, ChevronDown, CircleDashed, CircleMinus, ExternalLink, GitMerge, GitPullRequest, XCircle } from 'lucide-react'
import type { PrAutofixStatus } from '../../shared/pr-types'
import type { PanePrSummary, PrsApiClient } from '../prsApi'
import { usePanePullRequests } from '../PanePullRequests'
import { Popover, PopoverPopup, PopoverTrigger } from './ui/popover'

type StripApi = Pick<PrsApiClient, 'pane' | 'autofixStatus' | 'setAutofix'>

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
        <span className={`chat-pr-dot ${checks?.state ?? 'pending'}`} /> CI <ChevronDown className="size-3" />
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
      </PopoverPopup>
    </Popover>
  )
}

export function PrStrip({ paneId, api, connected, onOpenPr }: { paneId: string; api: StripApi; connected: boolean; onOpenPr?: (repo: string, number: number) => void }) {
  const list = usePanePullRequests(paneId, api, connected)
  const [expanded, setExpanded] = useState(false)
  if (!list?.pullRequests.length) return null
  const prs = [...list.pullRequests].sort((left, right) => Number(right.state === 'open') - Number(left.state === 'open'))
  return (
    <section className="chat-pr-strip" aria-label="Linked pull requests">
      {(expanded ? prs : prs.slice(0, 2)).map((pr) => {
        const Icon = pr.state === 'merged' ? GitMerge : GitPullRequest
        return (
          <div key={`${pr.repo}#${pr.number}`} className={`chat-pr-row ${pr.state}`}>
            <Icon className="size-4 shrink-0" />
            <a className="chat-pr-link" href={pr.url} target="_blank" rel="noopener noreferrer" title={`${pr.repo}#${pr.number}: ${pr.title}`}
              onClick={(event) => {
                // Modified clicks keep the browser's open-in-new-tab behaviour.
                if (!onOpenPr || event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return
                event.preventDefault()
                onOpenPr(pr.repo, pr.number)
              }}><span className="font-mono">#{pr.number}</span> <span className="truncate">{pr.title}</span></a>
            <span className="chat-pr-diff"><span className="text-success">+{pr.additions.toLocaleString('en-US')}</span> <span className="text-destructive">−{pr.deletions.toLocaleString('en-US')}</span></span>
            {pr.state === 'open' ? <CiPopover pr={pr} paneId={paneId} api={api} connected={connected} /> : <span className="shrink-0">{pr.state === 'merged' ? 'Merged' : 'Closed'}</span>}
          </div>
        )
      })}
      {prs.length > 2 ? <button type="button" className="chat-pr-more" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? 'Show less' : `Show ${prs.length - 2} more`}</button> : null}
    </section>
  )
}
