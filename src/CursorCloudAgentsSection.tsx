import { useState } from 'react'
import { type CursorCloudAgentsStore, useCursorCloudAgents } from './cursorCloudAgents'

const statusLabels = { running: 'Working', finished: 'Done', error: 'Failed', cancelled: 'Stopped' }
function relativeTime(value: number): string {
  const minutes = Math.max(0, Math.floor((Date.now() - value) / 60_000))
  if (minutes < 1) return 'Just now'
  if (minutes < 60) return `${minutes}m ago`
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h ago`
  return `${Math.floor(minutes / 1440)}d ago`
}
function safeUrl(value?: string): string | undefined {
  try { const url = new URL(value ?? ''); return url.protocol === 'https:' && !url.username && !url.password ? url.href : undefined } catch { return undefined }
}
export function CursorCloudAgentsSection({ store, onFocusPane }: {
  store: CursorCloudAgentsStore
  onFocusPane: (paneId: string) => void
}) {
  const state = useCursorCloudAgents(store)
  const [opening, setOpening] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [showAll, setShowAll] = useState(false)
  const agents = [...state.agents].sort((a, b) => b.lastModified - a.lastModified)
  const shown = showAll ? agents : agents.slice(0, 9)
  return <section className="cursor-cloud-agents" aria-label="Cursor cloud agents">
    <header className="cloud-toolbar"><h2>Cursor cloud agents</h2>
      {agents.length > 9 && <button aria-expanded={showAll} onClick={() => setShowAll(!showAll)}>{showAll ? 'Show less' : `Show all (${agents.length})`}</button>}
      <button disabled={state.loading} onClick={() => void store.refresh(true)}>Refresh</button>
    </header>
    {state.login === 'required' ? <p className="cloud-hint">Log in to Cursor from a Cursor chat to see your cloud agents.</p> : <>
      {!state.loaded && <p className="cloud-hint">Loading Cursor cloud agents…</p>}
      {state.loaded && !state.agents.length && !state.error && <p className="cloud-hint">No Cursor cloud agents yet.</p>}
      <div className="cursor-cloud-agent-list">{shown.map((agent) => {
        const repo = agent.repoUrl?.replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '')
        const repoUrl = safeUrl(agent.repoUrl)
        const prUrl = safeUrl(agent.prUrl)
        return <article key={agent.agentId} className="cursor-cloud-agent">
          <div className="cloud-task-copy"><strong>{agent.name}</strong>
            <small>{repoUrl ? <a href={repoUrl} target="_blank" rel="noopener noreferrer">{repo}</a> : repo ?? 'Repository unknown'}</small>
            <div className="cursor-cloud-agent-meta"><span className="cursor-cloud-status" data-status={agent.status}>{agent.status ? statusLabels[agent.status] : 'Unknown'}</span>
              <time dateTime={new Date(agent.lastModified).toISOString()}>{relativeTime(agent.lastModified)}</time>
              {!agent.startedInCommando && <span>Started elsewhere</span>}
            </div>
            {(agent.branch || prUrl) && <small>{agent.branch && (repoUrl
              ? <a href={`${repoUrl}/tree/${encodeURIComponent(agent.branch)}`} target="_blank" rel="noopener noreferrer">{agent.branch}</a> : agent.branch)}
              {prUrl && <> · <a href={prUrl} target="_blank" rel="noopener noreferrer">PR ↗</a></>}</small>}
          </div>
          <div className="cloud-actions"><button disabled={opening !== null} onClick={() => {
            // Always ask the daemon: a cached pane may have closed since the list loaded, and it reopens the chat then.
            setOpening(agent.agentId); setError('')
            void store.open(agent.agentId).then(onFocusPane)
              .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : 'Unable to open chat.'))
              .finally(() => setOpening(null))
          }}>{opening === agent.agentId ? 'Opening…' : agent.openPaneId ? 'Go to chat' : 'Open chat'}</button>
            <a href={`https://cursor.com/agents/${encodeURIComponent(agent.agentId)}`} target="_blank" rel="noopener noreferrer">Open on cursor.com ↗</a>
          </div>
        </article>
      })}</div>
      {state.more && <p className="cloud-hint">Showing the 50 most recent agents. More are available on cursor.com.</p>}
    </>}
    {(error || state.error) && <p className="cloud-notice" role="alert">{error || state.error}</p>}
  </section>
}
