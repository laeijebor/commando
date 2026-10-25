import { useEffect, useState } from 'react'
import { CLOUD_DIFF_BYTE_LIMIT, CLOUD_DIFF_LINE_LIMIT, isSafeCloudUrl, type CloudDiff, type CloudTaskSummary } from '../shared/cloud-tasks'
import type { CloudTasksApi } from './cloudTasksApi'

/** Defense in depth for fixtures/older daemons; React escapes every line. */
export function boundCloudDiff(diff: CloudDiff): CloudDiff {
  let bytes = 0
  let truncated = diff.truncated
  const lines: string[] = []
  const encoder = new TextEncoder()
  // A character prefix bounds work even if a server violates its byte cap.
  const prefix = diff.text.slice(0, CLOUD_DIFF_BYTE_LIMIT)
  if (prefix.length < diff.text.length) truncated = true
  for (const line of prefix.split('\n')) {
    const size = encoder.encode(line).length + (lines.length ? 1 : 0)
    if (lines.length === CLOUD_DIFF_LINE_LIMIT || bytes + size > CLOUD_DIFF_BYTE_LIMIT) { truncated = true; break }
    bytes += size
    lines.push(line)
  }
  return { text: lines.join('\n'), truncated }
}

export function CloudTaskDiff({ api, task, enabled, connected }: {
  api: CloudTasksApi; task: CloudTaskSummary; enabled: boolean; connected: boolean
}) {
  const [requested, setRequested] = useState(false)
  const [diff, setDiff] = useState<CloudDiff | null>(null)
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  useEffect(() => { setRequested(false); setDiff(null); setError('') }, [task.id])
  useEffect(() => { setDiff(null); setError('') }, [task.providerUpdatedAt, task.rawState, task.remoteState])
  useEffect(() => {
    if (!requested || !enabled || !connected) return
    let current = true
    setDiff(null)
    setError('')
    void api.diff(task.id).then((result) => { if (current) setDiff(boundCloudDiff(result)) })
      .catch(() => { if (current) setError('Diff unavailable. Open the provider or retry when connected.') })
    return () => { current = false }
  }, [api, task.id, task.providerUpdatedAt, task.rawState, task.remoteState, requested, enabled, connected, attempt])
  if (!enabled) return null
  return <section className="cloud-detail-block" aria-label="Read-only diff">
    <h3>Read-only diff</h3>
    {!requested && <button type="button" disabled={!connected} onClick={() => setRequested(true)}>Load diff</button>}
    {requested && !diff && !error && <p role="status">{connected ? 'Loading diff…' : 'Reconnect to load the diff.'}</p>}
    {error && <p role="alert">{error} <button disabled={!connected} onClick={() => setAttempt((n) => n + 1)}>Retry diff</button></p>}
    {diff && <>
      <button type="button" disabled={!connected} onClick={() => setAttempt((n) => n + 1)}>Refresh diff</button>
      <p>Result ready is not proof of success or passed tests. No changes are applied locally.</p>
      {diff.truncated && <p className="cloud-notice" role="status">Diff truncated at 256 KiB or 5,000 lines. Open the provider for the complete result.</p>}
      <pre className="cloud-diff" tabIndex={0} aria-label="Unified diff">{diff.text || 'No diff returned.'}</pre>
    </>}
    {isSafeCloudUrl(task.provider, task.providerUrl) && <a href={task.providerUrl} target="_blank" rel="noopener noreferrer">Open full result in provider ↗</a>}
  </section>
}
