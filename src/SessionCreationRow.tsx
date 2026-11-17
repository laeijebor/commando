import { RotateCcw, X } from 'lucide-react'
import { useState } from 'react'
import { sessionCreationStatus, type SessionCreation } from '../shared/tmux-create'

type Props = {
  creation: SessionCreation
  onRetry: (id: string) => Promise<unknown>
  onDismiss: (id: string) => Promise<unknown>
}

/** Stands in the session tree for a session the daemon is still creating, or failed to. */
export function SessionCreationRow({ creation, onRetry, onDismiss }: Props) {
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState('')
  const failed = creation.stage === 'failed'
  const name = creation.name.trim() || creation.branch || 'New session'
  const status = sessionCreationStatus(creation)
  const act = async (action: (id: string) => Promise<unknown>) => {
    setBusy(true)
    setActionError('')
    try { await action(creation.id) } catch (cause) { setActionError(cause instanceof Error ? cause.message : 'Request failed') } finally { setBusy(false) }
  }
  return <article className={`managed-session session-creation${failed ? ' failed' : ''}`} aria-busy={!failed} aria-label={`${name}: ${status}`}>
    <div className="managed-session-row">
      <span className="session-indicator" aria-hidden="true" />
      <span className="managed-session-main" title={[name, creation.branch, creation.cwd].filter(Boolean).join(' · ')}>{name}</span>
      <span className="session-row-meta">{failed ? <>
        <button type="button" disabled={busy} onClick={() => void act(onRetry)} aria-label={`Retry creating ${name}`} title="Try again with the same settings"><RotateCcw /></button>
        <button type="button" disabled={busy} onClick={() => void act(onDismiss)} aria-label={`Dismiss ${name}`} title="Dismiss"><X /></button>
      </> : null}</span>
    </div>
    <p className="session-creation-status" role="status">{status}</p>
    {creation.stage === 'checking-out' && creation.percent !== undefined
      ? <progress className="session-creation-progress" max={100} value={creation.percent} aria-hidden="true" />
      : null}
    {failed && creation.error ? <p className="session-creation-error" title={creation.error}>{creation.error}</p> : null}
    {actionError ? <p className="session-creation-error">{actionError}</p> : null}
  </article>
}
