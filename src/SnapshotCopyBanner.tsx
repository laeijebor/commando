import { useState } from 'react'
import { useHost } from './HostContext'
import './snapshot-copy-banner.css'

/** Restoring publishes the replacement through the existing web-panes broadcast. */
export function SnapshotCopyBanner({ webPaneId, savedAt, token = '' }: { webPaneId?: string; savedAt?: number; token?: string }) {
  const { daemonFetch } = useHost()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const restore = async () => {
    const destination = window.prompt('Restore to folder…\nEnter an absolute path for a new folder:')
    if (!destination?.trim() || !webPaneId) return
    setBusy(true); setError('')
    try {
      const response = await daemonFetch(`/api/web-panes/${encodeURIComponent(webPaneId)}/restore`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ destination: destination.trim() }),
      })
      if (!response.ok) { const body = await response.json(); throw new Error(body.error || `Could not restore (${response.status})`) }
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not restore saved copy') }
    finally { setBusy(false) }
  }
  return <div className="snapshot-copy-banner" role="status">
    <span>Read-only copy saved {savedAt === undefined ? 'previously' : new Date(savedAt).toLocaleString()} — the original folder no longer exists</span>
    <button type="button" disabled={busy || !webPaneId} onClick={() => { void restore() }}>Restore to folder…</button>
    {error && <span role="alert">{error}</span>}
  </div>
}
