import { X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { stopsByDefault, type TrackedProcess } from '../shared/tracked-processes'
import { processUptime } from './WorklogProcesses'
import './session-create-dialog.css'
import './session-close-dialog.css'

export type SessionCloseRequest = {
  title: string
  /** The usual confirmation text, if closing needed one. */
  message: string | null
  confirmLabel: string
  processes: TrackedProcess[]
}

/**
 * Confirms archiving, pausing or deleting a session that started processes, with a ticked
 * "Stop" box per process: closing the session leaves detached ones running unless stopped.
 */
export function SessionCloseDialog({ request, onCancel, onConfirm }: {
  request: SessionCloseRequest
  onCancel: () => void
  /** The keys of the processes to stop. */
  onConfirm: (stopKeys: string[]) => void
}) {
  const [kept, setKept] = useState<ReadonlySet<string>>(() => new Set(request.processes.filter((process) => !stopsByDefault(process)).map(({ key }) => key)))
  const confirm = useRef<HTMLButtonElement>(null)
  useEffect(() => { confirm.current?.focus() }, [])
  const toggle = (key: string, stop: boolean) => setKept((current) => {
    const next = new Set(current)
    if (stop) next.delete(key)
    else next.add(key)
    return next
  })
  const stopping = request.processes.filter((process) => !kept.has(process.key))

  // Portalled: the session tree that asks may be hidden, as when the Commander peek closes a session.
  return createPortal(<div className="session-create-backdrop" data-native-terminal-occluder="" onMouseDown={(event) => { if (event.target === event.currentTarget) onCancel() }}>
    <section className="session-create-dialog session-close-dialog" role="dialog" aria-modal="true" aria-labelledby="session-close-title"
      onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); onCancel() } }}>
      <header>
        <strong id="session-close-title" className="session-create-heading">{request.title}</strong>
        <button type="button" onClick={onCancel} aria-label="Cancel"><X /></button>
      </header>
      <div className="session-close-body">
        {request.message ? <p className="session-close-message">{request.message}</p> : null}
        <fieldset>
          <legend>Processes started from this session</legend>
          <p className="session-close-hint">Ticked processes are stopped after the session closes. Untick one to leave it running.</p>
          {request.processes.map((process) => (
            <label key={process.key} className="session-close-process">
              <input type="checkbox" checked={!kept.has(process.key)} onChange={(event) => toggle(process.key, event.target.checked)}
                aria-label={`Stop ${process.command}`} />
              <span>
                <strong title={process.fullCommand}>{process.command}</strong>
                <small>
                  {[`up ${processUptime(process.startedAt)}`, `pid ${process.pid}`, process.childCount ? `+${process.childCount} child${process.childCount === 1 ? '' : 'ren'}` : '',
                    process.ports.length ? process.ports.map((port) => `:${port}`).join(' ') : '', process.detached ? 'detached' : '', stopsByDefault(process) ? '' : 'app, kept unless ticked'].filter(Boolean).join(' · ')}
                </small>
              </span>
            </label>
          ))}
        </fieldset>
      </div>
      <footer className="session-close-actions">
        <button type="button" onClick={onCancel}>Cancel</button>
        <button type="button" ref={confirm} className="session-close-confirm" onClick={() => onConfirm(stopping.map(({ key }) => key))}>
          {request.confirmLabel}{stopping.length ? ` and stop ${stopping.length}` : ''}
        </button>
      </footer>
    </section>
  </div>, document.body)
}
