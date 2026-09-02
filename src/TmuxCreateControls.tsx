import { type FormEvent, type KeyboardEvent as ReactKeyboardEvent, useEffect, useRef, useState } from 'react'
import {
  defaultWorktreePath,
  sanitizeBranchName,
  type CreateTmuxSessionRequest,
  type GitRepoInfo,
  type TmuxCreatedTarget,
  type TmuxCreatedWorktree,
  type TmuxCreateResponse,
} from '../shared/tmux-create'
import './tmux-create.css'

export type SessionCreateRepo = { root: string; name: string; defaultBranch?: string }

export type SessionCreateRequest = {
  id: number
  groupId: string
  groupName: string
  suggestedDirectories: string[]
  /** Set when the request came from a repository group; the form pre-fills its main checkout. */
  repo?: SessionCreateRepo
}

export const TMUX_CWD_HISTORY_STORAGE_KEY = 'commando.tmux-create.cwd'
const MAX_WORKING_DIRECTORY_HISTORY = 10
const REPO_PROBE_DEBOUNCE_MS = 200

export type TmuxCreateControlsProps = {
  disabled?: boolean
  /** `inline` (default) is the collapsible sidebar form; `dialog` renders the open panel only. */
  variant?: 'inline' | 'dialog'
  sessionCreateRequest?: SessionCreateRequest | null
  onCreateSession: (input: CreateTmuxSessionRequest) => Promise<TmuxCreateResponse>
  onCreated?: (created: TmuxCreatedTarget, sessionGroupId?: string, worktree?: TmuxCreatedWorktree) => void
  /** Describes the repository behind a directory; without it the worktree block never appears. */
  probeRepo?: (directory: string) => Promise<GitRepoInfo>
}

type RepoProbe = { directory: string; info: GitRepoInfo } | null

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
  disabled = false,
  variant = 'inline',
  sessionCreateRequest = null,
  onCreateSession,
  onCreated,
  probeRepo,
}: TmuxCreateControlsProps) {
  const detailsRef = useRef<HTMLDetailsElement>(null)
  const sessionNameRef = useRef<HTMLInputElement>(null)
  const [sessionName, setSessionName] = useState('')
  const [workingDirectoryHistory, setWorkingDirectoryHistory] = useState(loadWorkingDirectoryHistory)
  const [workingDirectory, setWorkingDirectory] = useState(workingDirectoryHistory[0] ?? '')
  const [sessionGroupId, setSessionGroupId] = useState('ungrouped')
  const [sessionGroupName, setSessionGroupName] = useState('Ungrouped')
  const [sessionRepo, setSessionRepo] = useState<SessionCreateRepo | null>(null)
  const [groupDirectorySuggestions, setGroupDirectorySuggestions] = useState<string[]>([])
  const [directoryHistoryOpen, setDirectoryHistoryOpen] = useState(false)
  const [directoryHistoryFiltering, setDirectoryHistoryFiltering] = useState(false)
  const [directoryHistoryHighlight, setDirectoryHistoryHighlight] = useState(0)
  const [repoProbe, setRepoProbe] = useState<RepoProbe>(null)
  const [worktreeEnabled, setWorktreeEnabled] = useState(true)
  const [branchEdited, setBranchEdited] = useState(false)
  const [branch, setBranch] = useState('')
  const [worktreePath, setWorktreePath] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const [status, setStatus] = useState('')
  const probeVersion = useRef(0)
  const unavailable = disabled || pending
  const availableDirectories = [
    ...groupDirectorySuggestions,
    ...workingDirectoryHistory.filter((directory) => !groupDirectorySuggestions.includes(directory)),
  ]
  const directoryQuery = directoryHistoryFiltering ? workingDirectory.toLowerCase() : ''
  const directorySuggestions = availableDirectories.filter(
    (directory) => directoryQuery === '' || directory.toLowerCase().includes(directoryQuery),
  )
  const activeDirectoryHighlight = Math.min(
    directoryHistoryHighlight,
    Math.max(0, directorySuggestions.length - 1),
  )
  const repo = repoProbe && repoProbe.directory === workingDirectory && repoProbe.info.isRepo && repoProbe.info.mainRoot
    ? repoProbe.info
    : null
  const notRepo = Boolean(probeRepo && workingDirectory && repoProbe && repoProbe.directory === workingDirectory && !repoProbe.info.isRepo)
  const effectiveBranch = branchEdited ? branch : sanitizeBranchName(sessionName)
  const previewWorktreePath = worktreePath ?? (repo?.mainRoot ? defaultWorktreePath(repo.mainRoot, effectiveBranch || '<branch>') : '')
  const worktreeRequested = Boolean(repo && worktreeEnabled)

  useEffect(() => {
    if (!sessionCreateRequest) return
    setSessionGroupId(sessionCreateRequest.groupId)
    setSessionGroupName(sessionCreateRequest.groupName)
    setSessionRepo(sessionCreateRequest.repo ?? null)
    setGroupDirectorySuggestions(sessionCreateRequest.suggestedDirectories)
    setWorkingDirectory(sessionCreateRequest.repo?.root ?? sessionCreateRequest.suggestedDirectories[0] ?? workingDirectoryHistory[0] ?? '')
    setDirectoryHistoryFiltering(false)
    setDirectoryHistoryHighlight(0)
    setWorktreeEnabled(true)
    setBranchEdited(false)
    setWorktreePath(null)
    setError('')
    setStatus('')
  }, [sessionCreateRequest])

  useEffect(() => {
    if (!sessionCreateRequest) return
    if (detailsRef.current) {
      detailsRef.current.open = true
      detailsRef.current.scrollIntoView?.({ block: 'nearest' })
    }
    sessionNameRef.current?.focus()
  }, [sessionCreateRequest])

  useEffect(() => {
    if (!probeRepo || !workingDirectory.startsWith('/')) return
    const version = ++probeVersion.current
    const timer = window.setTimeout(() => {
      probeRepo(workingDirectory)
        .then((info) => {
          if (version === probeVersion.current) setRepoProbe({ directory: workingDirectory, info })
        })
        .catch(() => {
          if (version === probeVersion.current) setRepoProbe({ directory: workingDirectory, info: { isRepo: false } })
        })
    }, sessionCreateRequest && workingDirectory === (sessionCreateRequest.repo?.root ?? sessionCreateRequest.suggestedDirectories[0]) ? 0 : REPO_PROBE_DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [probeRepo, workingDirectory, sessionCreateRequest])

  const chooseWorkingDirectory = (directory: string) => {
    setWorkingDirectory(directory)
    setWorktreePath(null)
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

  const resetForm = (formElement: HTMLFormElement) => {
    formElement.reset()
    setSessionName('')
    setBranch('')
    setBranchEdited(false)
    setWorktreePath(null)
  }

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const formElement = event.currentTarget
    const form = new FormData(formElement)
    setPending(true)
    setError('')
    setStatus('')
    try {
      const cwd = String(form.get('cwd') ?? '')
      const request: CreateTmuxSessionRequest = {
        name: String(form.get('sessionName') ?? ''),
        windowName: String(form.get('windowName') ?? ''),
        cwd,
      }
      if (worktreeRequested) {
        request.worktree = { branch: effectiveBranch, ...(worktreePath ? { path: worktreePath } : {}) }
      }
      const result = await onCreateSession(request)
      const nextHistory = saveWorkingDirectoryHistory(cwd, workingDirectoryHistory)
      setWorkingDirectoryHistory(nextHistory)
      setDirectoryHistoryOpen(false)
      const { created, worktree } = result
      setStatus(worktree
        ? `Created session ${created.paneId} in ${created.sessionName} on branch ${worktree.branch} at ${worktree.path}${worktree.warning ? `. ${worktree.warning}` : ''}`
        : `Created session ${created.paneId} in ${created.sessionName}`)
      onCreated?.(created, sessionGroupId, worktree)
      resetForm(formElement)
    } catch (submitError) {
      setError(errorMessage(submitError))
    } finally {
      setPending(false)
    }
  }

  const destination = sessionRepo
    ? <p className="tmux-create__destination">Repository <strong>{sessionRepo.name}</strong></p>
    : sessionGroupId !== 'ungrouped'
      ? <p className="tmux-create__destination">Session group <strong>{sessionGroupName}</strong></p>
      : null

  const worktreeBlock = repo ? (
    <div className="tmux-create__worktree">
      <label className="tmux-create__toggle">
        <input
          type="checkbox"
          name="worktree"
          checked={worktreeEnabled}
          disabled={unavailable}
          onChange={(event) => setWorktreeEnabled(event.target.checked)}
        />
        Create a worktree and branch for this session
      </label>
      {worktreeEnabled ? (
        <>
          <label>
            Branch <span>from session name, editable</span>
            <input
              name="branch"
              value={effectiveBranch}
              maxLength={128}
              autoComplete="off"
              spellCheck={false}
              disabled={unavailable}
              onChange={(event) => {
                setBranchEdited(true)
                setBranch(event.target.value)
              }}
            />
          </label>
          <div className="tmux-create__worktree-preview">
            {worktreePath === null ? (
              <div>
                <b>Worktree</b>
                <code>{previewWorktreePath}</code>
                <button
                  type="button"
                  className="tmux-create__link"
                  disabled={unavailable}
                  onClick={() => setWorktreePath(previewWorktreePath)}
                  aria-label="Edit worktree path"
                >
                  edit
                </button>
              </div>
            ) : (
              <label>
                Worktree path
                <input
                  name="worktreePath"
                  value={worktreePath}
                  autoComplete="off"
                  spellCheck={false}
                  disabled={unavailable}
                  onChange={(event) => setWorktreePath(event.target.value)}
                />
              </label>
            )}
            <div>
              <b>From</b>
              <code>{repo.defaultBranch ? `${repo.remote ?? 'origin'}/${repo.defaultBranch}` : 'HEAD'}</code>
              <span>{repo.defaultBranch ? ' · fetched before branching' : ' · no remote default branch'}</span>
            </div>
          </div>
        </>
      ) : null}
    </div>
  ) : notRepo ? (
    <p className="tmux-create__message is-warning">
      Not a git repository: the session opens in this folder without a worktree.
    </p>
  ) : null

  const panel = (
    <div className="tmux-create__panel">
      <form onSubmit={submit} aria-busy={pending}>
        {destination}
        <label>
          Session name
          <input
            ref={sessionNameRef}
            name="sessionName"
            required
            maxLength={128}
            autoComplete="off"
            value={sessionName}
            onChange={(event) => setSessionName(event.target.value)}
          />
        </label>
        <label>
          Initial window name <span>optional</span>
          <input name="windowName" maxLength={128} autoComplete="off" />
        </label>

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
                setWorktreePath(null)
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

        {worktreeBlock}

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

        <button className="tmux-create__submit" type="submit" disabled={unavailable}>
          {pending ? 'Creating...' : 'Create session'}
        </button>
      </form>
    </div>
  )

  if (variant === 'dialog') {
    return <div className="tmux-create tmux-create--dialog">{panel}</div>
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
        setSessionRepo(null)
        setGroupDirectorySuggestions([])
      }}
    >
      <summary>{sessionGroupId === 'ungrouped' ? 'New session' : `New session in ${sessionGroupName}`}</summary>
      {panel}
    </details>
  )
}
