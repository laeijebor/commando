import {
  AlertTriangle,
  Check,
  ChevronRight,
  CircleDotDashed,
  ShieldCheck,
  X,
} from 'lucide-react'

import type { AgentActivity, AgentProvider, AgentRecap, AgentStatus } from '../shared/protocol'

type AgentHudCardProps = {
  status: AgentStatus
  windowName?: string
  paneIndex?: number
  now?: number
  onSelect: () => void
}

const RECAP_LABELS: Record<AgentRecap['outcome'], string> = {
  done: 'Done',
  follow_up: 'Follow up',
  blocked: 'Blocked',
  failed: 'Failed',
}

function providerInitials(provider: AgentProvider) {
  switch (provider) {
    case 'claude':
      return 'CL'
    case 'codex':
      return 'CX'
    case 'opencode':
      return 'OC'
    case 'unknown':
      return 'AG'
  }
}

function relativeTime(timestamp: number, now: number) {
  if (!timestamp) return 'Unknown time'
  const elapsed = Math.max(0, now - timestamp)
  if (elapsed < 60_000) return 'Just now'
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m ago`
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h ago`
  if (elapsed < 604_800_000) return `${Math.floor(elapsed / 86_400_000)}d ago`
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(timestamp)
}

function activityTime(activity: AgentActivity, now: number) {
  return activity.state === 'running' ? 'Now' : relativeTime(activity.updatedAt, now)
}

function CheckIcon({ status }: { status: 'running' | 'passed' | 'failed' }) {
  if (status === 'passed') return <Check aria-hidden="true" />
  if (status === 'failed') return <X aria-hidden="true" />
  return <CircleDotDashed className="spin" aria-hidden="true" />
}

export function AgentHudCard({
  status,
  windowName,
  paneIndex,
  now = Date.now(),
  onSelect,
}: AgentHudCardProps) {
  const details = status.details
  const recap = status.status === 'working' ? undefined : details?.recap
  const currentActivity = details?.currentActivity
  const recentActivities = details?.recentActivities ?? []
  const primaryActivity = currentActivity ?? recentActivities[0]
  const visibleRecentActivities = currentActivity
    ? recentActivities
        .filter((activity) => (
          activity.label !== currentActivity.label || activity.updatedAt !== currentActivity.updatedAt
        ))
        .slice(0, 2)
    : recentActivities.slice(1, 2)
  const checks = details?.checks ?? []
  const changeStats = details?.changes && (details.changes.additions || details.changes.deletions)
    ? ` +${details.changes.additions}/-${details.changes.deletions}`
    : ''
  const hasChips = Boolean(details?.progress || details?.changes || checks.length)
  const hasPrimaryDetails = Boolean(
    details?.attention || recap || details?.intent || primaryActivity,
  )
  const providerLabel = status.provider === 'unknown' ? 'Agent' : status.provider
  const paneLabel = paneIndex === undefined ? status.paneId : String(paneIndex)
  const accessibleSummary = details?.attention
    || recap?.summary
    || details?.intent
    || primaryActivity?.label
    || status.summary
    || status.reason

  return (
    <button
      type="button"
      className={`agent-card status-${status.status}`}
      onClick={onSelect}
      aria-label={`Open ${providerLabel} agent in pane ${paneLabel}: ${accessibleSummary}`}
    >
      <span className={`agent-avatar provider-${status.provider}`} aria-hidden="true">
        {providerInitials(status.provider)}
      </span>
      <span className="agent-copy">
        <span className="agent-title-row">
          <strong>{providerLabel}</strong>
          <span className={`agent-state ${status.status}`}>{status.status.replace('_', ' ')}</span>
        </span>

        {details?.attention ? (
          <span className="agent-attention">
            <AlertTriangle aria-hidden="true" />
            <span>
              <small>Attention</small>
              <strong>{details.attention}</strong>
            </span>
          </span>
        ) : null}

        {recap ? (
          <span className={`agent-recap recap-${recap.outcome}`}>
            <span className="agent-recap-meta">
              <span className="agent-recap-outcome">{RECAP_LABELS[recap.outcome]}</span>
              <time dateTime={new Date(recap.completedAt).toISOString()}>
                {relativeTime(recap.completedAt, now)}
              </time>
            </span>
            <strong>{recap.summary}</strong>
          </span>
        ) : null}

        {details?.intent ? (
          <span className="agent-intent">
            <small>Task</small>
            <strong>{details.intent}</strong>
          </span>
        ) : null}

        {primaryActivity ? (
          <span className={`agent-activity activity-${primaryActivity.state}`}>
            <CircleDotDashed className={primaryActivity.state === 'running' ? 'spin' : undefined} aria-hidden="true" />
            <span>
              <span className="agent-activity-meta">
                <small>{currentActivity ? `Current ${primaryActivity.kind}` : `Latest ${primaryActivity.kind}`}</small>
                <time dateTime={new Date(primaryActivity.updatedAt).toISOString()}>
                  {activityTime(primaryActivity, now)}
                </time>
              </span>
              <strong>{primaryActivity.label}</strong>
            </span>
          </span>
        ) : null}

        {visibleRecentActivities.length ? (
          <span className="agent-recent" aria-label="Recent activity">
            {visibleRecentActivities.map((activity) => (
              <span className={`agent-recent-item activity-${activity.state}`} key={`${activity.updatedAt}:${activity.label}`}>
                {activity.label}
              </span>
            ))}
          </span>
        ) : null}

        {!hasPrimaryDetails ? (
          <span className="agent-summary">{status.summary || status.reason}</span>
        ) : null}

        {hasChips ? (
          <span className="agent-chips" aria-label="Agent progress, changes, and checks">
            {details?.progress ? (
              <span className="agent-chip agent-chip-progress" title={details.progress.active}>
                {details.progress.completed}/{details.progress.total} tasks
              </span>
            ) : null}
            {details?.changes ? (
              <span className="agent-chip agent-chip-changes">
                {details.changes.files.length} {details.changes.files.length === 1 ? 'file' : 'files'}{changeStats}
              </span>
            ) : null}
            {checks.map((check) => (
              <span className={`agent-chip agent-check check-${check.status}`} key={`${check.updatedAt}:${check.label}`}>
                <CheckIcon status={check.status} />
                {check.label} {check.status}
              </span>
            ))}
          </span>
        ) : null}

        <span className="agent-context">
          {windowName ?? 'unknown window'} / pane {paneIndex ?? '?'} / updated {relativeTime(status.updatedAt, now)}
        </span>
        <span className="provenance-row">
          <ShieldCheck aria-hidden="true" />
          <span>
            Source: {status.source} / Confidence: {status.confidence}
            {status.reason ? ` / ${status.reason}` : ''}
          </span>
        </span>
      </span>
      <ChevronRight className="jump-chevron" aria-hidden="true" />
    </button>
  )
}
