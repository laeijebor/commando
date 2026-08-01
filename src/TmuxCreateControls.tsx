import { type FormEvent, type KeyboardEvent as ReactKeyboardEvent, useEffect, useRef, useState } from 'react'
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
type PaneOption = { id: string; windowId: string; sessionId: string; index: number; title: string; path: string }
type CreateMode = 'session' | 'window' | 'pane'

export type SessionCreateRequest = {
  id: number
  groupId: string
  groupName: string
  suggestedDirectories: string[]
}

export const TMUX_CWD_HISTORY_STORAGE_KEY = 'commando.tmux-create.cwd'
const MAX_WORKING_DIRECTORY_HISTORY = 10

export type TmuxCreateControlsProps = {
  sessions: readonly SessionOption[]
  windows: readonly WindowOption[]
  panes: readonly PaneOption[]
  disabled?: boolean
  initialMode?: CreateMode
  defaultSessionId?: string
  defaultTargetId?: string
  sessionCreateRequest?: SessionCreateRequest | null
  onCreateSession: (input: CreateTmuxSessionRequest) => Promise<TmuxCreatedTarget>
  onCreateWindow: (input: CreateTmuxWindowRequest) => Promise<TmuxCreatedTarget>
  onCreatePane: (input: CreateTmuxPaneRequest) => Promise<TmuxCreatedTarget>
  onCreated?: (created: TmuxCreatedTarget, sessionGroupId?: string) => void
}

const modeLabels: Record<CreateMode, string> = {
  session: 'Session',
  window: 'Window',
  pane: 'Split',
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unable to create the tmux target'
}

function loadWorkingDirectoryHistory(): string[] {
  try {
    const stored = window.localStorage.getItem(TMUX_CWD_HISTORY_STORAGE_KEY)
    if (!stored) return []
    let values: unknown
    try {
      values = JSON.parse(stored)
    } catch {
      // Older versions stored only the last successful directory as plain text.
      values = [stored]
    }
    if (!Array.isArray(values)) return []
    return values
      .filter((value): value is string => typeof value === 'string' && value.startsWith('/'))
      .filter((value, index, history) => history.indexOf(value) === index)
      .slice(0, MAX_WORKING_DIRECTORY_HISTORY)
  } catch {
    return []
  }
}

function saveWorkingDirectoryHistory(value: string, history: readonly string[]): string[] {
  if (!value) return [...history]
  const nextHistory = [value, ...history.filter((directory) => directory !== value)]
    .slice(0, MAX_WORKING_DIRECTORY_HISTORY)
  try {
    window.localStorage.setItem(TMUX_CWD_HISTORY_STORAGE_KEY, JSON.stringify(nextHistory))
  } catch {
    // Persistence is optional when browser storage is unavailable.
  }
  return nextHistory
}

export function TmuxCreateControls({
  sessions,
  windows,
  panes,
  disabled = false,
  initialMode = 'session',
  defaultSessionId = '',
  defaultTargetId = '',
  sessionCreateRequest = null,
  onCreateSession,
  onCreateWindow,
  onCreatePane,
  onCreated,
}: TmuxCreateControlsProps) {
  const detailsRef = useRef<HTMLDetailsElement>(null)
  const sessionNameRef = useRef<HTMLInputElement>(null)
  const [mode, setMode] = useState<CreateMode>(initialMode)
  const [sessionId, setSessionId] = useState(defaultSessionId)
  const [targetId, setTargetId] = useState(defaultTargetId)
  const [direction, setDirection] = useState<TmuxSplitDirection>('horizontal')
  const [workingDirectoryHistory, setWorkingDirectoryHistory] = useState(loadWorkingDirectoryHistory)
  const [workingDirectory, setWorkingDirectory] = useState(workingDirectoryHistory[0] ?? '')
  const [sessionGroupId, setSessionGroupId] = useState('ungrouped')
  const [sessionGroupName, setSessionGroupName] = useState('Ungrouped')
  const [groupDirectorySuggestions, setGroupDirectorySuggestions] = useState<string[]>([])
  const [directoryHistoryOpen, setDirectoryHistoryOpen] = useState(false)
  const [directoryHistoryFiltering, setDirectoryHistoryFiltering] = useState(false)
  const [directoryHistoryHighlight, setDirectoryHistoryHighlight] = useState(0)
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
  const availableDirectories = mode === 'session'
    ? [...groupDirectorySuggestions, ...workingDirectoryHistory.filter((directory) => !groupDirectorySuggestions.includes(directory))]
    : workingDirectoryHistory
  const directoryQuery = directoryHistoryFiltering ? workingDirectory.toLowerCase() : ''
  const directorySuggestions = availableDirectories.filter(
    (directory) => directoryQuery === '' || directory.toLowerCase().includes(directoryQuery),
  )
  const activeDirectoryHighlight = Math.min(
    directoryHistoryHighlight,
    Math.max(0, directorySuggestions.length - 1),
  )

  useEffect(() => {
    if (!sessionCreateRequest) return
    setMode('session')
    setSessionGroupId(sessionCreateRequest.groupId)
    setSessionGroupName(sessionCreateRequest.groupName)
    setGroupDirectorySuggestions(sessionCreateRequest.suggestedDirectories)
    setWorkingDirectory(sessionCreateRequest.suggestedDirectories[0] ?? workingDirectoryHistory[0] ?? '')
    setDirectoryHistoryFiltering(false)
    setDirectoryHistoryHighlight(0)
    setError('')
    setStatus('')
  }, [sessionCreateRequest])

  useEffect(() => {
    if (!sessionCreateRequest || mode !== 'session' || !detailsRef.current) return
    detailsRef.current.open = true
    detailsRef.current.scrollIntoView?.({ block: 'nearest' })
    sessionNameRef.current?.focus()
  }, [mode, sessionCreateRequest])

  const changeMode = (nextMode: CreateMode) => {
    if (sessionGroupId !== 'ungrouped') {
      setWorkingDirectory(nextMode === 'session'
        ? (groupDirectorySuggestions[0] ?? workingDirectoryHistory[0] ?? '')
        : (workingDirectoryHistory[0] ?? ''))
    }
    setMode(nextMode)
    setError('')
    setStatus('')
  }

  const chooseWorkingDirectory = (directory: string) => {
    setWorkingDirectory(directory)
    setDirectoryHistoryOpen(false)
    setDirectoryHistoryFiltering(false)
  }

  const onWorkingDirectoryKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (!directoryHistoryOpen) {
        setDirectoryHistoryOpen(true)
        return
      }
      if (!directorySuggestions.length) return
      const step = event.key === 'ArrowDown' ? 1 : -1
      setDirectoryHistoryHighlight(
        (activeDirectoryHighlight + step + directorySuggestions.length) % directorySuggestions.length,
      )
    } else if (event.key === 'Enter' && directoryHistoryOpen && directorySuggestions.length) {
      event.preventDefault()
      chooseWorkingDirectory(directorySuggestions[activeDirectoryHighlight])
    } else if (event.key === 'Escape' && directoryHistoryOpen) {
      event.preventDefault()
      setDirectoryHistoryOpen(false)
    }
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
      const nextHistory = saveWorkingDirectoryHistory(cwd, workingDirectoryHistory)
      setWorkingDirectoryHistory(nextHistory)
      setDirectoryHistoryOpen(false)
      setStatus(`Created ${created.kind} ${created.paneId} in ${created.sessionName}`)
      onCreated?.(created, mode === 'session' ? sessionGroupId : undefined)
      formElement.reset()
    } catch (submitError) {
      setError(errorMessage(submitError))
    } finally {
      setPending(false)
    }
  }

  return (
    <details
      className="tmux-create"
      ref={detailsRef}
      onToggle={(event) => {
        if (event.currentTarget.open) return
        if (sessionGroupId !== 'ungrouped') setWorkingDirectory(workingDirectoryHistory[0] ?? '')
        setSessionGroupId('ungrouped')
        setSessionGroupName('Ungrouped')
        setGroupDirectorySuggestions([])
      }}
    >
      <summary>{sessionGroupId === 'ungrouped' ? 'New tmux target' : `New session in ${sessionGroupName}`}</summary>
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
              <p className="tmux-create__destination">Session group <strong>{sessionGroupName}</strong></p>
              <label>
                Session name
                <input ref={sessionNameRef} name="sessionName" required maxLength={128} autoComplete="off" />
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

          <div className="tmux-create__field">
            <label htmlFor="tmux-create-cwd">
              Working directory <span>optional, absolute path</span>
            </label>
            <div className="tmux-create__cwd-combo">
              <input
                id="tmux-create-cwd"
                name="cwd"
                value={workingDirectory}
                onChange={(event) => {
                  setWorkingDirectory(event.target.value)
                  setDirectoryHistoryOpen(true)
                  setDirectoryHistoryFiltering(true)
                  setDirectoryHistoryHighlight(0)
                }}
                onKeyDown={onWorkingDirectoryKeyDown}
                onFocus={() => {
                  setDirectoryHistoryOpen(true)
                  setDirectoryHistoryFiltering(false)
                  setDirectoryHistoryHighlight(0)
                }}
                onClick={() => {
                  setDirectoryHistoryOpen(true)
                  setDirectoryHistoryFiltering(false)
                  setDirectoryHistoryHighlight(0)
                }}
                onBlur={() => setDirectoryHistoryOpen(false)}
                placeholder="/Users/me/project"
                autoComplete="off"
                role="combobox"
                aria-autocomplete="list"
                aria-expanded={directoryHistoryOpen && directorySuggestions.length > 0}
                aria-controls="tmux-create-cwd-history"
                aria-activedescendant={
                  directoryHistoryOpen && directorySuggestions.length > 0
                    ? `tmux-create-cwd-option-${activeDirectoryHighlight}`
                    : undefined
                }
                spellCheck={false}
              />
              {directoryHistoryOpen && directorySuggestions.length > 0 ? (
                <div
                  className="tmux-create__cwd-history"
                  id="tmux-create-cwd-history"
                  role="listbox"
                  aria-label="Suggested working directories"
                >
                  {directorySuggestions.map((directory, index) => (
                    <button
                      key={directory}
                      id={`tmux-create-cwd-option-${index}`}
                      type="button"
                      role="option"
                      tabIndex={-1}
                      aria-selected={directory === workingDirectory}
                      className={index === activeDirectoryHighlight ? 'is-highlighted' : undefined}
                      onMouseDown={(event) => {
                        event.preventDefault()
                        chooseWorkingDirectory(directory)
                      }}
                      onMouseEnter={() => setDirectoryHistoryHighlight(index)}
                    >
                      {directory}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          </div>

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
