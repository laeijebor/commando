import { Code2, LoaderCircle, Minus, RefreshCw, Unplug } from 'lucide-react'
import type { SessionIde } from '../shared/protocol'
import './session-ide.css'

export function SessionIdeView({
  active, sessionId, sessionName, ide, ides, openedIdeIds, pending, detaching = false, error, connected, onOpen, onDetach, onTerminal,
}: {
  active: boolean
  sessionId?: string | null
  sessionName: string
  ide?: SessionIde
  ides: SessionIde[]
  openedIdeIds: ReadonlySet<string>
  pending: boolean
  detaching?: boolean
  error: string
  connected: boolean
  onOpen: () => void
  onDetach: () => void
  onTerminal: () => void
}) {
  return <section className="session-ide-view" hidden={!active} aria-label="Session IDE">
    <header className="workspace-toolbar">
      <div className="workspace-context session-ide-context">
        <h1><Code2 aria-hidden="true" /> {sessionName} <span>IDE</span></h1>
        {ide ? <small title={ide.workspacePath}>{ide.workspacePath}{ide.sessionIds.length > 1 ? ` · shared by ${ide.sessionIds.length} sessions` : ''}</small> : null}
      </div>
      <div className="workspace-actions">
        {ide ? <details className="session-ide-detach-control" key={`${active}:${sessionId}:${ide.id}`} onKeyDown={(event) => {
          if (event.key !== 'Escape') return
          event.preventDefault()
          event.currentTarget.open = false
          event.currentTarget.querySelector('summary')?.focus()
        }}>
          <summary role="button" aria-disabled={!connected || pending} title="Remove this session’s IDE attachment" onClick={(event) => {
            if (!connected || pending) event.preventDefault()
          }}>{detaching ? <LoaderCircle className="spin" /> : <Unplug />}{detaching ? 'Detaching…' : 'Detach IDE'}</summary>
          <div className="session-ide-detach-confirm" role="group" aria-label="Confirm IDE detachment" data-native-terminal-occluder="">
            <strong>{ide.sessionIds.length > 1 ? 'Detach this session?' : 'Detach and stop this IDE?'}</strong>
            <p>{ide.sessionIds.length > 1
              ? 'Other attached sessions will keep the shared IDE running. To just hide it, use Minimize IDE.'
              : 'Save your files first. Detaching the last session stops code-server and may lose unsaved buffers. Minimize IDE keeps them open.'}</p>
            <div className="session-ide-confirm-actions">
              <button type="button" onClick={(event) => {
                const details = event.currentTarget.closest('details')!
                details.open = false
                details.querySelector('summary')?.focus()
              }}>Cancel</button>
              <button type="button" disabled={!connected || pending} onClick={(event) => {
                event.currentTarget.closest('details')!.open = false
                onDetach()
              }}>Confirm detach</button>
            </div>
          </div>
        </details> : null}
        <button type="button" className="session-ide-minimize" onClick={onTerminal} title="Return to terminals; keep the IDE running and preserve unsaved buffers"><Minus aria-hidden="true" /> Minimize IDE</button>
      </div>
    </header>
    {error && ide?.state === 'ready' ? <p className="session-ide-error" role="alert">{error}</p> : null}
    {ide?.state === 'failed' || (error && ide?.state !== 'ready') ? <div className="session-ide-message" role="alert">
      <Code2 /><h2>Unable to open IDE</h2><p>{error || ide?.error}</p>
      <button type="button" onClick={onOpen} disabled={!connected || pending}><RefreshCw /> Retry IDE</button>
    </div> : !ide || ide.state === 'starting' || !openedIdeIds.has(ide.id) ? <div className="session-ide-message" role="status">
      {pending || ide?.state === 'starting' ? <><LoaderCircle className="spin" /><h2>Starting session IDE</h2><p>Opening this worktree in code-server…</p></> : <><Code2 /><h2>Open this session’s workspace</h2><p>One IDE per worktree. Reopening reuses the existing editor.</p><button type="button" onClick={onOpen} disabled={!connected}>Open IDE</button></>}
    </div> : null}
    {/* Keep each opened worktree's frame alive across session/area switches. */}
    {ides.filter((item) => item.state === 'ready' && openedIdeIds.has(item.id)).map((item) => <iframe
      key={`${item.id}:${item.generation}`}
      className="session-ide-frame"
      hidden={!active || item.id !== ide?.id}
      src={item.url}
      title={`IDE: ${item.workspacePath}`}
      allow="clipboard-read; clipboard-write"
      referrerPolicy="no-referrer"
    />)}
  </section>
}
