import { cloudConnectionKey, cloudTaskLabel, type CloudProviderInfo, type CloudTaskSummary } from '../shared/cloud-tasks'

export function cloudTaskConnectionLabel(task: CloudTaskSummary, providers: CloudProviderInfo[] = []): string {
  return providers.find((info) => cloudConnectionKey(info.id, info.credentialContextId) === cloudConnectionKey(task.provider, task.credentialContextId))?.label
    ?? `${task.provider === 'claude' ? 'Claude' : 'Codex'} · ${task.credentialContextId}`
}

export function CloudTaskCard({ task, selected = false, compact = false, connectionLabel = cloudTaskConnectionLabel(task), onSelect }: {
  task: CloudTaskSummary
  selected?: boolean
  compact?: boolean
  connectionLabel?: string
  onSelect: (id: string) => void
}) {
  const label = cloudTaskLabel(task)
  return <button type="button" className={`cloud-task-card${compact ? ' cloud-task-card--compact' : ''}`}
    data-cloud-task-id={task.id} data-uncertain={task.deliveryState === 'delivery_unknown' || undefined}
    aria-current={selected || undefined} onClick={() => onSelect(task.id)}
    aria-label={`${connectionLabel}: ${task.title}. ${label}${task.archivedAt ? '. Archived' : ''}`}>
    <span className={`cloud-avatar cloud-avatar--${task.provider}`} aria-hidden="true">{task.provider === 'claude' ? 'CL' : 'CX'}</span>
    <span className="cloud-task-copy">
      <strong>{task.title}</strong><small>{connectionLabel}</small><span>{label}</span>
      <small>{compact && task.provider === 'claude' ? 'Live status only in Claude'
        : [task.source.repository ?? task.source.environmentId ?? 'Source not recorded', task.source.branch].filter(Boolean).join(' · ')}</small>
      {task.observationState !== 'fresh' && <small>Observation: {task.observationState}</small>}
      {compact && task.lastObservedAt && <small>Last checked <time dateTime={task.lastObservedAt}>{new Date(task.lastObservedAt).toLocaleString()}</time></small>}
      {task.archivedAt && <small>Archived locally</small>}
    </span>
  </button>
}
