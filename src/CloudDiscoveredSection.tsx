import { useState } from 'react'
import {
  isSafeExternalUrl, validCloudRemoteId,
  type DiscoveredAgentProvider, type DiscoveredAgentStatus, type DiscoveredExternalAgent, type DiscoverySourceInfo,
} from '../shared/cloud-tasks'

const PROVIDER_LABELS: Record<DiscoveredAgentProvider, string> = {
  cursor: 'Cursor',
  codex: 'Codex',
  claude: 'Claude',
}

const STATUS_LABELS: Record<DiscoveredAgentStatus, string> = {
  running: 'Running',
  completed: 'Completed',
  failed: 'Failed',
  unknown: 'Status unknown',
}

function sourceStatusHint(source: DiscoverySourceInfo): string | null {
  if (source.status === 'ok') return null
  const name = PROVIDER_LABELS[source.provider]
  if (source.status === 'unauthenticated') {
    return `${name}: log in to list ${source.provider === 'codex' ? 'cloud tasks' : 'cloud agents'}`
  }
  if (source.status === 'unavailable') {
    return `${name}: ${source.message ? source.message.replace(/\.$/, '').toLowerCase() : 'unavailable'}`
  }
  return `${name}: could not refresh`
}

export interface CloudDiscoveredSectionProps {
  agents: readonly DiscoveredExternalAgent[]
  sources: readonly DiscoverySourceInfo[]
  discovering: boolean
  connected: boolean
  error?: string
  onRefresh: () => void
  onImport: (agent: DiscoveredExternalAgent) => Promise<void>
  onOpenChat?: (agent: DiscoveredExternalAgent) => Promise<void> | void
}

export function CloudDiscoveredSection({
  agents,
  sources,
  discovering,
  connected,
  error,
  onRefresh,
  onImport,
  onOpenChat,
}: CloudDiscoveredSectionProps) {
  const [open, setOpen] = useState(true)
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [actionError, setActionError] = useState('')

  const untracked = agents.filter((agent) => !agent.alreadyTracked)
  const trackedCount = agents.length - untracked.length
  const hints = sources.map(sourceStatusHint).filter((hint): hint is string => hint !== null)

  const handleAction = async (agent: DiscoveredExternalAgent) => {
    const key = `${agent.provider}:${agent.id}`
    if (busyKey) return
    setActionError('')
    if (agent.provider === 'cursor') {
      if (onOpenChat) {
        setBusyKey(key)
        try {
          await onOpenChat(agent)
        } catch (cause) {
          setActionError(cause instanceof Error ? cause.message : 'Unable to open Cursor agent as chat.')
        } finally {
          setBusyKey(null)
        }
        return
      }
      if (isSafeExternalUrl(agent.url)) {
        window.open(agent.url, '_blank', 'noopener,noreferrer')
      }
      return
    }
    setBusyKey(key)
    try {
      await onImport(agent)
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : 'Unable to import external agent.')
    } finally {
      setBusyKey(null)
    }
  }

  return (
    <section className="cloud-discovered" aria-label="Started elsewhere">
      <div className="cloud-discovered-header">
        <button
          type="button"
          className="cloud-discovered-toggle"
          aria-expanded={open}
          onClick={() => setOpen((current) => !current)}
        >
          <span className="cloud-discovered-caret" aria-hidden="true">{open ? '▾' : '▸'}</span>
          <strong>Started elsewhere</strong>
          {untracked.length > 0 && <span className="cloud-discovered-count">{untracked.length}</span>}
        </button>
        <button
          type="button"
          className="cloud-discovered-refresh"
          disabled={!connected || discovering}
          onClick={onRefresh}
        >
          {discovering ? 'Checking…' : 'Refresh'}
        </button>
      </div>

      {open && (
        <div className="cloud-discovered-body">
          {error && <p className="cloud-hint" role="status">{error}</p>}
          {actionError && <p className="cloud-notice" role="alert">{actionError}</p>}

          {untracked.length > 0 ? (
            <ul className="cloud-discovered-list">
              {untracked.map((agent) => {
                const key = `${agent.provider}:${agent.id}`
                const busy = busyKey === key
                const isCursor = agent.provider === 'cursor'
                const canLink = agent.provider !== 'cursor' && validCloudRemoteId(agent.provider, agent.id)
                const safeUrl = isSafeExternalUrl(agent.url) ? agent.url : undefined
                const meta = [agent.repo, agent.branch].filter(Boolean).join(' · ')
                return (
                  <li key={key} className="cloud-discovered-row" data-discovered-agent={key}>
                    <div className="cloud-discovered-meta">
                      <span className={`cloud-provider-badge cloud-provider-badge--${agent.provider}`}>
                        {PROVIDER_LABELS[agent.provider]}
                      </span>
                      <span
                        className={`cloud-status-dot cloud-status-dot--${agent.status}`}
                        title={STATUS_LABELS[agent.status]}
                        aria-label={STATUS_LABELS[agent.status]}
                      />
                      <span className="cloud-discovered-title" title={agent.title}>{agent.title}</span>
                    </div>
                    {meta && <small className="cloud-discovered-sub">{meta}</small>}
                    <div className="cloud-discovered-actions">
                      {isCursor ? (
                        <button
                          type="button"
                          disabled={!connected || busy || (!onOpenChat && !safeUrl)}
                          onClick={() => void handleAction(agent)}
                        >
                          {busy ? 'Opening…' : 'Open as chat'}
                        </button>
                      ) : canLink ? (
                        <button
                          type="button"
                          disabled={!connected || busy}
                          onClick={() => void handleAction(agent)}
                        >
                          {busy ? 'Importing…' : 'Import'}
                        </button>
                      ) : safeUrl ? (
                        <a href={safeUrl} target="_blank" rel="noopener noreferrer">Open ↗</a>
                      ) : null}
                      {safeUrl && (isCursor || canLink) && (
                        <a className="cloud-discovered-link" href={safeUrl} target="_blank" rel="noopener noreferrer">
                          Open ↗
                        </a>
                      )}
                    </div>
                  </li>
                )
              })}
            </ul>
          ) : (
            <p className="cloud-hint">
              {discovering
                ? 'Checking Cursor, Codex, and Claude…'
                : trackedCount > 0
                  ? `${trackedCount} external agent${trackedCount === 1 ? '' : 's'} already tracked.`
                  : 'No untracked agents found.'}
            </p>
          )}

          {hints.length > 0 && (
            <ul className="cloud-discovered-hints" aria-label="Discovery source status">
              {hints.map((hint) => (
                <li key={hint} className="cloud-hint">{hint}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  )
}
