import { useEffect, useMemo, useRef, useState } from 'react'
import { ExternalLink, LoaderCircle, Pause, Trash2, X } from 'lucide-react'
import type { AgentStatus, TmuxPane, TmuxSession, TmuxWindow } from '../shared/protocol'
import { AnsiText } from './AnsiText'
import type { PaneManagementApiClient, PaneViews } from './paneManagementApi'
import {
  matchesPaneQuery,
  paneRows,
  planPaneClose,
  sortPaneRows,
  type PaneCloseAction,
  type PaneClosePlan,
  type PaneRow,
  type PaneSort,
} from './panesList'
import { relativeTime } from './relativeTime'
import './panes-view.css'

/** The pane budget the list is measured against. */
export const PANE_LIMIT = 64
const VIEWS_POLL_MS = 5_000
const PREVIEW_POLL_MS = 2_000

const CLOSE_LABELS: Record<Exclude<PaneCloseAction, null>, string> = {
  pane: 'Close pane',
  pause: 'Pause session',
  delete: 'Delete session',
}

const SORT_LABELS: Record<PaneSort, string> = {
  viewed: 'Last viewed',
  activity: 'Last activity',
  session: 'Session',
}

function usePageVisible(): boolean {
  const [visible, setVisible] = useState(() => document.visibilityState !== 'hidden')
  useEffect(() => {
    const change = () => setVisible(document.visibilityState !== 'hidden')
    document.addEventListener('visibilitychange', change)
    return () => document.removeEventListener('visibilitychange', change)
  }, [])
  return visible
}

/** Repeats `load` every `intervalMs` while the page is visible; `key` restarts it. */
function usePoll<T>(load: (() => Promise<T>) | null, intervalMs: number, key: unknown): { value?: T; error?: string } {
  const visible = usePageVisible()
  const [state, setState] = useState<{ key: unknown; value?: T; error?: string }>({ key })
  const loadRef = useRef(load)
  loadRef.current = load
  useEffect(() => {
    if (!visible || !loadRef.current) return
    let cancelled = false
    let busy = false
    const tick = () => {
      const run = loadRef.current
      if (busy || !run) return
      busy = true
      run()
        .then((value) => { if (!cancelled) setState({ key, value }) })
        // A failed refresh keeps this key's last value; another key's value is never shown under it.
        .catch((cause: unknown) => { if (!cancelled) setState((current) => ({ ...current.key === key ? current : {}, key, error: cause instanceof Error ? cause.message : 'Request failed' })) })
        .finally(() => { busy = false })
    }
    tick()
    const timer = window.setInterval(tick, intervalMs)
    return () => { cancelled = true; window.clearInterval(timer) }
  }, [visible, intervalMs, key, Boolean(load)])
  return state.key === key ? state : {}
}

function closeSummary(plan: PaneClosePlan): string {
  const parts = [
    plan.panes.length ? `close ${plan.panes.length} pane${plan.panes.length === 1 ? '' : 's'}` : '',
    plan.pauseSessions.length ? `pause ${plan.pauseSessions.length} session${plan.pauseSessions.length === 1 ? '' : 's'}` : '',
    plan.deleteSessions.length ? `delete ${plan.deleteSessions.length} background session${plan.deleteSessions.length === 1 ? '' : 's'}` : '',
  ].filter(Boolean)
  return parts.join(', ')
}

function viewedText(row: PaneRow, now: number): string {
  if (row.viewing) return 'On screen'
  return row.viewedAt ? relativeTime(row.viewedAt, now) : 'Not recorded'
}

export function PanesView({ sessions, windows, panes, agentStatuses, activity, auxiliarySessionIds, commanderSessionId, api, connected, onOpen, onClose }: {
  sessions: readonly TmuxSession[]
  windows: readonly TmuxWindow[]
  panes: readonly TmuxPane[]
  agentStatuses: Readonly<Record<string, AgentStatus>>
  activity: Readonly<Record<string, number>>
  auxiliarySessionIds: ReadonlySet<string>
  commanderSessionId?: string
  api: Pick<PaneManagementApiClient, 'capturePane' | 'paneViews'>
  connected: boolean
  onOpen: (paneId: string) => void
  /** Carries out a confirmed plan; errors from individual steps go to `onError`. */
  onClose: (plan: PaneClosePlan, onError: (message: string) => void) => Promise<void>
}) {
  const [sort, setSort] = useState<PaneSort>('viewed')
  const [query, setQuery] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [checked, setChecked] = useState<ReadonlySet<string>>(new Set())
  const [closing, setClosing] = useState(false)
  const [error, setError] = useState('')
  const [now, setNow] = useState(() => Date.now())

  const views = usePoll<PaneViews>(connected ? api.paneViews : null, VIEWS_POLL_MS, 'views')
  useEffect(() => { setNow(Date.now()) }, [views.value])

  const rows = useMemo(() => paneRows({
    sessions, windows, panes, agentStatuses, activity, auxiliarySessionIds, commanderSessionId,
    viewedAt: views.value?.viewedAt ?? {},
    viewing: new Set(views.value?.viewing ?? []),
  }), [sessions, windows, panes, agentStatuses, activity, auxiliarySessionIds, commanderSessionId, views.value])
  const shown = useMemo(() => sortPaneRows(rows.filter((row) => matchesPaneQuery(row, query)), sort), [rows, query, sort])

  // Panes that closed drop out of the selection and the preview.
  const liveIds = useMemo(() => new Set(panes.map((pane) => pane.id)), [panes])
  useEffect(() => {
    setChecked((current) => [...current].every((id) => liveIds.has(id)) ? current : new Set([...current].filter((id) => liveIds.has(id))))
    if (selectedId && !liveIds.has(selectedId)) setSelectedId(null)
  }, [liveIds, selectedId])

  const selected = selectedId ? rows.find((row) => row.pane.id === selectedId) : undefined
  const capture = usePoll(selected && connected && !selected.pane.empty ? () => api.capturePane(selected.pane.id) : null, PREVIEW_POLL_MS, selectedId)

  const close = async (paneIds: string[]) => {
    const plan = planPaneClose(paneIds, rows)
    const summary = closeSummary(plan)
    if (!summary) {
      setError('The Commander session closes from the session tree.')
      return
    }
    const kept = plan.kept.length ? `\n\n${plan.kept.length} Commander pane${plan.kept.length === 1 ? '' : 's'} stay open.` : ''
    const note = plan.pauseSessions.length ? '\n\nPaused sessions keep their worktree and resume from the session tree.' : ''
    if (!window.confirm(`${summary[0].toUpperCase()}${summary.slice(1)}? Running processes in them will stop.${note}${kept}`)) return
    setClosing(true)
    setError('')
    try {
      await onClose(plan, setError)
      setChecked(new Set())
    } finally {
      setClosing(false)
    }
  }

  const allShownChecked = shown.length > 0 && shown.every((row) => checked.has(row.pane.id))
  const toggleAll = () => setChecked(allShownChecked ? new Set() : new Set(shown.map((row) => row.pane.id)))
  const toggle = (paneId: string) => setChecked((current) => {
    const next = new Set(current)
    if (!next.delete(paneId)) next.add(paneId)
    return next
  })
  const tableBody = useRef<HTMLTableSectionElement>(null)
  // Focus follows the highlight, so Enter opens the pane being previewed.
  const move = (direction: 1 | -1) => {
    const index = shown.findIndex((row) => row.pane.id === selectedId)
    const next = shown[Math.min(shown.length - 1, Math.max(0, index + direction))]
    if (!next) return
    setSelectedId(next.pane.id)
    const rowElement = [...tableBody.current?.rows ?? []].find((element) => element.dataset.paneId === next.pane.id)
    rowElement?.focus()
  }

  const over = panes.length - PANE_LIMIT
  return <section className="panes-view" aria-label="Panes">
    <div className="panes-list">
      <header className="panes-bar">
        <h2>Panes</h2>
        <span className={`panes-pill${over > 0 ? ' over' : ''}`} title={`Measured against a budget of ${PANE_LIMIT} panes`}>
          {panes.length} / {PANE_LIMIT}{over > 0 ? ` · ${over} over` : ''}
        </span>
        <input type="search" className="panes-search" placeholder="Filter panes" aria-label="Filter panes" value={query} onChange={(event) => setQuery(event.target.value)} />
        <label className="panes-sort">
          <span>Sort</span>
          <select value={sort} onChange={(event) => setSort(event.target.value as PaneSort)} aria-label="Sort panes">
            {(Object.keys(SORT_LABELS) as PaneSort[]).map((key) => <option key={key} value={key}>{SORT_LABELS[key]}</option>)}
          </select>
        </label>
        <button type="button" className="panes-danger" disabled={!checked.size || closing || !connected} onClick={() => { void close([...checked]) }}>
          {closing ? <LoaderCircle className="spin" aria-hidden="true" /> : <Trash2 aria-hidden="true" />}
          Close {checked.size || ''} selected
        </button>
      </header>
      {error ? <p className="panes-error" role="alert">{error} <button type="button" aria-label="Dismiss" onClick={() => setError('')}><X aria-hidden="true" /></button></p> : null}
      {views.error ? <p className="panes-error" role="status">Last viewed times are unavailable: {views.error}</p> : null}
      <div className="panes-table-wrap">
        <table className="panes-table">
          <thead>
            <tr>
              <th className="panes-check"><input type="checkbox" checked={allShownChecked} onChange={toggleAll} aria-label="Select all shown panes" /></th>
              <th>Pane</th>
              <th>Session</th>
              <th>Status</th>
              <th>Last viewed</th>
              <th>Last activity</th>
              <th aria-label="Actions" />
            </tr>
          </thead>
          <tbody ref={tableBody} onKeyDown={(event) => {
            if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
            event.preventDefault()
            move(event.key === 'ArrowDown' ? 1 : -1)
          }}>
            {shown.map((row) => <tr key={row.pane.id} data-pane-id={row.pane.id} className={row.pane.id === selectedId ? 'selected' : undefined} aria-selected={row.pane.id === selectedId}
              tabIndex={0} onClick={() => setSelectedId(row.pane.id)} onKeyDown={(event) => { if (event.key === 'Enter' && event.target === event.currentTarget) onOpen(row.pane.id) }}>
              <td className="panes-check" onClick={(event) => event.stopPropagation()}>
                <input type="checkbox" checked={checked.has(row.pane.id)} onChange={() => toggle(row.pane.id)} aria-label={`Select ${row.label}`} />
              </td>
              <td className="panes-name">
                <strong title={row.label}>{row.label}</strong>
                <small title={row.pane.path}>{row.pane.repo ? `${row.pane.repo.name} · ${row.pane.repo.branch}` : row.pane.path}</small>
              </td>
              <td className="panes-session">
                <span title={row.sessionName}>{row.sessionName}</span>
                <small>{row.windowIndex !== undefined ? `window ${row.windowIndex} · ` : ''}{row.pane.id}</small>
              </td>
              <td className={`panes-status status-${row.status.toLowerCase().replace(/\s+/g, '-')}`}>{row.status}</td>
              <td className={row.viewing ? 'panes-viewing' : undefined}>{viewedText(row, now)}</td>
              <td>{row.activityAt ? relativeTime(row.activityAt, now) : '—'}</td>
              <td className="panes-actions" onClick={(event) => event.stopPropagation()}>
                <button type="button" onClick={() => onOpen(row.pane.id)} aria-label={`Open ${row.label}`} title="Open in workspace"><ExternalLink aria-hidden="true" /></button>
                {row.closeAction ? <button type="button" className="danger" disabled={closing || !connected} onClick={() => { void close([row.pane.id]) }}
                  aria-label={`${CLOSE_LABELS[row.closeAction]}: ${row.label}`} title={CLOSE_LABELS[row.closeAction]}>
                  {row.closeAction === 'pause' ? <Pause aria-hidden="true" /> : <Trash2 aria-hidden="true" />}
                </button> : null}
              </td>
            </tr>)}
          </tbody>
        </table>
        {!shown.length ? <p className="panes-empty">{panes.length ? 'No panes match the filter.' : 'No panes are open.'}</p> : null}
      </div>
    </div>
    {selected ? <aside className="panes-preview" aria-label={`Preview of ${selected.label}`}>
      <header>
        <div>
          <strong title={selected.label}>{selected.label}</strong>
          <small>{selected.sessionName} · {selected.pane.id} · {selected.pane.command}</small>
        </div>
        <button type="button" onClick={() => onOpen(selected.pane.id)}><ExternalLink aria-hidden="true" /> Open</button>
        {selected.closeAction ? <button type="button" className="danger" disabled={closing || !connected} onClick={() => { void close([selected.pane.id]) }}>
          {selected.closeAction === 'pause' ? <Pause aria-hidden="true" /> : <Trash2 aria-hidden="true" />} {CLOSE_LABELS[selected.closeAction]}
        </button> : null}
        <button type="button" className="panes-preview-close" aria-label="Close preview" onClick={() => setSelectedId(null)}><X aria-hidden="true" /></button>
      </header>
      {selected.pane.empty
        ? <p className="panes-empty">This pane is empty: nothing has been launched in it.</p>
        : capture.error && capture.value === undefined
          ? <p className="panes-error" role="alert">Could not read the pane: {capture.error}</p>
          : capture.value === undefined
            ? <p className="panes-empty"><LoaderCircle className="spin" aria-hidden="true" /> Loading preview…</p>
            : <pre className="panes-screen" aria-label="Pane screen"><AnsiText text={capture.value} /></pre>}
    </aside> : <aside className="panes-preview placeholder"><p className="panes-empty">Select a pane to preview its screen.</p></aside>}
  </section>
}
