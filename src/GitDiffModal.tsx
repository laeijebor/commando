import { Columns2, FileDiff, LoaderCircle, Rows3, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { parseAnsi, type AnsiSegment } from './ansi'
import type {
  DiffDisplay,
  DiffEngine,
  GitChangedFile,
  GitDiffApiClient,
  GitDiffSummary,
} from './gitApi'

type Props = {
  paneId: string
  panePath: string
  api: GitDiffApiClient
  initialSummary: GitDiffSummary | null
  onClose(): void
}

const APPROXIMATE_CHARACTER_WIDTH = 7.25
const ENGINE_STORAGE_KEY = 'commando-diff-engine'
const DISPLAY_STORAGE_KEY = 'commando-diff-display'

function storedChoice<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const value = window.localStorage.getItem(key)
    return allowed.includes(value as T) ? (value as T) : fallback
  } catch {
    return fallback
  }
}

function storeChoice(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value)
  } catch {
    // Best-effort persistence; the in-memory choice still applies.
  }
}

function segmentClassName(segment: AnsiSegment): string | undefined {
  const classes: string[] = []
  if (typeof segment.foreground === 'number') classes.push(`ansi-fg-${segment.foreground}`)
  if (typeof segment.background === 'number') classes.push(`ansi-bg-${segment.background}`)
  if (segment.bold) classes.push('ansi-bold')
  if (segment.dim) classes.push('ansi-dim')
  if (segment.italic) classes.push('ansi-italic')
  if (segment.underline) classes.push('ansi-underline')
  return classes.length ? classes.join(' ') : undefined
}

export function AnsiText({ text }: { text: string }) {
  const segments = useMemo(() => parseAnsi(text), [text])
  return (
    <>
      {segments.map((segment, index) => (
        <span
          key={index}
          className={segmentClassName(segment)}
          style={{
            ...(typeof segment.foreground === 'string' ? { color: segment.foreground } : {}),
            ...(typeof segment.background === 'string' ? { backgroundColor: segment.background } : {}),
          }}
        >
          {segment.text}
        </span>
      ))}
    </>
  )
}

function statusLabel(file: GitChangedFile): { letter: string; className: string; title: string } {
  switch (file.status[0]) {
    case 'A': return { letter: 'A', className: 'added', title: 'Added' }
    case 'D': return { letter: 'D', className: 'deleted', title: 'Deleted' }
    case 'U': return { letter: 'U', className: 'added', title: 'Untracked' }
    case 'T': return { letter: 'T', className: 'modified', title: 'Type changed' }
    default: return { letter: 'M', className: 'modified', title: 'Modified' }
  }
}

export function GitDiffModal({ paneId, panePath, api, initialSummary, onClose }: Props) {
  const [summary, setSummary] = useState<GitDiffSummary | null>(initialSummary)
  const [summaryError, setSummaryError] = useState('')
  const [summaryLoading, setSummaryLoading] = useState(false)
  const [targetDraft, setTargetDraft] = useState(initialSummary?.target ?? '')
  const [appliedTarget, setAppliedTarget] = useState<string | undefined>(undefined)
  const [branchList, setBranchList] = useState<string[]>([])
  const [dropdownOpen, setDropdownOpen] = useState(false)
  const [filtering, setFiltering] = useState(false)
  const [highlight, setHighlight] = useState(0)
  const [selectedFile, setSelectedFile] = useState<string | null>(null)
  const [diff, setDiff] = useState('')
  const [diffError, setDiffError] = useState('')
  const [diffLoading, setDiffLoading] = useState(false)
  const [engine, setEngine] = useState<DiffEngine>(
    () => storedChoice(ENGINE_STORAGE_KEY, ['difftastic', 'delta'], 'difftastic'),
  )
  const [display, setDisplay] = useState<DiffDisplay>(
    () => storedChoice(DISPLAY_STORAGE_KEY, ['side-by-side', 'inline'], 'side-by-side'),
  )
  const apiRef = useRef(api)
  apiRef.current = api
  const outputRef = useRef<HTMLDivElement>(null)
  const generation = useRef(0)
  const diffGeneration = useRef(0)

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [onClose])

  useEffect(() => {
    let cancelled = false
    apiRef.current
      .branches(paneId)
      .then((next) => { if (!cancelled) setBranchList(next.branches ?? []) })
      .catch(() => { /* type-ahead is best-effort; free typing still works */ })
    return () => { cancelled = true }
  }, [paneId])

  useEffect(() => {
    const request = ++generation.current
    setSummaryLoading(true)
    setSummaryError('')
    apiRef.current
      .summary(paneId, appliedTarget)
      .then((next) => {
        if (request !== generation.current) return
        setSummary(next)
        setTargetDraft((draft) => draft || next.target || '')
      })
      .catch((cause: unknown) => {
        if (request !== generation.current) return
        setSummaryError(cause instanceof Error ? cause.message : 'Unable to load git summary')
      })
      .finally(() => {
        if (request === generation.current) setSummaryLoading(false)
      })
  }, [paneId, appliedTarget])

  const files = summary?.files ?? []

  useEffect(() => {
    if (selectedFile && files.some((file) => file.path === selectedFile)) return
    setSelectedFile(files[0]?.path ?? null)
  }, [files, selectedFile])

  useEffect(() => {
    if (!selectedFile) {
      setDiff('')
      setDiffError('')
      return
    }
    const request = ++diffGeneration.current
    setDiffLoading(true)
    setDiffError('')
    const measured = outputRef.current?.clientWidth
    const width = measured
      ? Math.min(400, Math.max(80, Math.floor(measured / APPROXIMATE_CHARACTER_WIDTH)))
      : 180
    apiRef.current
      .fileDiff(paneId, selectedFile, { target: appliedTarget, width, engine, display })
      .then((next) => {
        if (request !== diffGeneration.current) return
        setDiff(next.diff)
      })
      .catch((cause: unknown) => {
        if (request !== diffGeneration.current) return
        setDiff('')
        setDiffError(cause instanceof Error ? cause.message : 'Unable to load diff')
      })
      .finally(() => {
        if (request === diffGeneration.current) setDiffLoading(false)
      })
  }, [paneId, appliedTarget, selectedFile, engine, display])

  const chooseEngine = (next: DiffEngine) => {
    setEngine(next)
    storeChoice(ENGINE_STORAGE_KEY, next)
  }

  const chooseDisplay = (next: DiffDisplay) => {
    setDisplay(next)
    storeChoice(DISPLAY_STORAGE_KEY, next)
  }

  const applyTarget = (value: string) => {
    const next = value.trim()
    setAppliedTarget(next === '' ? undefined : next)
  }

  const chooseBranch = (branch: string) => {
    setTargetDraft(branch)
    applyTarget(branch)
    setDropdownOpen(false)
  }

  // Filter only while the user is editing; a fresh focus offers every branch.
  const query = filtering ? targetDraft.trim().toLowerCase() : ''
  const suggestions = branchList
    .filter((branch) => branch !== summary?.branch)
    .filter((branch) => query === '' || branch.toLowerCase().includes(query))
    .slice(0, 30)
  const activeHighlight = Math.min(highlight, Math.max(0, suggestions.length - 1))

  const onTargetKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (!dropdownOpen) {
        setDropdownOpen(true)
        return
      }
      if (!suggestions.length) return
      const step = event.key === 'ArrowDown' ? 1 : -1
      setHighlight((activeHighlight + step + suggestions.length) % suggestions.length)
    } else if (event.key === 'Enter') {
      if (dropdownOpen && suggestions[activeHighlight]) chooseBranch(suggestions[activeHighlight])
      else applyTarget(event.currentTarget.value)
      setDropdownOpen(false)
    } else if (event.key === 'Escape' && dropdownOpen) {
      event.stopPropagation()
      setDropdownOpen(false)
    }
  }

  return (
    <div className="git-diff-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <section className="git-diff-modal" role="dialog" aria-modal="true" aria-labelledby="git-diff-title">
        <header className="git-diff-header">
          <div className="git-diff-heading">
            <span><FileDiff aria-hidden="true" /> Structural diff</span>
            <strong id="git-diff-title" title={summary?.root ?? panePath}>{summary?.root ?? panePath}</strong>
          </div>
          <div className="git-diff-target">
            <span className="git-diff-branch" title="Current branch">{summary?.branch || 'HEAD'}</span>
            <span aria-hidden="true">vs</span>
            <div className="git-diff-target-combo">
              <input
                value={targetDraft}
                onChange={(event) => {
                  setTargetDraft(event.target.value)
                  setDropdownOpen(true)
                  setFiltering(true)
                  setHighlight(0)
                }}
                onKeyDown={onTargetKeyDown}
                onFocus={() => {
                  setDropdownOpen(true)
                  setFiltering(false)
                  setHighlight(0)
                }}
                onClick={() => {
                  setDropdownOpen(true)
                  setFiltering(false)
                  setHighlight(0)
                }}
                onBlur={(event) => {
                  setDropdownOpen(false)
                  applyTarget(event.currentTarget.value)
                }}
                placeholder="main"
                role="combobox"
                aria-expanded={dropdownOpen && suggestions.length > 0}
                aria-autocomplete="list"
                aria-controls="git-diff-branch-listbox"
                aria-label="Diff target branch"
                spellCheck={false}
              />
              {dropdownOpen && suggestions.length > 0 ? (
                <ul className="git-diff-branch-list" id="git-diff-branch-listbox" role="listbox" aria-label="Branches">
                  {suggestions.map((branch, index) => (
                    <li key={branch} role="option" aria-selected={branch === (appliedTarget ?? summary?.target)}>
                      <button
                        type="button"
                        tabIndex={-1}
                        className={index === activeHighlight ? 'highlighted' : undefined}
                        onMouseDown={(event) => {
                          event.preventDefault()
                          chooseBranch(branch)
                        }}
                        onMouseEnter={() => setHighlight(index)}
                      >
                        {branch}
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          </div>
          <button type="button" onClick={onClose} aria-label="Close diff view"><X /></button>
        </header>
        <div className="git-diff-toolbar">
          <div className="git-diff-segment" role="group" aria-label="Diff engine">
            <button
              type="button"
              className={engine === 'difftastic' ? 'active' : undefined}
              aria-pressed={engine === 'difftastic'}
              onClick={() => chooseEngine('difftastic')}
              title="Structural diff (difftastic)"
            >
              difftastic
            </button>
            <button
              type="button"
              className={engine === 'delta' ? 'active' : undefined}
              aria-pressed={engine === 'delta'}
              onClick={() => chooseEngine('delta')}
              title="Line diff with syntax highlighting (delta)"
            >
              delta
            </button>
          </div>
          <div className="git-diff-segment" role="group" aria-label="Diff layout">
            <button
              type="button"
              className={display === 'side-by-side' ? 'active' : undefined}
              aria-pressed={display === 'side-by-side'}
              onClick={() => chooseDisplay('side-by-side')}
              title="Two-column layout"
            >
              <Columns2 aria-hidden="true" /> side-by-side
            </button>
            <button
              type="button"
              className={display === 'inline' ? 'active' : undefined}
              aria-pressed={display === 'inline'}
              onClick={() => chooseDisplay('inline')}
              title="Single-column layout"
            >
              <Rows3 aria-hidden="true" /> inline
            </button>
          </div>
        </div>
        <div className="git-diff-body">
          <aside className="git-diff-files" aria-label="Changed files">
            {summaryLoading ? <div className="git-diff-status"><LoaderCircle className="spin" />Loading changes</div> : null}
            {!summaryLoading && summaryError ? <div className="git-diff-error" role="alert">{summaryError}</div> : null}
            {!summaryLoading && !summaryError && summary?.target === null
              ? <div className="git-diff-status">No main or master branch found. Enter a target branch above.</div>
              : null}
            {!summaryLoading && !summaryError && summary?.target !== null && files.length === 0
              ? <div className="git-diff-status">No changes vs {summary?.target ?? 'target'}</div>
              : null}
            {!summaryLoading && !summaryError ? files.map((file) => {
              const status = statusLabel(file)
              return (
                <button
                  type="button"
                  key={file.path}
                  className={`git-diff-file${file.path === selectedFile ? ' selected' : ''}`}
                  onClick={() => setSelectedFile(file.path)}
                  title={file.path}
                >
                  <span className={`git-diff-file-status ${status.className}`} title={status.title}>{status.letter}</span>
                  <span className="git-diff-file-path">{file.path}</span>
                  <span className="git-diff-file-stats">
                    {file.binary
                      ? 'bin'
                      : file.additions === null
                        ? 'new'
                        : <><em className="added">+{file.additions}</em> <em className="deleted">-{file.deletions}</em></>}
                  </span>
                </button>
              )
            }) : null}
          </aside>
          <div className="git-diff-output" ref={outputRef}>
            {diffLoading ? <div className="git-diff-status"><LoaderCircle className="spin" />Running difftastic</div> : null}
            {!diffLoading && diffError ? <div className="git-diff-error" role="alert">{diffError}</div> : null}
            {!diffLoading && !diffError && selectedFile && diff.trim() === ''
              ? <div className="git-diff-status">No content changes (permissions or identical after merge base)</div>
              : null}
            {!diffLoading && !diffError && diff.trim() !== ''
              ? <pre><AnsiText text={diff} /></pre>
              : null}
          </div>
        </div>
      </section>
    </div>
  )
}
