import { type FormEvent, useState } from 'react'
import type {
  CreateTmuxPaneRequest,
  CreateTmuxSessionRequest,
  CreateTmuxWindowRequest,
  TmuxCreatedTarget,
  TmuxSplitDirection,
} from '../shared/tmux-create'
import './tmux-create.css'

type SessionOption = { id: string; name: string }
type WindowOption = { id: string; name: string; sessionId: string; index: number }
type PaneOption = { id: string; windowId: string; index: number; title: string }
type CreateMode = 'session' | 'window' | 'pane'

export const LAST_TMUX_CWD_STORAGE_KEY = 'commando.tmux-create.cwd'

export type TmuxCreateControlsProps = {
  sessions: readonly SessionOption[]
  windows: readonly WindowOption[]
  panes: readonly PaneOption[]
  disabled?: boolean
  initialMode?: CreateMode
  defaultSessionId?: string
  defaultTargetId?: string
  onCreateSession: (input: CreateTmuxSessionRequest) => Promise<TmuxCreatedTarget>
  onCreateWindow: (input: CreateTmuxWindowRequest) => Promise<TmuxCreatedTarget>
  onCreatePane: (input: CreateTmuxPaneRequest) => Promise<TmuxCreatedTarget>
  onCreated?: (created: TmuxCreatedTarget) => void
}

const modeLabels: Record<CreateMode, string> = {
  session: 'Session',
  window: 'Window',
  pane: 'Split',
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unable to create the tmux target'
}

function loadLastWorkingDirectory(): string {
  try {
    return window.localStorage.getItem(LAST_TMUX_CWD_STORAGE_KEY) ?? ''
  } catch {
    return ''
  }
}

function saveLastWorkingDirectory(value: string): void {
  try {
    if (value) window.localStorage.setItem(LAST_TMUX_CWD_STORAGE_KEY, value)
    else window.localStorage.removeItem(LAST_TMUX_CWD_STORAGE_KEY)
  } catch {
    // Persistence is optional when browser storage is unavailable.
  }
}

export function TmuxCreateControls({
  sessions,
  windows,
  panes,
  disabled = false,
  initialMode = 'session',
  defaultSessionId = '',
  defaultTargetId = '',
  onCreateSession,
  onCreateWindow,
  onCreatePane,
  onCreated,
}: TmuxCreateControlsProps) {
  const [mode, setMode] = useState<CreateMode>(initialMode)
  const [sessionId, setSessionId] = useState(defaultSessionId)
  const [targetId, setTargetId] = useState(defaultTargetId)
  const [direction, setDirection] = useState<TmuxSplitDirection>('horizontal')
  const [workingDirectory, setWorkingDirectory] = useState(loadLastWorkingDirectory)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const [status, setStatus] = useState('')
  const selectedSessionId = sessions.some((session) => session.id === sessionId)
    ? sessionId
    : (sessions[0]?.id ?? '')
  const targets = [
    ...panes.map((pane) => ({
      id: pane.id,
      label: `Pane ${pane.index}: ${pane.title || pane.id}`,
    })),
    ...windows.map((window) => ({
      id: window.id,
      label: `Window ${window.index}: ${window.name || window.id}`,
    })),
  ]
  const selectedTargetId = targets.some((target) => target.id === targetId)
    ? targetId
    : (targets[0]?.id ?? '')
  const unavailable = disabled || pending

  const changeMode = (nextMode: CreateMode) => {
    setMode(nextMode)
    setError('')
    setStatus('')
  }

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const formElement = event.currentTarget
    const form = new FormData(formElement)
    setPending(true)
    setError('')
    setStatus('')
    try {
      let created: TmuxCreatedTarget
      const cwd = String(form.get('cwd') ?? '')
      if (mode === 'session') {
        created = await onCreateSession({
          name: String(form.get('sessionName') ?? ''),
          windowName: String(form.get('windowName') ?? ''),
          cwd,
        })
      } else if (mode === 'window') {
        created = await onCreateWindow({
          sessionId: selectedSessionId,
          name: String(form.get('windowName') ?? ''),
          cwd,
        })
      } else {
        created = await onCreatePane({
          targetId: selectedTargetId,
          direction,
          cwd,
        })
      }
      saveLastWorkingDirectory(cwd)
      setStatus(`Created ${created.kind} ${created.paneId} in ${created.sessionName}`)
      onCreated?.(created)
      formElement.reset()
    } catch (submitError) {
      setError(errorMessage(submitError))
    } finally {
      setPending(false)
    }
  }

  return (
    <details className="tmux-create">
      <summary>New tmux target</summary>
      <div className="tmux-create__panel">
        <div className="tmux-create__modes" role="group" aria-label="Target type">
          {(Object.keys(modeLabels) as CreateMode[]).map((candidate) => (
            <button
              key={candidate}
              type="button"
              aria-pressed={mode === candidate}
              className={mode === candidate ? 'is-active' : ''}
              disabled={unavailable}
              onClick={() => changeMode(candidate)}
            >
              {modeLabels[candidate]}
            </button>
          ))}
        </div>

        <form onSubmit={submit} aria-busy={pending}>
          {mode === 'session' && (
            <>
              <label>
                Session name
                <input name="sessionName" required maxLength={128} autoComplete="off" />
              </label>
              <label>
                Initial window name <span>optional</span>
                <input name="windowName" maxLength={128} autoComplete="off" />
              </label>
            </>
          )}

          {mode === 'window' && (
            <>
              <label>
                Session
                <select
                  value={selectedSessionId}
                  required
                  disabled={unavailable || sessions.length === 0}
                  onChange={(event) => setSessionId(event.target.value)}
                >
                  {sessions.map((session) => (
                    <option key={session.id} value={session.id}>
                      {session.name} ({session.id})
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Window name <span>optional</span>
                <input name="windowName" maxLength={128} autoComplete="off" />
              </label>
            </>
          )}

          {mode === 'pane' && (
            <>
              <label>
                Split target
                <select
                  value={selectedTargetId}
                  required
                  disabled={unavailable || targets.length === 0}
                  onChange={(event) => setTargetId(event.target.value)}
                >
                  {targets.map((target) => (
                    <option key={target.id} value={target.id}>
                      {target.label} ({target.id})
                    </option>
                  ))}
                </select>
              </label>
              <fieldset>
                <legend>Split layout</legend>
                <label>
                  <input
                    type="radio"
                    name="direction"
                    value="horizontal"
                    checked={direction === 'horizontal'}
                    onChange={() => setDirection('horizontal')}
                  />
                  Side by side
                </label>
                <label>
                  <input
                    type="radio"
                    name="direction"
                    value="vertical"
                    checked={direction === 'vertical'}
                    onChange={() => setDirection('vertical')}
                  />
                  Stacked
                </label>
              </fieldset>
            </>
          )}

          <label>
            Working directory <span>optional, absolute path</span>
            <input
              name="cwd"
              value={workingDirectory}
              onChange={(event) => setWorkingDirectory(event.target.value)}
              placeholder="/Users/me/project"
              autoComplete="off"
            />
          </label>

          {error && (
            <p className="tmux-create__message is-error" role="alert">
              {error}
            </p>
          )}
          {status && (
            <p className="tmux-create__message" role="status">
              {status}
            </p>
          )}

          <button
            className="tmux-create__submit"
            type="submit"
            disabled={
              unavailable ||
              (mode === 'window' && sessions.length === 0) ||
              (mode === 'pane' && targets.length === 0)
            }
          >
            {pending ? 'Creating...' : `Create ${modeLabels[mode].toLowerCase()}`}
          </button>
        </form>
      </div>
    </details>
  )
}
